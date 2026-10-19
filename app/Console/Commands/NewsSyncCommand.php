<?php

namespace App\Console\Commands;

use App\Services\NewsSyncService;
use Illuminate\Console\Command;

class NewsSyncCommand extends Command
{
    protected $signature = 'news:sync';
    protected $description = 'Lees nieuwsbronnen uit en genereer volledige artikelen via AI';

    public function handle(NewsSyncService $sync): int
    {
        $stats = $sync->run();
        $this->table(['Metriek', 'Aantal'], collect($stats)->map(fn ($value, $key) => [$key, $value])->values()->all());
        return self::SUCCESS;
    }
}
