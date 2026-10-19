<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class BillingController extends Controller
{
    public function checkout(Request $request): JsonResponse
    {
        $user = $this->user($request);
        abort_unless($user, 401);
        $secret = $this->setting('stripe_secret_key');
        $price = $this->setting('stripe_price_id');
        if (! $secret || ! $price) return response()->json(['error' => 'Stripe is nog niet geconfigureerd.'], 503);

        $base = rtrim((string) config('app.url'), '/');
        $response = Http::asForm()->withBasicAuth($secret, '')->timeout(20)->post('https://api.stripe.com/v1/checkout/sessions', [
            'mode' => 'subscription',
            'customer_email' => $user->email,
            'client_reference_id' => (string) $user->id,
            'line_items[0][price]' => $price,
            'line_items[0][quantity]' => 1,
            'success_url' => $base.'/?subscription=success',
            'cancel_url' => $base.'/?subscription=cancelled',
            'metadata[userId]' => (string) $user->id,
        ]);
        if (! $response->successful() || ! $response->json('url')) {
            report(new \RuntimeException('Stripe Checkout kon niet worden aangemaakt: '.$response->body()));
            return response()->json(['error' => 'Stripe kon geen betaalpagina aanmaken.'], 502);
        }
        return response()->json(['url' => $response->json('url')]);
    }

    public function webhook(Request $request)
    {
        $secret = $this->setting('stripe_webhook_secret');
        if (! $secret) return response('Stripe is niet geconfigureerd.', 503);
        $signature = (string) $request->header('Stripe-Signature');
        if (! $this->validSignature($request->getContent(), $signature, $secret)) return response('Ongeldige Stripe-signature.', 400);

        $event = json_decode($request->getContent(), true);
        $type = $event['type'] ?? '';
        $object = $event['data']['object'] ?? [];
        if (in_array($type, ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated'], true)) {
            $userId = $object['metadata']['userId'] ?? $object['client_reference_id'] ?? null;
            $subscriptionId = $object['subscription'] ?? ($object['id'] ?? null);
            if ($type !== 'checkout.session.completed' && ! $userId && $subscriptionId) {
                $userId = DB::table('subscriptions')->where('stripe_subscription_id', $subscriptionId)->value('user_id');
            }
            if ($userId && $subscriptionId) $this->saveSubscription((int) $userId, $subscriptionId, $type === 'checkout.session.completed' ? 'active' : ($object['status'] ?? 'active'), $object['current_period_end'] ?? null);
        }
        if ($type === 'invoice.payment_failed') {
            $subscriptionId = $object['subscription'] ?? null;
            if ($subscriptionId) $this->syncSubscriptionStatus($subscriptionId, 'past_due');
        }
        if ($type === 'invoice.paid') {
            $subscriptionId = $object['subscription'] ?? null;
            if ($subscriptionId) {
                $currentStatus = DB::table('subscriptions')->where('stripe_subscription_id', $subscriptionId)->value('status');
                if (in_array($currentStatus, ['past_due', 'unpaid'], true)) {
                    $this->syncSubscriptionStatus($subscriptionId, 'active');
                }
            }
        }
        if ($type === 'customer.subscription.deleted') {
            $subscriptionId = $object['id'] ?? null;
            if ($subscriptionId) {
                $owner = DB::table('subscriptions')->where('stripe_subscription_id', $subscriptionId)->value('user_id');
                $this->syncSubscriptionStatus($subscriptionId, 'canceled');
                if ($owner) {
                    DB::table('subscription_shares')->where('owner_user_id', $owner)->whereIn('status', ['pending', 'accepted'])->update(['status' => 'revoked']);
                    DB::table('subscriptions')->whereIn('source_share_id', DB::table('subscription_shares')->select('id')->where('owner_user_id', $owner))->where('plan', 'shared')->update(['status' => 'canceled']);
                }
            }
        }
        return response()->json(['received' => true]);
    }

    private function saveSubscription(int $userId, string $subscriptionId, string $status, ?int $periodEnd): void
    {
        DB::table('subscriptions')->updateOrInsert(
            ['stripe_subscription_id' => $subscriptionId],
            ['id' => (string) Str::uuid(), 'user_id' => $userId, 'status' => $status, 'plan' => 'quarterly', 'current_period_end' => $periodEnd ? now()->setTimestamp($periodEnd) : null, 'created_at' => now()]
        );
        DB::table('subscriptions')->whereIn('source_share_id', DB::table('subscription_shares')->select('id')->where('owner_user_id', $userId)->where('status', 'accepted'))->where('plan', 'shared')->update(['status' => $status, 'current_period_end' => $periodEnd ? now()->setTimestamp($periodEnd) : null]);
    }

    private function syncSubscriptionStatus(string $subscriptionId, string $status): void
    {
        $ownerId = DB::table('subscriptions')->where('stripe_subscription_id', $subscriptionId)->value('user_id');
        if (! $ownerId) return;

        DB::table('subscriptions')->where('stripe_subscription_id', $subscriptionId)->update(['status' => $status]);
        DB::table('subscriptions')->where('user_id', $ownerId)->where('plan', '!=', 'shared')->where('stripe_subscription_id', '!=', $subscriptionId)->update(['status' => $status]);
        DB::table('subscriptions')
            ->whereIn('source_share_id', DB::table('subscription_shares')->select('id')->where('owner_user_id', $ownerId)->where('status', 'accepted'))
            ->where('plan', 'shared')
            ->update(['status' => $status]);
    }

    private function validSignature(string $payload, string $header, string $secret): bool
    {
        $parts = collect(explode(',', $header))->mapWithKeys(fn ($part) => array_pad(explode('=', $part, 2), 2, null))->all();
        $timestamp = (int) ($parts['t'] ?? 0);
        $signature = (string) ($parts['v1'] ?? '');
        return $timestamp > 0 && abs(time() - $timestamp) <= 300 && hash_equals(hash_hmac('sha256', $timestamp.'.'.$payload, $secret), $signature);
    }

    private function user(Request $request): ?object
    {
        $id = $request->session()->get('user_id');
        return $id ? DB::table('users')->where('id', $id)->first() : null;
    }

    private function setting(string $key): ?string
    {
        return DB::table('app_settings')->where('key', $key)->value('value');
    }
}
