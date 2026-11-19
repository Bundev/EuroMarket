-- Preserve all existing status values and published listings.
ALTER TABLE listings MODIFY status ENUM('draft','active','sold','archived','pending_review','rejected') NOT NULL DEFAULT 'draft';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS review_version INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS review_submitted_at DATETIME(3) NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS review_reason VARCHAR(500) NULL;
ALTER TABLE listings ADD INDEX IF NOT EXISTS idx_listing_review_queue (status, review_submitted_at, id);
ALTER TABLE listing_images ADD INDEX IF NOT EXISTS idx_listing_image_path (image_path);

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
        IF OLD.status <> 'active' AND (
            OLD.status <> 'pending_review' OR NEW.review_version <> OLD.review_version OR
            NOT EXISTS (SELECT 1 FROM users WHERE id=@euromarket_actor_user_id AND role='admin' AND status='active')
        ) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Publication requires moderation approval';
        END IF;
    END IF;
END$$

CREATE OR REPLACE TRIGGER trg_listing_status_notification
AFTER UPDATE ON listings FOR EACH ROW
BEGIN
    IF OLD.status = 'pending_review' AND NEW.status IN ('active','rejected') THEN
        INSERT INTO notifications (user_id, event_key, type, text, link)
        VALUES (NEW.user_id, CONCAT('listing-review:', NEW.id, ':', NEW.review_version), 'listing_status',
            LEFT(CASE WHEN NEW.status = 'active' THEN CONCAT('Объявление «', NEW.title, '» одобрено и опубликовано.')
                      ELSE CONCAT('Объявление №', NEW.id, ' отклонено. Причина: ', COALESCE(NEW.review_reason, 'Модерация')) END, 500),
            CONCAT('/listings/', NEW.id))
        ON DUPLICATE KEY UPDATE notifications.id = notifications.id;
    ELSEIF (OLD.status <> NEW.status OR OLD.moderation_locked <> NEW.moderation_locked)
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
