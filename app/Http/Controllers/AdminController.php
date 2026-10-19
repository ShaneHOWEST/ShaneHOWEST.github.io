<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use App\Services\NewsSyncService;

class AdminController extends Controller
{
    private function staff(Request $request): object
    {
        $id = $request->session()->get('user_id');
        $user = $id ? DB::table('users')->where('id', $id)->first() : null;
        abort_unless($user && $user->role === 'staff', 403);
        return $user;
    }

    public function config(Request $request): JsonResponse
    {
        $this->staff($request);
        $keys = ['stripe_secret_key','stripe_price_id','stripe_webhook_secret','smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from'];
        $integrations = DB::table('app_settings')->whereIn('key', $keys)->pluck('value', 'key')->map(fn ($value, $key) => in_array($key, ['stripe_secret_key','stripe_webhook_secret','smtp_password'], true) ? '••••••••' : $value)->toArray();
        $integrations += ['smtp_port' => '587', 'smtp_secure' => 'false'];

        return response()->json([
            'sources' => DB::table('sources')->orderBy('created_at')->get(['id', 'name', 'url', 'type', 'enabled']),
            'providers' => DB::table('providers')->orderBy('priority')->get(['id', 'name', 'type', 'url', 'model', 'enabled', 'priority'])->map(fn ($provider) => (array) $provider + ['apiKey' => '••••••••']),
            'integrations' => $integrations,
        ]);
    }

    public function addUser(Request $request): JsonResponse
    {
        $this->staff($request);
        $data = $request->validate(['email' => ['required', 'email'], 'password' => ['required', 'string', 'min:10']]);
        $email = strtolower(trim($data['email']));
        if (DB::table('users')->where('email', $email)->exists()) return response()->json(['error' => 'Dit e-mailadres is al in gebruik.'], 409);
        $id = DB::table('users')->insertGetId(['email' => $email, 'password_hash' => \Illuminate\Support\Facades\Hash::make($data['password']), 'role' => 'member', 'email_verified_at' => now(), 'created_at' => now()]);
        return response()->json(['id' => $id, 'email' => $email, 'role' => 'member', 'created_at' => now()], 201);
    }

    public function addSource(Request $request): JsonResponse
    {
        $this->staff($request);
        $data = $request->validate(['name' => ['required', 'string', 'max:120'], 'url' => ['required', 'url'], 'type' => ['nullable', 'in:rss,website']]);
        $id = (string) Str::uuid();
        DB::table('sources')->insert(['id' => $id, 'name' => $data['name'], 'url' => $data['url'], 'type' => $data['type'] ?? 'rss', 'enabled' => 1]);
        return response()->json(['id' => $id, ...$data], 201);
    }

    public function deleteSource(Request $request, string $id): JsonResponse
    {
        $this->staff($request);
        DB::table('sources')->where('id', $id)->delete();
        return response()->json(['ok' => true]);
    }

    public function deleteProvider(Request $request, string $id): JsonResponse
    {
        $this->staff($request);
        DB::table('providers')->where('id', $id)->delete();
        return response()->json(['ok' => true]);
    }

    public function integrations(Request $request): JsonResponse
    {
        $this->staff($request);
        foreach (['stripe_secret_key','stripe_price_id','stripe_webhook_secret','smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from'] as $key) {
            if ($request->filled($key) && ! str_starts_with((string) $request->input($key), '••')) {
                DB::table('app_settings')->updateOrInsert(['key' => $key], ['value' => (string) $request->input($key), 'updated_at' => now()]);
            }
        }
        return response()->json(['ok' => true]);
    }

    public function sync(Request $request, NewsSyncService $sync): JsonResponse
    {
        $this->staff($request);
        return response()->json($sync->run());
    }

    public function addProvider(Request $request): JsonResponse
    {
        $this->staff($request);
        $type = (string) $request->input('type');
        $defaults = [
            'openai' => ['url' => 'https://api.openai.com/v1/chat/completions', 'model' => 'gpt-4o-mini'],
            'anthropic' => ['url' => 'https://api.anthropic.com/v1/messages', 'model' => 'claude-3-5-haiku-latest'],
            'gemini' => ['url' => 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', 'model' => 'gemini-1.5-flash'],
        ];
        $url = trim((string) $request->input('url', ''));
        if ($url && ! preg_match('/^https?:\\/\\//i', $url)) $url = 'https://'.$url;
        $payload = [
            'name' => trim((string) $request->input('name')),
            'type' => $type,
            'url' => $url ?: ($defaults[$type]['url'] ?? ''),
            'model' => trim((string) $request->input('model', '')) ?: ($defaults[$type]['model'] ?? ''),
            'apiKey' => trim((string) $request->input('apiKey')),
        ];
        $validationPayload = $payload;
        $validationPayload['url'] = str_replace('{model}', 'gemini-model', $validationPayload['url']);
        $validator = validator($validationPayload, [
            'name' => ['required', 'string', 'max:120'],
            'type' => ['required', 'in:openai,anthropic,gemini,custom'],
            'url' => ['required', 'url'],
            'model' => ['required', 'string', 'max:160'],
            'apiKey' => ['required', 'string'],
        ], [
            'url.url' => 'Vul een volledige endpoint-URL in, bijvoorbeeld https://api.openai.com/v1/chat/completions.',
            'apiKey.required' => 'Vul een API-key in.',
        ]);
        if ($validator->fails()) return response()->json(['error' => 'Controleer de providergegevens.', 'errors' => $validator->errors()], 422);
        $data = $payload;
        $id = (string) Str::uuid();
        DB::table('providers')->insert(['id' => $id, 'name' => $data['name'], 'type' => $data['type'], 'url' => $data['url'], 'model' => $data['model'], 'api_key' => $data['apiKey'], 'enabled' => 1, 'priority' => 1]);
        return response()->json(['id' => $id, 'name' => $data['name'], 'type' => $data['type'], 'url' => $data['url'], 'model' => $data['model'], 'enabled' => true, 'priority' => 1, 'apiKey' => '••••••••'], 201);
    }

    public function users(Request $request): JsonResponse
    {
        $this->staff($request);
        $users = DB::table('users')
            ->leftJoin('subscriptions', function ($join) {
                $join->on('subscriptions.user_id', '=', 'users.id')
                    ->where('subscriptions.plan', '=', 'admin')
                    ->where('subscriptions.status', '=', 'active');
            })
            ->orderBy('users.created_at')
            ->get(['users.id', 'users.email', 'users.role', 'users.created_at', 'subscriptions.id as admin_subscription_id', 'subscriptions.current_period_end as admin_subscription_end']);
        return response()->json(['users' => $users]);
    }

    public function assignSubscription(Request $request, int $id): JsonResponse
    {
        $this->staff($request);
        abort_unless(DB::table('users')->where('id', $id)->exists(), 404, 'Gebruiker niet gevonden.');
        $endsAt = now()->addMonths(3)->endOfDay();
        $subscription = DB::table('subscriptions')->where('user_id', $id)->where('plan', 'admin')->first();
        $values = ['status' => 'active', 'plan' => 'admin', 'current_period_end' => $endsAt];
        if ($subscription) DB::table('subscriptions')->where('id', $subscription->id)->update($values);
        else DB::table('subscriptions')->insert(['id' => (string) Str::uuid(), 'user_id' => $id, ...$values, 'created_at' => now()]);
        return response()->json(['ok' => true]);
    }

    public function revokeSubscription(Request $request, int $id): JsonResponse
    {
        $this->staff($request);
        DB::table('subscriptions')->where('user_id', $id)->where('plan', 'admin')->update(['status' => 'canceled']);
        return response()->json(['ok' => true]);
    }

    public function deleteUser(Request $request, int $id): JsonResponse
    {
        $current = $this->staff($request);
        abort_if((int) $current->id === $id, 400, 'Je kunt je eigen gebruiker niet verwijderen.');
        DB::table('users')->where('id', $id)->delete();
        return response()->json(['ok' => true]);
    }
}
