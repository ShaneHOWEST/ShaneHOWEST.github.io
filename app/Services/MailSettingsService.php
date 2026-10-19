<?php

namespace App\Services;

use Illuminate\Support\Facades\Config;
use Illuminate\Support\Facades\DB;

class MailSettingsService
{
    public function apply(): void
    {
        $settings = DB::table('app_settings')
            ->whereIn('key', ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_secure', 'smtp_from'])
            ->pluck('value', 'key');

        if (! empty($settings->get('smtp_host'))) {
            Config::set('mail.default', 'smtp');
            Config::set('mail.mailers.smtp.host', $settings->get('smtp_host'));
            Config::set('mail.mailers.smtp.port', (int) ($settings->get('smtp_port') ?: 587));
            Config::set('mail.mailers.smtp.username', $settings->get('smtp_user') ?: null);
            Config::set('mail.mailers.smtp.password', $settings->get('smtp_password') ?: null);
            Config::set('mail.mailers.smtp.scheme', filter_var($settings->get('smtp_secure', false), FILTER_VALIDATE_BOOLEAN) ? 'smtps' : 'smtp');
        }

        $from = $settings->get('smtp_from')
            ?: $settings->get('smtp_user')
            ?: config('mail.mailers.smtp.username')
            ?: config('mail.from.address');
        if (! empty($from) && filter_var($this->parseFrom((string) $from)[1], FILTER_VALIDATE_EMAIL)) {
            [$name, $address] = $this->parseFrom((string) $from);
            $name = $name ?: 'NieuwsFlits';
            Config::set('mail.from.address', $address);
            Config::set('mail.from.name', $name);
        }
    }

    private function parseFrom(string $value): array
    {
        if (preg_match('/^(.*?)\s*<([^>]+)>$/', trim($value), $matches)) {
            return [trim($matches[1], " \t\"'"), trim($matches[2])];
        }

        return ['', trim($value)];
    }
}
