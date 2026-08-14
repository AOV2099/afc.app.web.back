<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

use RuntimeException;

final class BridgeException extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $httpStatus = 400,
    ) {
        parent::__construct($message);
    }
}
