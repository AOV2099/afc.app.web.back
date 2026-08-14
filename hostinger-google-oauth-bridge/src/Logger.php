<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

final class Logger
{
    public function event(string $event, string $outcome, ?string $errorCode = null): void
    {
        $entry = [
            'timestamp' => gmdate(DATE_ATOM),
            'service' => 'afc-google-oauth-bridge',
            'event' => $event,
            'outcome' => $outcome,
            'correlation_id' => bin2hex(random_bytes(8)),
        ];

        if ($errorCode !== null) {
            $entry['error_code'] = $errorCode;
        }

        error_log((string) json_encode($entry, JSON_UNESCAPED_SLASHES));
    }
}
