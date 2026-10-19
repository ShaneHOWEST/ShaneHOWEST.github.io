<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class ClearNewsSubscriptionsCommand extends Command
{
    protected $signature = 'news:subscriptions-clear
                            {--force : Verwijder zonder om bevestiging te vragen}';

    protected $description = 'Verwijder alle abonnementen en gedeelde abonnementuitnodigingen';

    public function handle(): int
    {
        $subscriptions = DB::table('subscriptions')->count();
        $shares = DB::table('subscription_shares')->count();

        if (! $this->option('force') && ! $this->confirm(sprintf(
            'Dit verwijdert %d abonnement(en) en %d gedeelde uitnodiging(en). Doorgaan?',
            $subscriptions,
            $shares
        ))) {
            $this->warn('Geen abonnementen verwijderd.');
            return self::SUCCESS;
        }

        DB::transaction(function (): void {
            DB::table('subscriptions')->delete();
            DB::table('subscription_shares')->delete();
        });

        $this->info(sprintf('%d abonnement(en) en %d gedeelde uitnodiging(en) verwijderd.', $subscriptions, $shares));
        return self::SUCCESS;
    }
}
