<?php

declare(strict_types=1);

use Afc\OAuthBridge\BridgeApplication;
use Afc\OAuthBridge\BridgeException;
use Afc\OAuthBridge\BridgeStore;
use Afc\OAuthBridge\Config;
use Afc\OAuthBridge\Database;
use Afc\OAuthBridge\Encryptor;
use Afc\OAuthBridge\GoogleOAuth;
use Afc\OAuthBridge\Logger;

header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
date_default_timezone_set('UTC');

$appRoot = dirname(__DIR__);
$rootConfigPath = __DIR__ . '/bridge-root.php';
if (is_file($rootConfigPath)) {
    $configuredRoot = require $rootConfigPath;
    if (is_string($configuredRoot) && trim($configuredRoot) !== '') {
        $appRoot = rtrim(trim($configuredRoot), '/');
    }
}

$autoload = $appRoot . '/vendor/autoload.php';
if (!is_file($autoload)) {
    error_log('{"service":"afc-google-oauth-bridge","event":"bootstrap","outcome":"failed","error_code":"dependencies_missing"}');
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":false,"error":"service_unavailable"}';
    exit;
}

require $autoload;

try {
    $config = Config::fromEnvironment();
    $store = new BridgeStore(
        Database::connect($config),
        new Encryptor($config->sharedSecret),
    );
    $application = new BridgeApplication(
        $config,
        $store,
        new GoogleOAuth($config),
        new Logger(),
    );
    $application->run();
} catch (BridgeException $error) {
    error_log((string) json_encode([
        'service' => 'afc-google-oauth-bridge',
        'event' => 'bootstrap',
        'outcome' => 'failed',
        'error_code' => $error->errorCode,
    ], JSON_UNESCAPED_SLASHES));
    http_response_code($error->httpStatus);
    header('Content-Type: application/json; charset=utf-8');
    echo (string) json_encode(['ok' => false, 'error' => $error->errorCode]);
} catch (Throwable) {
    error_log('{"service":"afc-google-oauth-bridge","event":"bootstrap","outcome":"failed","error_code":"internal_error"}');
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":false,"error":"internal_error"}';
}
