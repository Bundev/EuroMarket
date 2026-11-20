ALTER TABLE listings ADD COLUMN IF NOT EXISTS published_at DATETIME(3) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS expires_at DATETIME(3) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS expired_at DATETIME(3) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS bumped_at DATETIME(3) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS approved_version INT UNSIGNED NULL;
ALTER TABLE listings ADD INDEX IF NOT EXISTS idx_listing_expiry (status,expires_at,id);

CREATE TABLE IF NOT EXISTS listing_lifecycle_requests (
    user_id INT UNSIGNED NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fingerprint BINARY(32) NOT NULL,
    result JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT UTC_TIMESTAMP(3),
    PRIMARY KEY (user_id,request_key),
    KEY idx_lifecycle_request_age (created_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE OR REPLACE TRIGGER trg_listing_moderation_guard
BEFORE UPDATE ON listings FOR EACH ROW
BEGIN
    DECLARE seller_status VARCHAR(20);
    IF NEW.status = 'active' THEN
        IF OLD.moderation_locked = 1 OR NEW.moderation_locked = 1 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Publication restricted by moderation';
        END IF;
        SELECT status INTO seller_status FROM users WHERE id = NEW.user_id FOR UPDATE;
        IF seller_status <> 'active' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Seller account is not active';
        END IF;
        IF OLD.status <> 'active' THEN
            IF OLD.status = 'pending_review' AND NEW.review_version = OLD.review_version
               AND EXISTS (SELECT 1 FROM users WHERE id=@euromarket_actor_user_id AND role='admin' AND status='active') THEN
                SET NEW.approved_version = NEW.review_version;
                IF OLD.published_at IS NULL THEN
                    SET NEW.published_at = UTC_TIMESTAMP(3);
                    SET NEW.expires_at = COALESCE(NEW.expires_at, UTC_TIMESTAMP(3) + INTERVAL 30 DAY);
                END IF;
                SET NEW.expired_at = NULL;
            ELSEIF NOT (OLD.status = 'archived' AND OLD.expired_at IS NOT NULL
                AND OLD.approved_version IS NOT NULL AND OLD.approved_version = OLD.review_version
                AND NEW.review_version = OLD.review_version AND NEW.user_id = OLD.user_id
                AND COALESCE(@euromarket_actor_user_id = OLD.user_id, FALSE)
                AND COALESCE(NEW.expires_at > UTC_TIMESTAMP(3), FALSE)) THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Publication requires moderation approval';
            END IF;
        END IF;
    END IF;
END$$
DELIMITER ;
