const { createHash } = require('node:crypto');
const transaction = require('../config/transaction');
const { declinePendingForListing } = require('./deal.model');

async function change(connection, owner, listing, action) {
    if (!listing || listing.moderation_locked || listing.status === 'sold') return 'Объявление недоступно';
    const { id, status, expired, expired_at: expiredAt } = listing;
    const [[reserved]] = await connection.execute('SELECT id FROM deals WHERE reserved_listing_id=? FOR UPDATE', [id]);
    if (reserved) return 'Объявление участвует в сделке';
    if (action === 'bump') {
        if (status !== 'active' || expired) return 'Объявление не опубликовано';
        const [result] = await connection.execute(
            `UPDATE listings SET bumped_at=UTC_TIMESTAMP(3),updated_at=updated_at
             WHERE id=? AND (bumped_at IS NULL OR bumped_at<=UTC_TIMESTAMP(3)-INTERVAL 7 DAY)`, [id]);
        return result.affectedRows ? null : 'Поднятие доступно раз в 7 дней';
    }
    if (action === 'archive') {
        if (!['active','pending_review','draft','rejected'].includes(status)) return 'Объявление уже в архиве';
        await connection.execute("UPDATE listings SET status='archived',expired_at=NULL WHERE id=?", [id]);
        await declinePendingForListing(connection, id, 'Объявление перенесено в архив');
        return null;
    }
    if (action === 'restore') {
        if (status !== 'archived') return 'Объявление не в архиве';
        if (expired) return 'Сначала продлите срок объявления';
        await submitReview(connection, id);
        return null;
    }
    if (status !== 'active' && !(status === 'archived' && (expiredAt || expired)) &&
        !(status === 'pending_review' && expired)) return 'Объявление нельзя продлить в текущем состоянии';
    if (listing.at_limit) return 'Срок уже достиг 60 дней';
    await connection.execute(
        `UPDATE listings SET expires_at=LEAST(UTC_TIMESTAMP(3)+INTERVAL 60 DAY,
            GREATEST(COALESCE(expires_at,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3))+INTERVAL 30 DAY) WHERE id=?`, [id]);
    if (status === 'archived') {
        if (expiredAt && listing.approved_version !== null && listing.approved_version === listing.review_version) {
            await connection.execute('SET @euromarket_actor_user_id=?', [owner]);
            await connection.execute("UPDATE listings SET status='active',expired_at=NULL WHERE id=?", [id]);
        } else await submitReview(connection, id);
    }
    const [[result]] = await connection.execute("SELECT DATE_FORMAT(expires_at,'%d.%m.%Y') AS deadline FROM listings WHERE id=?", [id]);
    return { deadline: result.deadline };
}

async function submitReview(connection, id) {
    await connection.execute(
        `UPDATE listings SET status='pending_review',review_version=review_version+1,
            review_submitted_at=CURRENT_TIMESTAMP(3),review_reason=NULL,expired_at=NULL WHERE id=?`, [id]);
}

async function apply(owner, action, ids, key) {
    const fingerprint = createHash('sha256').update(JSON.stringify([action, ids])).digest();
    return transaction(async connection => {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE", [owner]);
        if (!user) return { forbidden: true };
        const [[previous]] = await connection.execute('SELECT fingerprint,result FROM listing_lifecycle_requests WHERE user_id=? AND request_key=?', [owner, key]);
        if (previous) return previous.fingerprint.equals(fingerprint) ?
            (typeof previous.result === 'string' ? JSON.parse(previous.result) : previous.result) : { conflict: true };
        const [rows] = await connection.execute(
            `SELECT id,status,moderation_locked,expired_at,review_version,approved_version,
                expires_at<=UTC_TIMESTAMP(3) AS expired, expires_at>=UTC_TIMESTAMP(3)+INTERVAL 59 DAY AS at_limit
             FROM listings WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, [owner, ...ids]);
        const byId = new Map(rows.map(row => [row.id, row]));
        const result = { done: 0, skipped: {}, deadline: null };
        for (const id of ids) {
            const outcome = await change(connection, owner, byId.get(id), action);
            if (typeof outcome === 'string') result.skipped[outcome] = (result.skipped[outcome] || 0) + 1;
            else { result.done++; if (ids.length === 1 && outcome) result.deadline = outcome.deadline; }
        }
        await connection.execute(
            'INSERT INTO listing_lifecycle_requests(user_id,request_key,fingerprint,result) VALUES (?,?,?,?)',
            [owner, key, fingerprint, JSON.stringify(result)]);
        return result;
    });
}

async function processBatch() {
    return transaction(async connection => {
        const [expired] = await connection.query(
            `SELECT id FROM listings l WHERE status='active' AND expires_at<=UTC_TIMESTAMP(3)
             AND NOT EXISTS (SELECT 1 FROM deals WHERE reserved_listing_id=l.id)
             ORDER BY expires_at,id LIMIT 40 FOR UPDATE SKIP LOCKED`);
        for (const { id } of expired) {
            await connection.execute("UPDATE listings SET status='archived',expired_at=UTC_TIMESTAMP(3) WHERE id=?", [id]);
            await declinePendingForListing(connection, id, 'Срок публикации объявления истёк');
        }
        await connection.query(
            `INSERT INTO notifications(user_id,event_key,type,text,link)
             SELECT l.user_id,CONCAT('listing-expiry:',l.id,':',DATE_FORMAT(l.expires_at,'%Y%m%d%H%i%s%f')),
                 'listing_status',LEFT(CONCAT('Срок публикации скоро истечёт: ',l.title),500),CONCAT('/my-listings')
             FROM listings l JOIN users u ON u.id=l.user_id AND u.status='active'
             WHERE l.status='active' AND l.moderation_locked=0 AND l.expires_at>UTC_TIMESTAMP(3)
                AND l.expires_at<=UTC_TIMESTAMP(3)+INTERVAL 3 DAY
                AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id=l.user_id
                  AND n.event_key=CONCAT('listing-expiry:',l.id,':',DATE_FORMAT(l.expires_at,'%Y%m%d%H%i%s%f')))
             ORDER BY l.expires_at,l.id LIMIT 40
             ON DUPLICATE KEY UPDATE notifications.id=notifications.id`);
    });
}

module.exports = { apply, processBatch };
