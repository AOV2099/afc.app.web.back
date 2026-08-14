<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

use Google\Client as GoogleClient;
use GuzzleHttp\Client as HttpClient;
use Throwable;

final class GoogleOAuth
{
    private const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

    public function __construct(private readonly Config $config)
    {
    }

    public function buildAuthorizationUrl(string $state, string $codeChallenge): string
    {
        return self::AUTHORIZATION_ENDPOINT . '?' . http_build_query([
            'client_id' => $this->config->googleClientId,
            'redirect_uri' => $this->config->googleRedirectUri,
            'response_type' => 'code',
            'scope' => 'openid email profile',
            'state' => $state,
            'code_challenge' => $codeChallenge,
            'code_challenge_method' => 'S256',
            'access_type' => 'online',
            'include_granted_scopes' => 'true',
            'prompt' => 'select_account',
        ], '', '&', PHP_QUERY_RFC3986);
    }

    public function exchangeAndVerify(string $authorizationCode, string $codeVerifier): array
    {
        try {
            $client = new GoogleClient();
            $client->setClientId($this->config->googleClientId);
            $client->setClientSecret($this->config->googleClientSecret);
            $client->setRedirectUri($this->config->googleRedirectUri);
            $client->setHttpClient(new HttpClient([
                'connect_timeout' => $this->config->httpTimeoutSeconds,
                'timeout' => $this->config->httpTimeoutSeconds,
                'verify' => true,
            ]));
            $tokenResponse = $client->fetchAccessTokenWithAuthCode(
                $authorizationCode,
                $codeVerifier,
            );
        } catch (Throwable) {
            throw new BridgeException(
                'google_token_error',
                'No fue posible comunicarse con Google.',
                502,
            );
        }

        if (!is_array($tokenResponse) || isset($tokenResponse['error'])) {
            throw new BridgeException(
                'google_token_error',
                'Google rechazó la solicitud de autenticación.',
                502,
            );
        }

        $idToken = trim((string) ($tokenResponse['id_token'] ?? ''));

        if ($idToken === '') {
            throw new BridgeException(
                'google_identity_missing',
                'Google no devolvió una identidad verificable.',
                502,
            );
        }

        try {
            $profile = $client->verifyIdToken($idToken);
        } catch (Throwable) {
            $profile = false;
        }
        unset($tokenResponse, $idToken);

        if (!is_array($profile)) {
            throw new BridgeException(
                'google_identity_invalid',
                'Google no pudo verificar la identidad.',
                401,
            );
        }

        $issuer = (string) ($profile['iss'] ?? '');
        $audience = (string) ($profile['aud'] ?? '');
        $authorizedParty = (string) ($profile['azp'] ?? $audience);
        $expiresAt = (int) ($profile['exp'] ?? 0);
        $emailVerified = filter_var(
            $profile['email_verified'] ?? false,
            FILTER_VALIDATE_BOOLEAN,
            FILTER_NULL_ON_FAILURE,
        ) === true;

        if (
            !in_array($issuer, ['accounts.google.com', 'https://accounts.google.com'], true) ||
            !hash_equals($this->config->googleClientId, $audience) ||
            !hash_equals($this->config->googleClientId, $authorizedParty) ||
            $expiresAt <= time() ||
            !$emailVerified
        ) {
            throw new BridgeException(
                'google_identity_invalid',
                'La identidad devuelta por Google no es válida.',
                401,
            );
        }

        $subject = trim((string) ($profile['sub'] ?? ''));
        $email = strtolower(trim((string) ($profile['email'] ?? '')));
        if ($subject === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new BridgeException(
                'google_identity_invalid',
                'La identidad de Google está incompleta.',
                401,
            );
        }

        return [
            'provider' => 'google',
            'subject' => $subject,
            'email' => $email,
            'email_verified' => true,
            'first_name' => trim((string) ($profile['given_name'] ?? '')),
            'last_name' => trim((string) ($profile['family_name'] ?? '')),
            'picture' => trim((string) ($profile['picture'] ?? '')) ?: null,
        ];
    }

}
