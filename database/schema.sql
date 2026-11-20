
CREATE TABLE IF NOT EXISTS countries (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code CHAR(2) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    currency CHAR(3) NOT NULL,
    language VARCHAR(10) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cities (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    country_id INT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    INDEX idx_country (country_id),

    CONSTRAINT fk_cities_country
        FOREIGN KEY (country_id)
        REFERENCES countries(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categories (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    parent_id INT UNSIGNED NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    icon VARCHAR(50) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT fk_categories_parent
        FOREIGN KEY (parent_id)
        REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    phone VARCHAR(30) NULL,
    phone_public BOOLEAN NOT NULL DEFAULT FALSE,
    country_id INT UNSIGNED NULL,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    status ENUM('active', 'blocked') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_users_country
        FOREIGN KEY (country_id)
        REFERENCES countries(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS listings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id INT UNSIGNED NOT NULL,
    category_id INT UNSIGNED NOT NULL,
    country_id INT UNSIGNED NOT NULL,
    city_id INT UNSIGNED NULL,

    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,

    price DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'EUR',

    status ENUM(
        'draft',
        'active',
        'sold',
        'archived'
    ) NOT NULL DEFAULT 'draft',

    views INT UNSIGNED NOT NULL DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user (user_id),
    INDEX idx_category (category_id),
    INDEX idx_country (country_id),
    INDEX idx_status_created (status, created_at),

    CONSTRAINT fk_listings_user
        FOREIGN KEY (user_id) REFERENCES users(id),

    CONSTRAINT fk_listings_category
        FOREIGN KEY (category_id) REFERENCES categories(id),

    CONSTRAINT fk_listings_country
        FOREIGN KEY (country_id) REFERENCES countries(id),

    CONSTRAINT fk_listings_city
        FOREIGN KEY (city_id) REFERENCES cities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS listing_images (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    listing_id INT UNSIGNED NOT NULL,
    image_path VARCHAR(255) NOT NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_listing (listing_id),

    CONSTRAINT fk_listing_images_listing
        FOREIGN KEY (listing_id) REFERENCES listings(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS favorites (
    user_id INT UNSIGNED NOT NULL,
    listing_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, listing_id),
    INDEX idx_favorites_listing (listing_id),

    CONSTRAINT fk_favorites_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_favorites_listing
        FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Также создаётся автоматически хранилищем express-mysql-session.
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    expires INT UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    listing_id INT UNSIGNED NULL,
    buyer_id INT UNSIGNED NOT NULL,
    seller_id INT UNSIGNED NOT NULL,
    listing_title VARCHAR(200) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_conversation_buyer_listing (listing_id, buyer_id),
    INDEX idx_conversations_buyer (buyer_id, id),
    INDEX idx_conversations_seller (seller_id, id),
    CONSTRAINT fk_conversations_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL,
    CONSTRAINT fk_conversations_buyer FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_conversations_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_conversation_participants CHECK (buyer_id <> seller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT UNSIGNED NOT NULL,
    sender_id INT UNSIGNED NOT NULL,
    body VARCHAR(2000) NOT NULL,
    client_key CHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    read_at DATETIME(3) NULL,
    UNIQUE KEY uq_message_retry (conversation_id, sender_id, client_key),
    INDEX idx_messages_history (conversation_id, id),
    INDEX idx_messages_unread (conversation_id, read_at, sender_id, id),
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_message_body CHECK (CHAR_LENGTH(TRIM(body)) BETWEEN 1 AND 2000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

-- Shared atomic authentication budgets. Apply explicitly before enabling mariadb mode.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    state_json JSON NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    INDEX idx_auth_rate_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deals (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    listing_id INT UNSIGNED NOT NULL,
    buyer_id INT UNSIGNED NOT NULL,
    seller_id INT UNSIGNED NOT NULL,
    price DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    status ENUM('requested','accepted','declined','cancelled','completed') NOT NULL DEFAULT 'requested',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    buyer_confirmed_at DATETIME(3) NULL,
    seller_confirmed_at DATETIME(3) NULL,
    completed_at DATETIME(3) NULL,
    open_buyer_id INT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status IN ('requested','accepted') THEN buyer_id END) PERSISTENT,
    reserved_listing_id INT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status IN ('accepted','completed') THEN listing_id END) PERSISTENT,
    UNIQUE KEY uq_deal_open_buyer (listing_id, open_buyer_id),
    UNIQUE KEY uq_deal_reserved_listing (reserved_listing_id),
    KEY idx_deal_buyer (buyer_id, id),
    KEY idx_deal_seller (seller_id, id),
    CONSTRAINT fk_deal_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE RESTRICT,
    CONSTRAINT fk_deal_buyer FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_deal_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_deal_parties CHECK (buyer_id <> seller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS reviews (
    deal_id INT UNSIGNED NOT NULL PRIMARY KEY,
    rating TINYINT UNSIGNED NOT NULL,
    comment VARCHAR(1500) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NULL,
    hidden_at DATETIME(3) NULL,
    moderation_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    moderation_reason VARCHAR(500) NULL,
    moderation_version INT UNSIGNED NOT NULL DEFAULT 0,
    INDEX idx_review_moderation (moderation_status,created_at,deal_id),
    CONSTRAINT fk_reviews_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE RESTRICT,
    CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS review_reports (
    deal_id INT UNSIGNED NOT NULL,
    reporter_id INT UNSIGNED NOT NULL,
    reason VARCHAR(500) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    resolved_at DATETIME(3) NULL,
    PRIMARY KEY (deal_id, reporter_id),
    INDEX idx_review_reports_open (resolved_at, deal_id),
    CONSTRAINT fk_review_reports_review FOREIGN KEY (deal_id) REFERENCES reviews(deal_id) ON DELETE RESTRICT,
    CONSTRAINT fk_review_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE notifications
    MODIFY COLUMN type ENUM('message', 'listing_status', 'review', 'deal') NOT NULL;

ALTER TABLE deals
    ADD COLUMN IF NOT EXISTS purchase_request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD UNIQUE INDEX IF NOT EXISTS uq_deal_purchase_request (buyer_id, listing_id, purchase_request_key),
    ADD INDEX IF NOT EXISTS idx_deal_seller_status (seller_id, status);

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

CREATE TABLE IF NOT EXISTS deal_events (
    deal_id INT UNSIGNED NOT NULL,
    event_type ENUM('accepted','declined','cancelled') NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    PRIMARY KEY (deal_id, event_type),
    CONSTRAINT fk_deal_event_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE OR REPLACE TRIGGER trg_deal_status_event
AFTER UPDATE ON deals FOR EACH ROW
BEGIN
    IF OLD.status <> NEW.status AND NEW.status IN ('accepted','declined','cancelled') THEN
        INSERT INTO deal_events (deal_id, event_type, occurred_at)
        VALUES (NEW.id, NEW.status, CURRENT_TIMESTAMP(3));
    END IF;
END$$
DELIMITER ;

CREATE TABLE IF NOT EXISTS deal_disputes (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    deal_id INT UNSIGNED NOT NULL,
    opened_by INT UNSIGNED NOT NULL,
    reason ENUM('not_delivered','not_as_described','payment','other') NOT NULL,
    status ENUM('open','info_requested','resolved','rejected') NOT NULL DEFAULT 'open',
    opening_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    open_deal_id INT UNSIGNED GENERATED ALWAYS AS
        (CASE WHEN status IN ('open','info_requested') THEN deal_id END) PERSISTENT,
    UNIQUE KEY uq_dispute_open_deal (open_deal_id),
    UNIQUE KEY uq_dispute_opening (deal_id, opened_by, opening_key),
    KEY idx_dispute_deal (deal_id, id),
    KEY idx_dispute_status (status, id),
    CONSTRAINT fk_dispute_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE RESTRICT,
    CONSTRAINT fk_dispute_opener FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deal_dispute_entries (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    dispute_id INT UNSIGNED NOT NULL,
    actor_id INT UNSIGNED NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action ENUM('opened','reply','request_info','resolve','reject') NOT NULL,
    body VARCHAR(2000) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_dispute_entry_request (dispute_id, actor_id, request_key),
    KEY idx_dispute_entry_history (dispute_id, id),
    CONSTRAINT fk_dispute_entry_dispute FOREIGN KEY (dispute_id) REFERENCES deal_disputes(id) ON DELETE RESTRICT,
    CONSTRAINT fk_dispute_entry_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deal_dispute_images (
    dispute_id INT UNSIGNED NOT NULL,
    position TINYINT UNSIGNED NOT NULL,
    image_data MEDIUMBLOB NOT NULL,
    PRIMARY KEY (dispute_id, position),
    CONSTRAINT chk_dispute_image_position CHECK (position BETWEEN 1 AND 5),
    CONSTRAINT chk_dispute_image_size CHECK (OCTET_LENGTH(image_data) BETWEEN 1 AND 3145728),
    CONSTRAINT fk_dispute_image_dispute FOREIGN KEY (dispute_id) REFERENCES deal_disputes(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_followed_sellers BOOLEAN NOT NULL DEFAULT TRUE;
-- Existing listings have no complete publication history. Only new rows are eligible.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS subscription_announcement_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE listings ALTER COLUMN subscription_announcement_pending SET DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS seller_follows (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    seller_id INT UNSIGNED NOT NULL,
    follower_id INT UNSIGNED NOT NULL,
    UNIQUE KEY uq_seller_follower (seller_id, follower_id),
    KEY idx_seller_follow_batch (seller_id, id),
    KEY idx_follower_sellers (follower_id, id),
    CONSTRAINT chk_seller_follower CHECK (seller_id <> follower_id),
    CONSTRAINT fk_follow_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_follow_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS seller_publication_jobs (
    listing_id INT UNSIGNED NOT NULL PRIMARY KEY,
    review_version INT UNSIGNED NOT NULL,
    last_follow_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    max_follow_id BIGINT UNSIGNED NOT NULL,
    finished_at DATETIME(3) NULL,
    KEY idx_publication_jobs_pending (finished_at, listing_id),
    CONSTRAINT fk_publication_job_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saved_searches (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    query_text VARCHAR(100) NOT NULL,
    country_id INT UNSIGNED NULL,
    city_id INT UNSIGNED NULL,
    category_id INT UNSIGNED NULL,
    min_price DECIMAL(12,2) NULL,
    max_price DECIMAL(12,2) NULL,
    currency CHAR(3) NULL,
    notify BOOLEAN NOT NULL DEFAULT TRUE,
    criteria_key BINARY(32) NOT NULL,
    UNIQUE KEY uq_saved_search_criteria (user_id, criteria_key),
    KEY idx_saved_search_owner (user_id, id),
    CONSTRAINT fk_saved_search_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_search_country FOREIGN KEY (country_id) REFERENCES countries(id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_search_city FOREIGN KEY (city_id) REFERENCES cities(id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_search_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE seller_publication_jobs
    ADD COLUMN IF NOT EXISTS last_search_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_search_id BIGINT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS save_listing_history BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS recently_viewed (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    listing_id INT UNSIGNED NOT NULL,
    UNIQUE KEY uq_recently_viewed_listing (user_id, listing_id),
    KEY idx_recently_viewed_order (user_id, id),
    CONSTRAINT fk_recently_viewed_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_recently_viewed_listing FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


ALTER TABLE listings ADD COLUMN IF NOT EXISTS item_condition VARCHAR(80) NULL;
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS notify_price_drop BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS listing_price_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    listing_id INT UNSIGNED NOT NULL,
    price DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    is_drop BOOLEAN NOT NULL DEFAULT FALSE,
    published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_listing_price_history (listing_id,id),
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE OR REPLACE TRIGGER trg_listing_price_history AFTER UPDATE ON listings FOR EACH ROW
BEGIN
    DECLARE last_price DECIMAL(12,2) DEFAULT NULL;
    DECLARE last_currency CHAR(3) DEFAULT NULL;
    IF (OLD.status='active' AND NEW.status<>'active')
       OR (NEW.status='active' AND (OLD.status<>'active' OR OLD.price<>NEW.price OR OLD.currency<>NEW.currency)) THEN
        SET last_price = (SELECT h.price FROM listing_price_history h WHERE h.listing_id=NEW.id ORDER BY h.id DESC LIMIT 1);
        SET last_currency = (SELECT h.currency FROM listing_price_history h WHERE h.listing_id=NEW.id ORDER BY h.id DESC LIMIT 1);
        IF last_price IS NULL AND OLD.status='active' AND OLD.moderation_locked=0 THEN
            INSERT INTO listing_price_history (listing_id,price,currency) VALUES (OLD.id,OLD.price,OLD.currency);
            SET last_price = OLD.price;
            SET last_currency = OLD.currency;
        END IF;
        IF NEW.status='active' AND NEW.moderation_locked=0
           AND (last_price IS NULL OR last_price<>NEW.price OR CAST(last_currency AS BINARY)<>CAST(NEW.currency AS BINARY)) THEN
            INSERT INTO listing_price_history (listing_id,price,currency,is_drop)
            VALUES (NEW.id,NEW.price,NEW.currency,COALESCE(CAST(last_currency AS BINARY)=CAST(NEW.currency AS BINARY) AND NEW.price<last_price,FALSE));
            IF CAST(last_currency AS BINARY)=CAST(NEW.currency AS BINARY) AND NEW.price<last_price THEN
                INSERT INTO notifications (user_id,event_key,type,text,link)
                SELECT f.user_id,CONCAT('price-drop:',NEW.id,':',NEW.review_version),'listing_status',
                       CONCAT('Цена снижена: «',NEW.title,'» · ',NEW.price,' ',NEW.currency),
                       CONCAT('/listings/',NEW.id)
                FROM favorites f JOIN users u ON u.id=f.user_id AND u.status='active'
                WHERE f.listing_id=NEW.id AND f.notify_price_drop=1 AND f.user_id<>NEW.user_id
                ON DUPLICATE KEY UPDATE notifications.id=notifications.id;
            END IF;
        END IF;
    END IF;
END$$
DELIMITER ;


ALTER TABLE listings ADD COLUMN IF NOT EXISTS bargaining_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS price_negotiations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    listing_id INT UNSIGNED NOT NULL,
    buyer_id INT UNSIGNED NOT NULL,
    seller_id INT UNSIGNED NOT NULL,
    listing_title VARCHAR(200) NOT NULL,
    listed_price DECIMAL(12,2) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    listing_version INT UNSIGNED NOT NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    last_actor_id INT UNSIGNED NOT NULL,
    status ENUM('open','accepted','declined','expired','converted') NOT NULL DEFAULT 'open',
    request_key CHAR(36) NOT NULL,
    deal_id INT UNSIGNED NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    active_buyer_id INT UNSIGNED AS (CASE WHEN status IN ('open','accepted') THEN buyer_id END) PERSISTENT,
    UNIQUE KEY uq_negotiation_active (listing_id,active_buyer_id),
    UNIQUE KEY uq_negotiation_request (listing_id,buyer_id,request_key),
    KEY idx_negotiation_buyer (buyer_id,id),
    KEY idx_negotiation_seller (seller_id,id),
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
    FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS price_negotiation_events (
    negotiation_id INT UNSIGNED NOT NULL,
    version INT UNSIGNED NOT NULL,
    actor_id INT UNSIGNED NOT NULL,
    action ENUM('offered','countered','accepted','declined','converted') NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (negotiation_id,version),
    FOREIGN KEY (negotiation_id) REFERENCES price_negotiations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


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


CREATE TABLE IF NOT EXISTS listing_attributes (
    listing_id INT UNSIGNED NOT NULL,
    field_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    text_value VARCHAR(100) NULL,
    number_value DECIMAL(12,2) NULL,
    PRIMARY KEY (listing_id,field_key),
    KEY idx_attribute_text (field_key,text_value,listing_id),
    KEY idx_attribute_number (field_key,number_value,listing_id),
    CHECK ((text_value IS NULL) <> (number_value IS NULL)),
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS attribute_query TEXT NULL;
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS sort_order VARCHAR(16) NOT NULL DEFAULT 'newest';


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
