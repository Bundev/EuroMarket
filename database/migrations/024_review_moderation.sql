-- Stop application writers and back up before applying this migration.
ALTER TABLE reviews
    ADD COLUMN IF NOT EXISTS moderation_status ENUM('pending','approved','rejected') NULL,
    ADD COLUMN IF NOT EXISTS moderation_reason VARCHAR(500) NULL,
    ADD COLUMN IF NOT EXISTS moderation_version INT UNSIGNED NOT NULL DEFAULT 0;

UPDATE reviews r
SET r.moderation_status=IF(r.hidden_at IS NULL,'approved','rejected'),
    r.moderation_reason=CASE WHEN r.hidden_at IS NOT NULL THEN (
        SELECT a.reason FROM admin_logs a WHERE a.target_id=r.deal_id AND a.action='review_hide'
        ORDER BY a.id DESC LIMIT 1
    ) END
WHERE r.moderation_status IS NULL;

ALTER TABLE reviews
    MODIFY moderation_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    ADD INDEX IF NOT EXISTS idx_review_moderation (moderation_status,created_at,deal_id);
