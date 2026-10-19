<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

class CreateNewsUserCommand extends Command
{
    protected $signature = 'news:user
                            {email : E-mailadres van de gebruiker}
                            {--password= : Wachtwoord; zonder deze optie wordt er interactief om gevraagd}
                            {--staff : Maak de gebruiker aan als staff-account}
                            {--verified : Markeer het e-mailadres als geverifieerd}';

    protected $description = 'Maak een NieuwsFlits-gebruiker of staff-account aan';

    public function handle(): int
    {
        $email = strtolower(trim($this->argument('email')));
        if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->error('Gebruik een geldig e-mailadres.');
            return self::FAILURE;
        }

        if (DB::table('users')->where('email', $email)->exists()) {
            $this->error('Er bestaat al een gebruiker met dit e-mailadres.');
            return self::FAILURE;
        }

        $password = $this->option('password') ?: $this->secret('Wachtwoord (minimaal 10 tekens)');
        if (! is_string($password) || strlen($password) < 10) {
            $this->error('Het wachtwoord moet minimaal 10 tekens bevatten.');
            return self::FAILURE;
        }

        $id = DB::table('users')->insertGetId([
            'email' => $email,
            'password_hash' => Hash::make($password),
            'role' => $this->option('staff') ? 'staff' : 'member',
            'email_verified_at' => $this->option('verified') ? now() : null,
            'created_at' => now(),
        ]);

        $this->info(sprintf(
            'Gebruiker aangemaakt: %s (id %s, rol %s%s).',
            $email,
            $id,
            $this->option('staff') ? 'staff' : 'member',
            $this->option('verified') ? ', e-mail geverifieerd' : ''
        ));

        return self::SUCCESS;
    }
}
