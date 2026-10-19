<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class NewsController extends Controller
{
    public function articles(Request $request): JsonResponse
    {
        $sessionUserId = $request->session()->get('user_id');
        $user = $sessionUserId ? DB::table('users')->where('id', $sessionUserId)->first() : null;
        $articles = DB::table('articles')->orderByDesc('timestamp')->limit(100)->get();

        return response()->json($articles->map(function ($article) use ($user) {
            $body = (string) $article->body;
            $allowed = $user && ($user->role === 'staff' || $this->hasActiveSubscription($user->id));
            $isPremium = (int) $article->is_premium === 1;
            $locked = $isPremium && ! $allowed;
            $previewLength = max(1, (int) ceil(strlen($body) * 0.4));

            return array_merge((array) $article, [
                'body' => $locked ? substr($body, 0, $previewLength).'…' : $body,
                'is_premium' => $isPremium,
                'locked' => $locked,
                'previewPercent' => $locked ? 40 : 100,
            ]);
        }))->header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }

    public function stats(): JsonResponse
    {
        return response()->json([
            'totalArticles' => DB::table('articles')->count(),
            'newArticlesToday' => DB::table('articles')->whereDate('timestamp', now()->toDateString())->count(),
            'readersToday' => DB::table('daily_visitors')->where('visit_date', now()->toDateString())->count(),
        ]);
    }

    private function hasActiveSubscription(int $userId): bool
    {
        $latest = DB::table('subscriptions')->where('user_id', $userId)->where('plan', '!=', 'shared')->orderByDesc('created_at')->first();
        if ($latest) {
            return in_array($latest->status, ['active', 'trialing'], true)
                && (! $latest->current_period_end || $latest->current_period_end > now());
        }

        $shared = DB::table('subscriptions')->where('user_id', $userId)->where('plan', 'shared')->orderByDesc('created_at')->first();
        if (! $shared || ! in_array($shared->status, ['active', 'trialing'], true) || ($shared->current_period_end && $shared->current_period_end <= now())) return false;
        $ownerId = DB::table('subscription_shares')->where('id', $shared->source_share_id)->value('owner_user_id');
        if (! $ownerId) return false;
        $owner = DB::table('subscriptions')->where('user_id', $ownerId)->where('plan', '!=', 'shared')->orderByDesc('created_at')->first();
        return $owner && in_array($owner->status, ['active', 'trialing'], true)
            && (! $owner->current_period_end || $owner->current_period_end > now());
    }
}
