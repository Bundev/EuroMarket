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
