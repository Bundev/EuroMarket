-- Shared atomic authentication budgets. Apply explicitly before enabling mariadb mode.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    state_json JSON NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    INDEX idx_auth_rate_expiry (expires_at)
) ENGINE=InnoDB;
