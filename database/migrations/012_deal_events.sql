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
