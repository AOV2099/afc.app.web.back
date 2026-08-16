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
        $privateConfig = self::loadPrivateConfig();
        $googleRedirectUri = self::requireUrl(
            'BRIDGE_GOOGLE_REDIRECT_URI',
            true,
            $privateConfig,
        );
        $appCallbackUrl = self::requireUrl(
            'BRIDGE_APP_CALLBACK_URL',
            false,
            $privateConfig,
        );
        $sharedSecret = self::requireSetting('BRIDGE_SHARED_SECRET', $privateConfig);

        if (strlen($sharedSecret) < 32) {
            throw new BridgeException(
                'configuration_error',
                'BRIDGE_SHARED_SECRET debe tener al menos 32 caracteres.',
                500,
            );
        }

        return new self(
            self::requireSetting('BRIDGE_GOOGLE_CLIENT_ID', $privateConfig),
            self::requireSetting('BRIDGE_GOOGLE_CLIENT_SECRET', $privateConfig),
            $googleRedirectUri,
            $appCallbackUrl,
            $sharedSecret,
            self::requireSetting('BRIDGE_DB_HOST', $privateConfig),
            self::boundedInteger('BRIDGE_DB_PORT', 3306, 1, 65535, $privateConfig),
            self::requireSetting('BRIDGE_DB_NAME', $privateConfig),
            self::requireSetting('BRIDGE_DB_USER', $privateConfig),
            self::requireSetting('BRIDGE_DB_PASSWORD', $privateConfig),
            self::boundedInteger('BRIDGE_CODE_TTL_SECONDS', 45, 30, 60, $privateConfig),
            self::boundedInteger('BRIDGE_STATE_TTL_SECONDS', 300, 60, 600, $privateConfig),
            self::boundedInteger(
                'BRIDGE_SIGNATURE_TOLERANCE_SECONDS',
                60,
                30,
                300,
                $privateConfig,
            ),
            self::boundedInteger('BRIDGE_HTTP_TIMEOUT_SECONDS', 10, 3, 30, $privateConfig),
        );
    }

    /** @return array<string, scalar|null> */
    private static function loadPrivateConfig(): array
    {
        $path = dirname(__DIR__) . '/config.local.php';
        if (!is_file($path)) {
            return [];
        }

        $config = require $path;
        if (!is_array($config)) {
            throw new BridgeException(
                'configuration_error',
                'config.local.php debe retornar un arreglo de configuración.',
                500,
            );
        }

        return $config;
    }

    /** @param array<string, scalar|null> $privateConfig */
    private static function setting(string $name, array $privateConfig): string
    {
        $environmentValue = getenv($name);
        if ($environmentValue !== false && trim((string) $environmentValue) !== '') {
            return trim((string) $environmentValue);
        }

        return trim((string) ($privateConfig[$name] ?? ''));
    }

    /** @param array<string, scalar|null> $privateConfig */
    private static function requireSetting(string $name, array $privateConfig): string
    {
        $value = self::setting($name, $privateConfig);
        if ($value === '') {
            throw new BridgeException(
                'configuration_error',
                sprintf('Falta la configuración privada %s.', $name),
                500,
            );
        }

        return $value;
    }

    /** @param array<string, scalar|null> $privateConfig */
    private static function requireUrl(
        string $name,
        bool $httpsOnly,
        array $privateConfig,
    ): string
    {
        $value = rtrim(self::requireSetting($name, $privateConfig), '/');
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

    /** @param array<string, scalar|null> $privateConfig */
    private static function boundedInteger(
        string $name,
        int $default,
        int $minimum,
        int $maximum,
        array $privateConfig,
    ): int
    {
        $raw = self::setting($name, $privateConfig);
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
