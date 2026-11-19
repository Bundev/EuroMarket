CREATE TABLE IF NOT EXISTS reviews (
    deal_id INT UNSIGNED NOT NULL PRIMARY KEY,
    rating TINYINT UNSIGNED NOT NULL,
    comment VARCHAR(1500) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NULL,
    hidden_at DATETIME(3) NULL,
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

ALTER TABLE notifications MODIFY type ENUM('message', 'listing_status', 'review') NOT NULL;
