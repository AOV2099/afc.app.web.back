<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

final class Encryptor
{
    private string $key;

    public function __construct(string $sharedSecret)
    {
        $this->key = hash('sha256', $sharedSecret, true);
    }

    public function encrypt(array $payload): string
    {
        $plaintext = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $iv = random_bytes(12);
        $tag = '';
        $ciphertext = openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            '',
            16,
        );

        if ($ciphertext === false || strlen($tag) !== 16) {
            throw new BridgeException('encryption_error', 'No se pudo proteger la información temporal.', 500);
        }

        return 'v1.' . base64_encode($iv . $tag . $ciphertext);
    }

    public function decrypt(string $encrypted): array
    {
        if (!str_starts_with($encrypted, 'v1.')) {
            throw new BridgeException('invalid_stored_payload', 'Formato temporal inválido.', 500);
        }

        $binary = base64_decode(substr($encrypted, 3), true);
        if ($binary === false || strlen($binary) < 29) {
            throw new BridgeException('invalid_stored_payload', 'Información temporal inválida.', 500);
        }

        $iv = substr($binary, 0, 12);
        $tag = substr($binary, 12, 16);
        $ciphertext = substr($binary, 28);
        $plaintext = openssl_decrypt(
            $ciphertext,
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
        );

        if ($plaintext === false) {
            throw new BridgeException('invalid_stored_payload', 'No se pudo validar la información temporal.', 500);
        }

        $payload = json_decode($plaintext, true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($payload)) {
            throw new BridgeException('invalid_stored_payload', 'Información temporal incompleta.', 500);
        }

        return $payload;
    }
}
