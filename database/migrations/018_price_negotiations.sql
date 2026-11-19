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
