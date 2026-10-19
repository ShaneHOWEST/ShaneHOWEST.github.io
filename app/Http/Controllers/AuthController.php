<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\Mail;
use App\Services\MailSettingsService;

class AuthController extends Controller
{
    public function me(Request $request): JsonResponse
    {
        $user = $this->user($request);
        if (! $user) return response()->json(['error' => 'Authenticatie vereist.'], 401);
        return response()->json(['id' => $user->id, 'email' => $user->email, 'role' => $user->role, 'subscribed' => $this->subscribed($user->id)]);
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => ['required', 'email'], 'password' => ['required', 'string']]);
        $user = DB::table('users')->where('email', strtolower(trim($data['email'])))->first();
        if (! $user || ! Hash::check($data['password'], $user->password_hash)) {
            return response()->json(['error' => 'E-mailadres of wachtwoord is onjuist.'], 401);
        }
        if (! $user->email_verified_at) return response()->json(['error' => 'Bevestig eerst je e-mailadres.'], 403);
        $request->session()->regenerate();
        $request->session()->put('user_id', $user->id);
        return $this->me($request);
    }

    public function logout(Request $request): JsonResponse
    {
        $request->session()->forget('user_id');
        return response()->json(['ok' => true]);
    }

    public function signup(Request $request, MailSettingsService $mailSettings): JsonResponse
    {
        $data = $request->validate(['email' => ['required', 'email'], 'password' => ['required', 'string', 'min:10']]);
        $email = strtolower(trim($data['email']));
        if (DB::table('users')->where('email', $email)->exists()) return response()->json(['error' => 'Dit e-mailadres is al in gebruik.'], 409);
        $id = DB::table('users')->insertGetId(['email' => $email, 'password_hash' => Hash::make($data['password']), 'role' => 'member', 'created_at' => now()]);
        $token = bin2hex(random_bytes(32));
        DB::table('email_verification_tokens')->insert(['token_hash' => hash('sha256', $token), 'user_id' => $id, 'expires_at' => now()->addDay()->timestamp]);
        $mailSettings->apply();
        Mail::raw("Bevestig je NieuwsFlits-account via: ".url('/?verify='.urlencode($token)), fn ($mail) => $mail->to($email)->subject('Bevestig je NieuwsFlits-account'));
        $invite = DB::table('subscription_shares')->where('email', $email)->where('status', 'pending')->first();
        if ($invite) {
            $ownerSubscription = DB::table('subscriptions')->where('user_id', $invite->owner_user_id)->where('plan', '!=', 'shared')->whereIn('status', ['active', 'trialing'])->where(fn ($q) => $q->whereNull('current_period_end')->orWhere('current_period_end', '>', now()))->orderByDesc('created_at')->first();
            if ($ownerSubscription) {
                DB::table('subscription_shares')->where('id', $invite->id)->update(['invited_user_id' => $id, 'status' => 'accepted']);
                DB::table('subscriptions')->insert(['id' => (string) Str::uuid(), 'user_id' => $id, 'status' => 'active', 'plan' => 'shared', 'current_period_end' => $ownerSubscription->current_period_end, 'source_share_id' => $invite->id, 'created_at' => now()]);
            }
        }
        return response()->json(['id' => $id, 'email' => $email, 'verificationRequired' => true], 201);
    }

    public function verify(Request $request): JsonResponse
    {
        $token = (string) $request->input('token');
        $record = DB::table('email_verification_tokens')->where('token_hash', hash('sha256', $token))->where('expires_at', '>', now()->timestamp)->first();
        if (! $record) return response()->json(['error' => 'Deze verificatielink is ongeldig of verlopen.'], 400);
        DB::table('users')->where('id', $record->user_id)->update(['email_verified_at' => now()]);
        DB::table('email_verification_tokens')->where('user_id', $record->user_id)->delete();
        $request->session()->put('user_id', $record->user_id);
        return $this->me($request);
    }

    public function resend(Request $request, MailSettingsService $mailSettings): JsonResponse
    {
        $email = strtolower(trim((string) $request->input('email')));
        $user = DB::table('users')->where('email', $email)->first();
        if ($user && ! $user->email_verified_at) {
            $token = bin2hex(random_bytes(32));
            DB::table('email_verification_tokens')->where('user_id', $user->id)->delete();
            DB::table('email_verification_tokens')->insert(['token_hash' => hash('sha256', $token), 'user_id' => $user->id, 'expires_at' => now()->addDay()->timestamp]);
            $mailSettings->apply();
            Mail::raw("Bevestig je NieuwsFlits-account via: ".url('/?verify='.urlencode($token)), fn ($mail) => $mail->to($email)->subject('Bevestig je NieuwsFlits-account'));
        }
        return response()->json(['ok' => true]);
    }

    private function user(Request $request): ?object
    {
        $id = $request->session()->get('user_id');
        return $id ? DB::table('users')->where('id', $id)->first() : null;
    }

    private function subscribed(int $id): bool
    {
        $latest = DB::table('subscriptions')->where('user_id', $id)->where('plan', '!=', 'shared')->orderByDesc('created_at')->first();
        if ($latest) return in_array($latest->status, ['active', 'trialing'], true)
            && (! $latest->current_period_end || $latest->current_period_end > now());
        $shared = DB::table('subscriptions')->where('user_id', $id)->where('plan', 'shared')->orderByDesc('created_at')->first();
        if (! $shared || ! in_array($shared->status, ['active', 'trialing'], true) || ($shared->current_period_end && $shared->current_period_end <= now())) return false;
        $ownerId = DB::table('subscription_shares')->where('id', $shared->source_share_id)->value('owner_user_id');
        $owner = $ownerId ? DB::table('subscriptions')->where('user_id', $ownerId)->where('plan', '!=', 'shared')->orderByDesc('created_at')->first() : null;
        return $owner && in_array($owner->status, ['active', 'trialing'], true)
            && (! $owner->current_period_end || $owner->current_period_end > now());
    }
}
