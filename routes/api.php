<?php

use App\Http\Controllers\AdminController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\AccountController;
use App\Http\Controllers\NewsController;
use App\Http\Controllers\BillingController;
use Illuminate\Support\Facades\Route;

Route::get('/articles', [NewsController::class, 'articles']);
Route::get('/stats', [NewsController::class, 'stats']);
Route::get('/rss', [AccountController::class, 'rss']);
Route::get('/account', [AccountController::class, 'show']);
Route::patch('/account', [AccountController::class, 'update']);
Route::post('/account/share', [AccountController::class, 'share']);
Route::delete('/account/shares/{id}', [AccountController::class, 'revokeShare']);
Route::get('/account/api-keys', [AccountController::class, 'apiKeys']);
Route::post('/account/api-keys', [AccountController::class, 'createApiKey']);
Route::delete('/account/api-keys/{id}', [AccountController::class, 'deleteApiKey']);
Route::post('/auth/login', [AuthController::class, 'login']);
Route::post('/auth/logout', [AuthController::class, 'logout']);
Route::post('/auth/signup', [AuthController::class, 'signup']);
Route::post('/auth/verify', [AuthController::class, 'verify']);
Route::post('/auth/resend-verification', [AuthController::class, 'resend']);
Route::get('/auth/me', [AuthController::class, 'me']);
Route::post('/billing/checkout', [BillingController::class, 'checkout']);
Route::post('/billing/webhook', [BillingController::class, 'webhook']);
Route::prefix('admin')->group(function () {
    Route::get('/config', [AdminController::class, 'config']);
    Route::get('/users', [AdminController::class, 'users']);
    Route::post('/users', [AdminController::class, 'addUser']);
    Route::delete('/users/{id}', [AdminController::class, 'deleteUser']);
    Route::post('/users/{id}/subscription', [AdminController::class, 'assignSubscription']);
    Route::delete('/users/{id}/subscription', [AdminController::class, 'revokeSubscription']);
    Route::post('/sources', [AdminController::class, 'addSource']);
    Route::delete('/sources/{id}', [AdminController::class, 'deleteSource']);
    Route::post('/providers', [AdminController::class, 'addProvider']);
    Route::delete('/providers/{id}', [AdminController::class, 'deleteProvider']);
    Route::put('/integrations', [AdminController::class, 'integrations']);
    Route::post('/sync', [AdminController::class, 'sync']);
});
