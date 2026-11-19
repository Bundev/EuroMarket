ALTER TABLE notifications
    MODIFY COLUMN type ENUM('message', 'listing_status', 'review', 'deal') NOT NULL;

ALTER TABLE deals
    ADD COLUMN IF NOT EXISTS purchase_request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD UNIQUE INDEX IF NOT EXISTS uq_deal_purchase_request (buyer_id, listing_id, purchase_request_key),
    ADD INDEX IF NOT EXISTS idx_deal_seller_status (seller_id, status);
