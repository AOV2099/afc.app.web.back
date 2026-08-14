CREATE TABLE IF NOT EXISTS oauth_bridge_states (
    state_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    attempt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    encrypted_verifier TEXT NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_oauth_bridge_states_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_bridge_codes (
    code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    attempt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    encrypted_payload MEDIUMTEXT NULL,
    expires_at DATETIME(6) NOT NULL,
    used_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_oauth_bridge_codes_expires (expires_at),
    INDEX idx_oauth_bridge_codes_used (used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_bridge_nonces (
    nonce_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    expires_at DATETIME(6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX idx_oauth_bridge_nonces_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
