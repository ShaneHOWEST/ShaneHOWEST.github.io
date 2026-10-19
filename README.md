<p align="center"><a href="https://laravel.com" target="_blank"><img src="https://raw.githubusercontent.com/laravel/art/master/logo-lockup/5%20SVG/2%20CMYK/1%20Full%20Color/laravel-logolockup-cmyk-red.svg" width="400" alt="Laravel Logo"></a></p>

<p align="center">
<a href="https://github.com/laravel/framework/actions"><img src="https://github.com/laravel/framework/workflows/tests/badge.svg" alt="Build Status"></a>
<a href="https://packagist.org/packages/laravel/framework"><img src="https://img.shields.io/packagist/dt/laravel/framework" alt="Total Downloads"></a>
<a href="https://packagist.org/packages/laravel/framework"><img src="https://img.shields.io/packagist/v/laravel/framework" alt="Latest Stable Version"></a>
<a href="https://packagist.org/packages/laravel/framework"><img src="https://img.shields.io/packagist/l/laravel/framework" alt="License"></a>
</p>

## About Laravel

Laravel is a web application framework with expressive, elegant syntax. We believe development must be an enjoyable and creative experience to be truly fulfilling. Laravel takes the pain out of development by easing common tasks used in many web projects, such as:

- [Simple, fast routing engine](https://laravel.com/docs/routing).
- [Powerful dependency injection container](https://laravel.com/docs/container).
- Multiple back-ends for [session](https://laravel.com/docs/session) and [cache](https://laravel.com/docs/cache) storage.
- Expressive, intuitive [database ORM](https://laravel.com/docs/eloquent).
- Database agnostic [schema migrations](https://laravel.com/docs/migrations).
- [Robust background job processing](https://laravel.com/docs/queues).
- [Real-time event broadcasting](https://laravel.com/docs/broadcasting).

Laravel is accessible, powerful, and provides tools required for large, robust applications.

## Learning Laravel

Laravel has the most extensive and thorough [documentation](https://laravel.com/docs) and video tutorial library of all modern web application frameworks, making it a breeze to get started with the framework.

In addition, [Laracasts](https://laracasts.com) contains thousands of video tutorials on a range of topics including Laravel, modern PHP, unit testing, and JavaScript. Boost your skills by digging into our comprehensive video library.

You can also watch bite-sized lessons with real-world projects on [Laravel Learn](https://laravel.com/learn), where you will be guided through building a Laravel application from scratch while learning PHP fundamentals.

## Agentic Development

Laravel's predictable structure and conventions make it ideal for AI coding agents like Claude Code, Cursor, and GitHub Copilot. Install [Laravel Boost](https://laravel.com/docs/ai) to supercharge your AI workflow:

```bash
composer require laravel/boost --dev

php artisan boost:install
```

Boost provides your agent 15+ tools and skills that help agents build Laravel applications while following best practices.

## Contributing

Thank you for considering contributing to the Laravel framework! The contribution guide can be found in the [Laravel documentation](https://laravel.com/docs/contributions).

## Code of Conduct

In order to ensure that the Laravel community is welcoming to all, please review and abide by the [Code of Conduct](https://laravel.com/docs/contributions#code-of-conduct).

## Security Vulnerabilities

If you discover a security vulnerability within Laravel, please send an e-mail to Taylor Otwell via [taylor@laravel.com](mailto:taylor@laravel.com). All security vulnerabilities will be promptly addressed.

## License

The Laravel framework is open-sourced software licensed under the [MIT license](https://opensource.org/licenses/MIT).
## Laravel + React-migratie

De hoofdapplicatie staat nu in Laravel 13 met een React/Vite-frontend. De bestaande SQLite-database is gemigreerd naar `database/nieuwsai.sqlite`; de oude Node.js-app staat tijdelijk onder `legacy-node/` als referentie en rollback.

Lokaal starten in deze omgeving:

```bash
export LD_LIBRARY_PATH="$PWD/.local-php/usr/lib/x86_64-linux-gnu:$PWD/.local-php/usr/lib/php/20230831"
.local-php/usr/bin/php8.3 artisan serve
```

De aparte Laravel-map `public/` is niet meer nodig in dit project. `index.php`, `.htaccess`, `build/`, `favicon.ico` en `robots.txt` staan in de projectroot; Laravel en Vite gebruiken de root daarom als document-root.

API-authenticatie gebruikt Laravel-sessies. De API-groep activeert daarom expliciet `StartSession`; gebruik op de webserver `SESSION_DRIVER=file` en zorg dat `storage/framework/sessions` schrijfbaar is. Kopieer `.env.example` naar `.env`, vul een unieke `APP_KEY` in en zet `APP_DEBUG=false`.

De applicatie gebruikt bewust altijd filesystem-sessies; de bestaande SQLite-database bevat een legacy `sessions`-tabel zonder Laravel-kolommen zoals `payload`. Wis na het uploaden een eventueel oude configuratiecache met `php artisan optimize:clear`. Laat `APP_KEY` daarna ongewijzigd: deze sleutel versleutelt de sessiecookie. De API ondersteunt sessiecookies expliciet, zodat inloggen na een paginaverversing behouden blijft.

E-mailverzending gebruikt standaard de `log`-mailer. Voor echte verzending vul je SMTP in via het staffpaneel onder **Betalingen & e-mail**; de opgeslagen SMTP-host, poort, gebruikersnaam, wachtwoord en afzender worden automatisch gebruikt voor registratie-, verificatie- en uitnodigingsmails. Laat **Afzender** leeg om automatisch de SMTP-gebruikersnaam te gebruiken, bijvoorbeeld `noreply@nieuwsflits.me`; dit voorkomt SMTP-fouten wanneer de provider alleen vanaf het ingelogde account mag verzenden. Zonder SMTP-instellingen blijven berichten in `storage/logs/laravel.log` staan.

De meegeleverde database staat in `database/nieuwsai.sqlite`. `database/database.sqlite` bevat dezelfde data als fallback voor hostingomgevingen die nog de Laravel-standaardnaam gebruiken. Na het uploaden kun je een eventueel oude configuratiecache wissen met `php artisan config:clear`.

### Gebruiker aanmaken via CLI

Maak vanuit de projectroot een gewone gebruiker aan:

```bash
php artisan news:user gebruiker@example.com --verified
```

Maak een staff-account aan:

```bash
php artisan news:user admin@example.com --staff --verified
```

Wis alle abonnementen en gedeelde uitnodigingen:

```bash
php artisan news:subscriptions-clear
```

Het commando vraagt standaard om bevestiging. Gebruik `--force` voor een niet-interactieve uitvoering:

```bash
php artisan news:subscriptions-clear --force
```

### Stripe

Maak in Stripe een terugkerend product met een interval van drie maanden en vul in het staffpaneel onder **Betalingen & e-mail** de `sk_test_...`/`sk_live_...` secret key en `price_...` Price ID in. Maak daarna in Stripe een webhook aan naar `/api/billing/webhook` en vul de signing secret (`whsec_...`) in. De checkout-knop gebruikt `/api/billing/checkout`; de webhook verwerkt checkout completion, subscription updates, mislukte/betaalde facturen en cancellations. Bij `invoice.payment_failed` wordt toegang direct geblokkeerd totdat Stripe een succesvolle betaling meldt.

Ingelogde gebruikers kunnen via **Mijn account** hun e-mailadres en wachtwoord wijzigen en hun abonnementsstatus bekijken.

Eigen actieve abonnementhouders kunnen daar ook maximaal vijf personen uitnodigen. De genodigde maakt een account aan met het uitgenodigde e-mailadres; daarna wordt de gedeelde toegang automatisch gekoppeld. De eigenaar kan openstaande of geaccepteerde toegang intrekken.

Staff kan in het beheer bij **Gebruikers & abonnementen** standaard drie maanden interne toegang toewijzen, verlengen of intrekken. Gedeelde abonnementen nemen altijd de vervaldatum van het hoofdabonnement over en worden bij een Stripe-verlenging of -beëindiging automatisch bijgewerkt. Dit wijzigt geen Stripe-abonnementen.

Zonder `--password` vraagt Artisan interactief om het wachtwoord. Een wachtwoord moet minimaal 10 tekens bevatten. Gebruik op productie eerst `php artisan optimize:clear` als er nog een oude configuratiecache aanwezig is.

Frontend bouwen:

```bash
export PATH="$PWD/.local/node/bin:$PATH"
npm run build
```

De React-homepage gebruikt de Laravel API-routes `/api/articles` en `/api/stats`. Staff-bronnen en AI-providers worden via de Laravel admin-API beheerd. De resterende legacy-integraties worden in vervolgstappen naar Laravel services/jobs overgezet; `legacy-node/` blijft behouden totdat die migratie volledig is gevalideerd.

### Laravel-functionaliteit

- `POST /api/admin/sync` en `php artisan news:sync` lezen actieve RSS- en websitebronnen uit en genereren volledige artikelen via actieve AI-providers op prioriteit.
- `POST /api/auth/verify` en `POST /api/auth/resend-verification` ondersteunen e-mailverificatie; zonder SMTP gebruikt Laravel de lokale mail-log.
- `GET/PATCH /api/account` en de share-endpoints ondersteunen profiel- en gedeelde-abonnementsacties.
- `PUT /api/admin/integrations` bewaart Stripe- en SMTP-instellingen in `app_settings`; geheime waarden worden niet teruggestuurd.
