<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class NewsSyncService
{
    public function run(): array
    {
        $stats = ['discovered' => 0, 'duplicates' => 0, 'missingText' => 0, 'providerFailures' => 0, 'sourceFailures' => 0];
        foreach (DB::table('sources')->where('enabled', 1)->get() as $source) {
            try {
                $items = $source->type === 'website' ? $this->websiteItems($source->url) : $this->rssItems($source->url);
                foreach (array_slice($items, 0, 5) as $item) {
                    $stats['discovered']++;
                    $url = $item['url'];
                    $body = $this->extract($url);
                    if (strlen($body) < 300) { $stats['missingText']++; continue; }
                    $article = $this->rewrite($item['title'], $body, $source->name);
                    if (! $article) { $stats['providerFailures']++; continue; }
                    if (DB::table('articles')->where('url', $url)->exists()) { $stats['duplicates']++; continue; }
                    DB::table('articles')->insert(['id' => (string) Str::uuid(), 'title' => $article['title'] ?? $item['title'], 'excerpt' => $article['summary'] ?? '', 'body' => $article['body'], 'category' => $article['category'] ?? 'Nieuws', 'source' => $source->name, 'url' => $url, 'provider' => $article['_provider'], 'timestamp' => now(), 'is_premium' => 1]);
                }
            } catch (\Throwable $e) { $stats['sourceFailures']++; report($e); }
        }
        return $stats;
    }

    private function rssItems(string $url): array
    {
        $xml = Http::timeout(15)->get($url)->throw()->body();
        $feed = @simplexml_load_string($xml);
        return $feed ? collect($feed->channel->item ?? [])->map(fn ($i) => ['title' => (string) $i->title, 'url' => (string) ($i->link ?: $i->guid)])->all() : [];
    }

    private function websiteItems(string $url): array
    {
        $html = Http::timeout(15)->get($url)->throw()->body();
        preg_match_all('/<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)<\/a>/is', $html, $matches, PREG_SET_ORDER);
        $base = parse_url($url);
        $items = [];
        foreach ($matches as $match) {
            $title = trim(strip_tags(html_entity_decode($match[2])));
            $link = (string) $match[1];
            if (strlen($title) < 25) continue;
            if (! str_starts_with($link, 'http')) $link = ($base['scheme'] ?? 'https').'://'.$base['host'].'/'.ltrim($link, '/');
            if (parse_url($link, PHP_URL_HOST) !== ($base['host'] ?? null)) continue;
            if (! collect($items)->contains('url', $link)) $items[] = ['title' => $title, 'url' => $link];
        }
        return array_slice($items, 0, 8);
    }

    private function extract(string $url): string
    {
        $html = Http::timeout(15)->get($url)->body();
        $html = preg_replace('/<(script|style|nav|header|footer|aside|form|svg)\b[^>]*>.*?<\/\1>/is', ' ', $html);
        preg_match_all('/<(p|h[1-6]|blockquote|li)\b[^>]*>(.*?)<\/\1>/is', $html, $matches);
        $paragraphs = array_filter(array_map(fn ($x) => trim(preg_replace('/\s+/', ' ', strip_tags(html_entity_decode($x)))), $matches[2] ?? []), fn ($x) => strlen($x) >= 35);
        return implode("\n\n", $paragraphs);
    }

    private function rewrite(string $title, string $body, string $source): ?array
    {
        foreach (DB::table('providers')->where('enabled', 1)->orderBy('priority')->get() as $provider) {
            try {
                $system = 'Je bent een zorgvuldige Nederlandstalige nieuwsredacteur. Geef uitsluitend JSON met title, summary, body en category.';
                $prompt = "Herschrijf het volledige artikel, behoud feiten en maak meerdere alinea's.\nTitel: $title\nBron: $source\n$body";
                if ($provider->type === 'gemini') {
                    $endpoint = str_replace('{model}', rawurlencode($provider->model), $provider->url);
                    $response = Http::timeout(30)
                        ->post($endpoint.(str_contains($endpoint, '?') ? '&' : '?').'key='.rawurlencode($provider->api_key), [
                            'systemInstruction' => ['parts' => [['text' => $system]]],
                            'contents' => [['role' => 'user', 'parts' => [['text' => $prompt]]]],
                            'generationConfig' => ['responseMimeType' => 'application/json', 'maxOutputTokens' => 3000],
                        ]);
                    $response->throw();
                    $payload = $response->json();
                    $text = collect(data_get($payload, 'candidates.0.content.parts', []))->pluck('text')->implode('');
                } elseif ($provider->type === 'anthropic') {
                    $response = Http::withHeaders([
                        'x-api-key' => $provider->api_key,
                        'anthropic-version' => '2023-06-01',
                        'content-type' => 'application/json',
                    ])->timeout(30)->post($provider->url, [
                        'model' => $provider->model,
                        'system' => $system,
                        'messages' => [['role' => 'user', 'content' => $prompt]],
                        'max_tokens' => 3000,
                    ]);
                    $response->throw();
                    $payload = $response->json();
                    $text = collect(data_get($payload, 'content', []))->pluck('text')->implode('');
                } else {
                    $response = Http::withToken($provider->api_key)->timeout(30)->post($provider->url, [
                        'model' => $provider->model,
                        'messages' => [['role' => 'system', 'content' => $system], ['role' => 'user', 'content' => $prompt]],
                        'max_tokens' => 3000,
                    ]);
                    $response->throw();
                    $payload = $response->json();
                    $text = data_get($payload, 'choices.0.message.content');
                }
                $json = preg_replace('/^\s*```(?:json)?\s*|\s*```\s*$/i', '', trim((string) $text));
                $article = json_decode($json, true);
                if (! empty($article['body']) && strlen($article['body']) >= 300) { $article['_provider'] = $provider->name; return $article; }
                report(new \RuntimeException("AI-provider {$provider->name} returned invalid article JSON."));
            } catch (\Throwable $e) {
                report(new \RuntimeException("AI-provider {$provider->name} failed: ".$e->getMessage(), (int) $e->getCode(), $e));
            }
        }
        return null;
    }
}
