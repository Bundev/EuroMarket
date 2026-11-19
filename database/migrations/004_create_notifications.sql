CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    event_key VARCHAR(100) NOT NULL,
    type ENUM('message', 'listing_status') NOT NULL,
    text VARCHAR(500) NOT NULL,
    link VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    read_at DATETIME(3) NULL,
    UNIQUE KEY uq_notifications_event (user_id, event_key),
    INDEX idx_notifications_user (user_id, id),
    INDEX idx_notifications_unread (user_id, read_at, id),
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE OR REPLACE TRIGGER trg_message_notification
AFTER INSERT ON messages FOR EACH ROW
BEGIN
    INSERT INTO notifications (user_id, event_key, type, text, link)
    SELECT CASE WHEN NEW.sender_id = c.buyer_id THEN c.seller_id ELSE c.buyer_id END,
           CONCAT('message:', NEW.id), 'message',
           CONCAT('Новое сообщение по объявлению «', c.listing_title, '»'),
           CONCAT('/messages/', c.id)
    FROM conversations c
    WHERE c.id = NEW.conversation_id AND NEW.sender_id IN (c.buyer_id, c.seller_id)
    ON DUPLICATE KEY UPDATE notifications.id = notifications.id;
END$$

CREATE OR REPLACE TRIGGER trg_listing_status_notification
AFTER UPDATE ON listings FOR EACH ROW
BEGIN
    IF OLD.status <> NEW.status AND
       (@euromarket_actor_user_id IS NULL OR @euromarket_actor_user_id <> NEW.user_id) THEN
        INSERT INTO notifications (user_id, event_key, type, text, link)
        VALUES (NEW.user_id, CONCAT('listing-status:', UUID()), 'listing_status',
                CONCAT('Статус объявления «', NEW.title, '» изменён: ', NEW.status),
                CONCAT('/listings/', NEW.id));
    END IF;
END$$
DELIMITER ;
