<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

use Throwable;

final class BridgeApplication
{
    public function __construct(
        private readonly Config $config,
        private readonly BridgeStore $store,
        private readonly GoogleOAuth $google,
        private readonly Logger $logger,
    ) {
    }

    public function run(): void
    {
        $this->securityHeaders();
        $path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

        if ($this->config->basePath !== '') {
            if ($path === $this->config->basePath) {
                $path = '/';
            } elseif (str_starts_with($path, $this->config->basePath . '/')) {
                $path = substr($path, strlen($this->config->basePath));
            }
        }

        try {
            match ($path) {
                '/auth/google/start' => $this->handleStart(),
                '/auth/google/callback' => $this->handleGoogleCallback(),
                '/api/auth/verify' => $this->handleVerify(),
                '/health' => $this->handleHealth(),
                default => $this->jsonResponse(404, [
                    'ok' => false,
                    'error' => 'not_found',
                ]),
            };
        } catch (BridgeException $error) {
            $this->logger->event('request', 'rejected', $error->errorCode);
            $this->jsonResponse($error->httpStatus, [
                'ok' => false,
                'error' => $error->errorCode,
            ]);
        } catch (Throwable) {
            $this->logger->event('request', 'failed', 'internal_error');
            $this->jsonResponse(500, [
                'ok' => false,
                'error' => 'internal_error',
            ]);
        }
    }

    private function handleStart(): void
    {
        $this->requireMethod('GET');
        $attempt = trim((string) ($_GET['attempt'] ?? ''));
        $expiresRaw = trim((string) ($_GET['expires'] ?? ''));
        $signature = strtolower(trim((string) ($_GET['signature'] ?? '')));

        if (
            !preg_match('/^[A-Za-z0-9_-]{43}$/', $attempt) ||
            !preg_match('/^\d{10}$/', $expiresRaw) ||
            !preg_match('/^[a-f0-9]{64}$/', $signature)
        ) {
            $this->redirectToApplication(['error' => 'invalid_request']);
        }

        $expiresAt = (int) $expiresRaw;
        $now = time();
        if ($expiresAt <= $now || $expiresAt > $now + $this->config->stateTtlSeconds) {
            $this->redirectToApplication(['error' => 'invalid_request']);
        }

        $expected = hash_hmac('sha256', $attempt . '.' . $expiresRaw, $this->config->sharedSecret);
        if (!hash_equals($expected, $signature)) {
            $this->logger->event('oauth_start', 'rejected', 'invalid_signature');
            $this->redirectToApplication(['error' => 'invalid_request']);
        }

        $state = $this->randomBase64Url(32);
        $codeVerifier = $this->randomBase64Url(64);
        $codeChallenge = $this->base64Url(hash('sha256', $codeVerifier, true));
        $this->store->createState($state, $attempt, $codeVerifier, $expiresAt);
        $this->maybePurgeExpired();
        $this->logger->event('oauth_start', 'success');

        $this->redirect($this->google->buildAuthorizationUrl($state, $codeChallenge));
    }

    private function handleGoogleCallback(): void
    {
        $this->requireMethod('GET');
        $googleError = strtolower(trim((string) ($_GET['error'] ?? '')));
        if ($googleError !== '') {
            $error = $googleError === 'access_denied' ? 'access_denied' : 'google_error';
            $this->logger->event('google_callback', 'rejected', $error);
            $this->redirectToApplication(['error' => $error]);
        }

        $state = trim((string) ($_GET['state'] ?? ''));
        $authorizationCode = trim((string) ($_GET['code'] ?? ''));
        if ($state === '' || $authorizationCode === '') {
            $this->redirectToApplication(['error' => 'invalid_state']);
        }

        try {
            $stateData = $this->store->consumeState($state);
            $identity = $this->google->exchangeAndVerify(
                $authorizationCode,
                (string) $stateData['code_verifier'],
            );
            $opaqueCode = $this->randomBase64Url(32);
            $this->store->createCode(
                $opaqueCode,
                (string) $stateData['attempt_hash'],
                $identity,
                $this->config->codeTtlSeconds,
            );
            unset($authorizationCode, $identity);
            $this->logger->event('google_callback', 'success');
            $this->redirectToApplication(['code' => $opaqueCode]);
        } catch (BridgeException $error) {
            $this->logger->event('google_callback', 'rejected', $error->errorCode);
            $publicError = $error->errorCode === 'invalid_state' ? 'invalid_state' : 'google_error';
            $this->redirectToApplication(['error' => $publicError]);
        } catch (Throwable) {
            $this->logger->event('google_callback', 'failed', 'bridge_error');
            $this->redirectToApplication(['error' => 'bridge_error']);
        }
    }

    private function handleVerify(): void
    {
        $this->requireMethod('POST');
        $rawBody = file_get_contents('php://input');
        if ($rawBody === false || strlen($rawBody) > 2048) {
            throw new BridgeException('invalid_request', 'Cuerpo inválido.', 400);
        }

        $timestampRaw = $this->header('X-Bridge-Timestamp');
        $nonce = strtolower($this->header('X-Bridge-Nonce'));
        $signature = strtolower($this->header('X-Bridge-Signature'));
        if (
            !preg_match('/^\d{10}$/', $timestampRaw) ||
            !preg_match('/^[a-f0-9-]{36}$/', $nonce) ||
            !preg_match('/^[a-f0-9]{64}$/', $signature)
        ) {
            throw new BridgeException('invalid_signature', 'Firma ausente.', 401);
        }

        $timestamp = (int) $timestampRaw;
        if (abs(time() - $timestamp) > $this->config->signatureToleranceSeconds) {
            throw new BridgeException('expired_signature', 'Firma expirada.', 401);
        }

        $signedPayload = $timestampRaw . '.' . $nonce . '.' . $rawBody;
        $expected = hash_hmac('sha256', $signedPayload, $this->config->sharedSecret);
        if (!hash_equals($expected, $signature)) {
            throw new BridgeException('invalid_signature', 'Firma inválida.', 401);
        }

        $this->store->claimNonce(
            $nonce,
            $timestamp + $this->config->signatureToleranceSeconds,
        );
        $payload = json_decode($rawBody, true);
        $code = trim((string) ($payload['code'] ?? ''));
        $attempt = trim((string) ($payload['attempt'] ?? ''));
        if (
            !is_array($payload) ||
            !preg_match('/^[A-Za-z0-9_-]{43}$/', $code) ||
            !preg_match('/^[A-Za-z0-9_-]{43}$/', $attempt)
        ) {
            throw new BridgeException('invalid_code', 'Código inválido.', 400);
        }

        $identity = $this->store->consumeCode($code, $attempt);
        if (
            ($identity['provider'] ?? null) !== 'google' ||
            empty($identity['subject']) ||
            empty($identity['email']) ||
            ($identity['email_verified'] ?? false) !== true
        ) {
            throw new BridgeException('invalid_stored_payload', 'Identidad inválida.', 500);
        }

        $this->logger->event('code_verify', 'success');
        $this->jsonResponse(200, [
            'ok' => true,
            'identity' => $identity,
        ]);
    }

    private function handleHealth(): void
    {
        $this->requireMethod('GET');
        $this->jsonResponse(200, ['ok' => true, 'service' => 'google-oauth-bridge']);
    }

    private function requireMethod(string $expected): void
    {
        if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== $expected) {
            header('Allow: ' . $expected);
            throw new BridgeException('method_not_allowed', 'Método no permitido.', 405);
        }
    }

    private function header(string $name): string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        return trim((string) ($_SERVER[$key] ?? ''));
    }

    private function redirectToApplication(array $query): never
    {
        $separator = str_contains($this->config->appCallbackUrl, '?') ? '&' : '?';
        $this->redirect(
            $this->config->appCallbackUrl . $separator . http_build_query($query, '', '&', PHP_QUERY_RFC3986),
        );
    }

    private function redirect(string $url): never
    {
        header('Location: ' . $url, true, 302);
        exit;
    }

    private function jsonResponse(int $status, array $payload): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    private function securityHeaders(): void
    {
        header('Cache-Control: no-store, max-age=0');
        header('Pragma: no-cache');
        header('Referrer-Policy: no-referrer');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }

    private function randomBase64Url(int $bytes): string
    {
        return $this->base64Url(random_bytes($bytes));
    }

    private function base64Url(string $binary): string
    {
        return rtrim(strtr(base64_encode($binary), '+/', '-_'), '=');
    }

    private function maybePurgeExpired(): void
    {
        if (random_int(1, 100) === 1) {
            $this->store->purgeExpired();
        }
    }
}
