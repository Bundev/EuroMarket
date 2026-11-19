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
