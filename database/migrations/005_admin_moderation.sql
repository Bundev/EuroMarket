ALTER TABLE users ADD COLUMN IF NOT EXISTS block_reason VARCHAR(500) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderation_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS moderation_reason VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS reports (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    author_id INT UNSIGNED NULL,
    listing_id INT UNSIGNED NULL,
    reason ENUM('fraud','prohibited','spam','category','other') NOT NULL,
    comment VARCHAR(1000) NOT NULL DEFAULT '',
    status ENUM('open','accepted','rejected') NOT NULL DEFAULT 'open',
    open_marker TINYINT GENERATED ALWAYS AS (IF(status = 'open', 1, NULL)) PERSISTENT,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    reviewed_at DATETIME(3) NULL,
    reviewer_id INT UNSIGNED NULL,
    review_reason VARCHAR(500) NULL,
    UNIQUE KEY uq_reports_open (author_id, listing_id, open_marker),
    INDEX idx_reports_status (status, id),
    CONSTRAINT fk_reports_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_reports_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL,
    CONSTRAINT fk_reports_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_id INT UNSIGNED NULL,
    admin_name VARCHAR(100) NOT NULL,
    action_key CHAR(36) NOT NULL UNIQUE,
    action VARCHAR(50) NOT NULL,
    target_id INT UNSIGNED NOT NULL,
    reason VARCHAR(500) NOT NULL,
    before_state TEXT NOT NULL,
    after_state TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_admin_logs_admin (admin_id, id),
    CONSTRAINT fk_admin_logs_user FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE OR REPLACE TRIGGER trg_listing_moderation_guard
BEFORE UPDATE ON listings FOR EACH ROW
BEGIN
    DECLARE seller_status VARCHAR(20);
    IF NEW.status = 'active' AND (OLD.moderation_locked = 1 OR NEW.moderation_locked = 1) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Publication restricted by moderation';
    END IF;
    IF NEW.status = 'active' THEN
        SELECT status INTO seller_status FROM users WHERE id = NEW.user_id FOR UPDATE;
        IF seller_status <> 'active' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Seller account is not active';
        END IF;
    END IF;
END$$

CREATE OR REPLACE TRIGGER trg_listing_status_notification
AFTER UPDATE ON listings FOR EACH ROW
BEGIN
    IF (OLD.status <> NEW.status OR OLD.moderation_locked <> NEW.moderation_locked)
       AND (@euromarket_actor_user_id IS NULL OR @euromarket_actor_user_id <> NEW.user_id) THEN
        INSERT INTO notifications (user_id, event_key, type, text, link)
        VALUES (NEW.user_id, CONCAT('listing-status:', UUID()), 'listing_status',
            LEFT(CONCAT('Объявление «', NEW.title, '»: ', NEW.status,
                CASE WHEN NEW.moderation_locked = 1 THEN CONCAT('. Ограничение публикации: ', COALESCE(NEW.moderation_reason, 'Модерация'))
                     WHEN OLD.moderation_locked = 1 THEN '. Ограничение публикации снято' ELSE '' END), 500),
            CONCAT('/listings/', NEW.id));
    END IF;
END$$
DELIMITER ;
