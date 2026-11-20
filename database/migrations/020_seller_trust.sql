ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at DATETIME(3) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_phone VARCHAR(30)
    AS (CASE WHEN phone_verified_at IS NOT NULL THEN phone ELSE NULL END) PERSISTENT;
ALTER TABLE users ADD UNIQUE INDEX IF NOT EXISTS uq_verified_phone (verified_phone);
ALTER TABLE deals ADD INDEX IF NOT EXISTS idx_deals_seller_completed (seller_id,status);

CREATE TABLE IF NOT EXISTS phone_verifications (
    user_id INT UNSIGNED PRIMARY KEY,
    phone VARCHAR(30) NOT NULL,
    nonce CHAR(36) NOT NULL,
    code_hash BINARY(32) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    delivered BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS seller_reports (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    author_id INT UNSIGNED NOT NULL,
    seller_id INT UNSIGNED NOT NULL,
    reason ENUM('fraud','harassment','impersonation','other') NOT NULL,
    comment VARCHAR(1000) NOT NULL,
    status ENUM('open','accepted','dismissed') NOT NULL DEFAULT 'open',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    reviewed_at DATETIME(3) NULL,
    reviewer_id INT UNSIGNED NULL,
    open_seller_id INT UNSIGNED AS (CASE WHEN status='open' THEN seller_id END) PERSISTENT,
    UNIQUE KEY uq_seller_report_open (author_id,open_seller_id),
    KEY idx_seller_reports_queue (status,id),
    KEY idx_seller_reports_author (author_id,seller_id,created_at),
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE OR REPLACE TRIGGER trg_user_phone_verification_reset
BEFORE UPDATE ON users FOR EACH ROW
BEGIN
    IF NOT (BINARY OLD.phone <=> BINARY NEW.phone) THEN
        SET NEW.phone_verified_at = NULL;
    END IF;
END$$

CREATE OR REPLACE TRIGGER trg_user_phone_challenge_reset
AFTER UPDATE ON users FOR EACH ROW
BEGIN
    IF NOT (BINARY OLD.phone <=> BINARY NEW.phone) THEN
        DELETE FROM phone_verifications WHERE user_id=NEW.id;
    END IF;
END$$
DELIMITER ;
