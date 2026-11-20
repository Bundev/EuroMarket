-- Compare ISO currency codes independently of database and column collations.
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
