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
