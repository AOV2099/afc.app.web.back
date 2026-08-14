<?php

declare(strict_types=1);

namespace Afc\OAuthBridge;

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use PDOException;
use Throwable;

final class BridgeStore
{
    private DateTimeZone $utc;

    public function __construct(
        private readonly PDO $pdo,
        private readonly Encryptor $encryptor,
    ) {
        $this->utc = new DateTimeZone('UTC');
    }

    public function createState(string $state, string $attempt, string $codeVerifier, int $expiresAt): void
    {
        $statement = $this->pdo->prepare(
            'INSERT INTO oauth_bridge_states
                (state_hash, attempt_hash, encrypted_verifier, expires_at)
             VALUES (:state_hash, :attempt_hash, :encrypted_verifier, :expires_at)',
        );
        $statement->execute([
            'state_hash' => $this->hashValue($state),
            'attempt_hash' => $this->hashValue($attempt),
            'encrypted_verifier' => $this->encryptor->encrypt(['code_verifier' => $codeVerifier]),
            'expires_at' => $this->timestamp($expiresAt),
        ]);
    }

    public function consumeState(string $state): array
    {
        $this->pdo->beginTransaction();

        try {
            $statement = $this->pdo->prepare(
                'SELECT attempt_hash, encrypted_verifier, expires_at
                   FROM oauth_bridge_states
                  WHERE state_hash = :state_hash
                  FOR UPDATE',
            );
            $stateHash = $this->hashValue($state);
            $statement->execute(['state_hash' => $stateHash]);
            $record = $statement->fetch();

            if (!$record) {
                $this->pdo->commit();
                throw new BridgeException('invalid_state', 'El estado OAuth no es válido.', 400);
            }

            $delete = $this->pdo->prepare(
                'DELETE FROM oauth_bridge_states WHERE state_hash = :state_hash',
            );
            $delete->execute(['state_hash' => $stateHash]);
            $this->pdo->commit();

            if (strtotime((string) $record['expires_at']) < time()) {
                throw new BridgeException('invalid_state', 'El estado OAuth expiró.', 400);
            }

            $verifier = $this->encryptor->decrypt((string) $record['encrypted_verifier']);
            $codeVerifier = (string) ($verifier['code_verifier'] ?? '');
            if ($codeVerifier === '') {
                throw new BridgeException('invalid_state', 'El estado OAuth está incompleto.', 400);
            }

            return [
                'attempt_hash' => (string) $record['attempt_hash'],
                'code_verifier' => $codeVerifier,
            ];
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $error;
        }
    }

    public function createCode(string $code, string $attemptHash, array $identity, int $ttlSeconds): void
    {
        $statement = $this->pdo->prepare(
            'INSERT INTO oauth_bridge_codes
                (code_hash, attempt_hash, encrypted_payload, expires_at)
             VALUES (:code_hash, :attempt_hash, :encrypted_payload, :expires_at)',
        );
        $statement->execute([
            'code_hash' => $this->hashValue($code),
            'attempt_hash' => $attemptHash,
            'encrypted_payload' => $this->encryptor->encrypt($identity),
            'expires_at' => $this->timestamp(time() + $ttlSeconds),
        ]);
    }

    public function consumeCode(string $code, string $attempt): array
    {
        $this->pdo->beginTransaction();

        try {
            $statement = $this->pdo->prepare(
                'SELECT attempt_hash, encrypted_payload, expires_at, used_at
                   FROM oauth_bridge_codes
                  WHERE code_hash = :code_hash
                  FOR UPDATE',
            );
            $codeHash = $this->hashValue($code);
            $statement->execute(['code_hash' => $codeHash]);
            $record = $statement->fetch();

            if (!$record) {
                $this->pdo->commit();
                throw new BridgeException('invalid_code', 'Código de acceso inválido.', 400);
            }

            if ($record['used_at'] !== null) {
                $this->pdo->commit();
                throw new BridgeException('code_already_used', 'Código de acceso ya utilizado.', 409);
            }

            if (strtotime((string) $record['expires_at']) < time()) {
                $this->invalidateCode($codeHash);
                $this->pdo->commit();
                throw new BridgeException('code_expired', 'Código de acceso expirado.', 410);
            }

            if (!hash_equals((string) $record['attempt_hash'], $this->hashValue($attempt))) {
                $this->pdo->commit();
                throw new BridgeException('invalid_attempt', 'Intento de acceso inválido.', 400);
            }

            $identity = $this->encryptor->decrypt((string) $record['encrypted_payload']);
            $this->invalidateCode($codeHash);
            $this->pdo->commit();

            return $identity;
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $error;
        }
    }

    public function claimNonce(string $nonce, int $expiresAt): void
    {
        try {
            $statement = $this->pdo->prepare(
                'INSERT INTO oauth_bridge_nonces (nonce_hash, expires_at)
                 VALUES (:nonce_hash, :expires_at)',
            );
            $statement->execute([
                'nonce_hash' => $this->hashValue($nonce),
                'expires_at' => $this->timestamp($expiresAt),
            ]);
        } catch (PDOException $error) {
            if ($error->getCode() === '23000') {
                throw new BridgeException('replayed_request', 'Solicitud repetida.', 401);
            }
            throw $error;
        }
    }

    public function purgeExpired(): void
    {
        $this->pdo->exec('DELETE FROM oauth_bridge_states WHERE expires_at < UTC_TIMESTAMP(6)');
        $this->pdo->exec(
            'DELETE FROM oauth_bridge_codes
              WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE)
                 OR used_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE)',
        );
        $this->pdo->exec('DELETE FROM oauth_bridge_nonces WHERE expires_at < UTC_TIMESTAMP(6)');
    }

    private function invalidateCode(string $codeHash): void
    {
        $statement = $this->pdo->prepare(
            'UPDATE oauth_bridge_codes
                SET used_at = UTC_TIMESTAMP(6), encrypted_payload = NULL
              WHERE code_hash = :code_hash',
        );
        $statement->execute(['code_hash' => $codeHash]);
    }

    private function hashValue(string $value): string
    {
        return hash('sha256', $value);
    }

    private function timestamp(int $unixTimestamp): string
    {
        return (new DateTimeImmutable('@' . $unixTimestamp))
            ->setTimezone($this->utc)
            ->format('Y-m-d H:i:s.u');
    }
}
