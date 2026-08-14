<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

final class Config
{
    private function __construct(
        public readonly string $googleClientId,
        public readonly string $googleClientSecret,
        public readonly string $googleRedirectUri,
        public readonly string $appCallbackUrl,
        public readonly string $sharedSecret,
        public readonly string $dbHost,
        public readonly int $dbPort,
        public readonly string $dbName,
        public readonly string $dbUser,
        public readonly string $dbPassword,
        public readonly int $codeTtlSeconds,
        public readonly int $stateTtlSeconds,
        public readonly int $signatureToleranceSeconds,
        public readonly int $httpTimeoutSeconds,
    ) {
    }

    public static function fromEnvironment(): self
    {
        $googleRedirectUri = self::requireUrl('BRIDGE_GOOGLE_REDIRECT_URI', true);
        $appCallbackUrl = self::requireUrl('BRIDGE_APP_CALLBACK_URL', false);
        $sharedSecret = self::requireEnvironment('BRIDGE_SHARED_SECRET');

        if (strlen($sharedSecret) < 32) {
            throw new BridgeException(
                'configuration_error',
                'BRIDGE_SHARED_SECRET debe tener al menos 32 caracteres.',
                500,
            );
        }

        return new self(
            self::requireEnvironment('BRIDGE_GOOGLE_CLIENT_ID'),
            self::requireEnvironment('BRIDGE_GOOGLE_CLIENT_SECRET'),
            $googleRedirectUri,
            $appCallbackUrl,
            $sharedSecret,
            self::requireEnvironment('BRIDGE_DB_HOST'),
            self::boundedInteger('BRIDGE_DB_PORT', 3306, 1, 65535),
            self::requireEnvironment('BRIDGE_DB_NAME'),
            self::requireEnvironment('BRIDGE_DB_USER'),
            self::requireEnvironment('BRIDGE_DB_PASSWORD'),
            self::boundedInteger('BRIDGE_CODE_TTL_SECONDS', 45, 30, 60),
            self::boundedInteger('BRIDGE_STATE_TTL_SECONDS', 300, 60, 600),
            self::boundedInteger('BRIDGE_SIGNATURE_TOLERANCE_SECONDS', 60, 30, 300),
            self::boundedInteger('BRIDGE_HTTP_TIMEOUT_SECONDS', 10, 3, 30),
        );
    }

    private static function requireEnvironment(string $name): string
    {
        $value = trim((string) getenv($name));
        if ($value === '') {
            throw new BridgeException(
                'configuration_error',
                sprintf('Falta la variable de entorno %s.', $name),
                500,
            );
        }

        return $value;
    }

    private static function requireUrl(string $name, bool $httpsOnly): string
    {
        $value = rtrim(self::requireEnvironment($name), '/');
        $parts = parse_url($value);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));

        if (!filter_var($value, FILTER_VALIDATE_URL) || !in_array($scheme, ['http', 'https'], true)) {
            throw new BridgeException('configuration_error', sprintf('%s no es una URL válida.', $name), 500);
        }

        if ($httpsOnly && $scheme !== 'https') {
            throw new BridgeException('configuration_error', sprintf('%s debe utilizar HTTPS.', $name), 500);
        }

        if (isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])) {
            throw new BridgeException('configuration_error', sprintf('%s contiene componentes no permitidos.', $name), 500);
        }

        return $value;
    }

    private static function boundedInteger(string $name, int $default, int $minimum, int $maximum): int
    {
        $raw = trim((string) getenv($name));
        if ($raw === '') {
            return $default;
        }

        $value = filter_var($raw, FILTER_VALIDATE_INT);
        if ($value === false || $value < $minimum || $value > $maximum) {
            throw new BridgeException(
                'configuration_error',
                sprintf('%s debe estar entre %d y %d.', $name, $minimum, $maximum),
                500,
            );
        }

        return $value;
    }
}
