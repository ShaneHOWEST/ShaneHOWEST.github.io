<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use App\Services\MailSettingsService;
use Illuminate\Support\Str;

class AccountController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        $user = $this->user($request); abort_unless($user, 401);
        return response()->json(['user' => $user, 'subscription' => DB::table('subscriptions')->where('user_id', $user->id)->orderByDesc('created_at')->first(), 'shares' => DB::table('subscription_shares')->where('owner_user_id', $user->id)->orderBy('created_at')->get(), 'subscribed' => $this->subscribed($user->id)]);
    }

    public function update(Request $request, MailSettingsService $mailSettings): JsonResponse
    {
        $user = $this->user($request); abort_unless($user, 401);
        $data = $request->validate([
            'email' => ['nullable', 'email'],
            'current_password' => ['required_with:new_password', 'string'],
            'new_password' => ['nullable', 'string', 'min:10', 'confirmed'],
        ]);
        $changes = [];
        if (! empty($data['email']) && strtolower($data['email']) !== strtolower($user->email)) {
            if (DB::table('users')->where('email', strtolower($data['email']))->where('id', '!=', $user->id)->exists()) {
                return response()->json(['error' => 'Dit e-mailadres is al in gebruik.'], 409);
            }
            $changes['email'] = strtolower($data['email']);
            $changes['email_verified_at'] = null;
        }
        if (! empty($data['new_password'])) {
            if (! Hash::check($data['current_password'], $user->password_hash)) return response()->json(['error' => 'Je huidige wachtwoord is onjuist.'], 422);
            $changes['password_hash'] = Hash::make($data['new_password']);
        }
        if ($changes) DB::table('users')->where('id', $user->id)->update($changes);
        if (array_key_exists('email_verified_at', $changes)) {
            $token = bin2hex(random_bytes(32));
            DB::table('email_verification_tokens')->where('user_id', $user->id)->delete();
            DB::table('email_verification_tokens')->insert(['token_hash' => hash('sha256', $token), 'user_id' => $user->id, 'expires_at' => now()->addDay()->timestamp]);
            $mailSettings->apply();
            Mail::raw('Bevestig je nieuwe e-mailadres via: '.url('/?verify='.urlencode($token)), fn ($mail) => $mail->to($changes['email'])->subject('Bevestig je nieuwe e-mailadres'));
        }
        return response()->json(['ok' => true, 'email' => $changes['email'] ?? $user->email, 'verificationRequired' => array_key_exists('email_verified_at', $changes)]);
    }

    public function share(Request $request, MailSettingsService $mailSettings): JsonResponse
    {
        $user = $this->user($request); abort_unless($user, 401);
        $ownerSubscription = DB::table('subscriptions')->where('user_id', $user->id)->where('plan', '!=', 'shared')->whereIn('status', ['active', 'trialing'])->where(fn ($q) => $q->whereNull('current_period_end')->orWhere('current_period_end', '>', now()))->orderByDesc('created_at')->first();
        abort_unless($ownerSubscription, 403, 'Alleen een eigen actief abonnement kan worden gedeeld.');
        $data = $request->validate(['email' => ['required', 'email']]);
        $email = strtolower($data['email']);
        if ($email === strtolower($user->email)) return response()->json(['error' => 'Je kunt jezelf niet uitnodigen.'], 400);
        if (DB::table('subscription_shares')->where('owner_user_id', $user->id)->whereIn('status', ['pending', 'accepted'])->count() >= 5) return response()->json(['error' => 'Je kunt maximaal vijf actieve uitnodigingen hebben.'], 400);
        $id = (string) Str::uuid();
        DB::table('subscription_shares')->insert(['id' => $id, 'owner_user_id' => $user->id, 'email' => $email, 'status' => 'pending']);
        $mailSettings->apply();
        Mail::raw('Je bent uitgenodigd voor NieuwsFlits. Maak een account aan met dit e-mailadres om de gedeelde toegang te activeren.', fn ($mail) => $mail->to($email)->subject('NieuwsFlits-abonnement gedeeld'));
        return response()->json(['id' => $id, 'email' => $email, 'status' => 'pending'], 201);
    }

    public function revokeShare(Request $request, string $id): JsonResponse
    {
        $user = $this->user($request); abort_unless($user, 401);
        DB::table('subscription_shares')->where('id', $id)->where('owner_user_id', $user->id)->update(['status' => 'revoked']);
        DB::table('subscriptions')->where('source_share_id', $id)->update(['status' => 'canceled']);
        return response()->json(['ok' => true]);
    }

    public function apiKeys(Request $request): JsonResponse
    {
        $user = $this->user($request);
        abort_unless($user, 401);
        return response()->json(['keys' => DB::table('api_keys')->where('user_id', $user->id)->orderBy('created_at')->get(['id', 'name', 'key_prefix', 'created_at', 'last_used_at'])]);
    }

    public function createApiKey(Request $request): JsonResponse
    {
        $user = $this->user($request);
        abort_unless($user, 401);
        abort_unless($this->subscribed($user->id) || $user->role === 'staff', 402);
        $plain = 'nai_'.bin2hex(random_bytes(24));
        $id = (string) Str::uuid();
        DB::table('api_keys')->insert(['id' => $id, 'user_id' => $user->id, 'name' => trim((string) $request->input('name', 'NieuwsFlits API-key')) ?: 'NieuwsFlits API-key', 'key_hash' => hash('sha256', $plain), 'key_prefix' => substr($plain, 0, 12)]);
        return response()->json(['id' => $id, 'key' => $plain], 201);
    }

    public function deleteApiKey(Request $request, string $id): JsonResponse
    {
        $user = $this->user($request);
        abort_unless($user, 401);
        DB::table('api_keys')->where('id', $id)->where('user_id', $user->id)->delete();
        return response()->json(['ok' => true]);
    }

    public function rss(Request $request)
    {
        $plain = preg_replace('/^Bearer\s+/i', '', (string) $request->header('Authorization'));
        $key = DB::table('api_keys')->where('key_hash', hash('sha256', $plain))->first();
        abort_unless($key, 401);
        $user = DB::table('users')->where('id', $key->user_id)->first();
        abort_unless($user && ($user->role === 'staff' || $this->subscribed($user->id)), 401);
        DB::table('api_keys')->where('id', $key->id)->update(['last_used_at' => now()]);
        $items = DB::table('articles')->orderByDesc('timestamp')->limit(100)->get()->map(fn ($article) => '<item><title><![CDATA['.$article->title.']]></title><link>'.e($article->url).'</link><description><![CDATA['.$article->body.']]></description></item>')->implode('');
        return response('<?xml version="1.0"?><rss version="2.0"><channel><title>NieuwsFlits</title>'.$items.'</channel></rss>', 200, ['Content-Type' => 'application/rss+xml']);
    }

    private function user(Request $request): ?object { $id = $request->session()->get('user_id'); return $id ? DB::table('users')->where('id', $id)->first() : null; }
    private function subscribed(int $id): bool
    {
        $latest = DB::table('subscriptions')->where('user_id', $id)->where('plan', '!=', 'shared')->orderByDesc('created_at')->first();
        if ($latest) return in_array($latest->status, ['active', 'trialing'], true) && (! $latest->current_period_end || $latest->current_period_end > now());
        $shared = DB::table('subscriptions')->where('user_id', $id)->where('plan', 'shared')->orderByDesc('created_at')->first();
        if (! $shared || ! in_array($shared->status, ['active', 'trialing'], true) || ($shared->current_period_end && $shared->current_period_end <= now())) return false;
        $ownerId = DB::table('subscription_shares')->where('id', $shared->source_share_id)->value('owner_user_id');
        $owner = $ownerId ? DB::table('subscriptions')->where('user_id', $ownerId)->where('plan', '!=', 'shared')->orderByDesc('created_at')->first() : null;
        return $owner && in_array($owner->status, ['active', 'trialing'], true)
            && (! $owner->current_period_end || $owner->current_period_end > now());
    }
}
