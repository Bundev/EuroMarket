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
