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
