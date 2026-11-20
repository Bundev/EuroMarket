const db = require('../config/db');

async function getUserFavorites(userId) {
    const [rows] = await db.execute(
        `SELECT f.listing_id, CASE WHEN l.moderation_locked=1 OR u.status<>'active' OR l.expires_at<=UTC_TIMESTAMP(3)
                 THEN 'draft' ELSE l.status END AS status
         FROM favorites f
         JOIN listings l ON l.id = f.listing_id
         JOIN users u ON u.id=l.user_id
         WHERE f.user_id = ?`,
        [userId]
    );
    return rows;
}

async function addFavorite(userId, listingId) {
    // INSERT ... SELECT проверяет доступность в том же запросе, что и запись.
    await db.execute(
        `INSERT INTO favorites (user_id, listing_id)
         SELECT ?, l.id FROM listings l JOIN users u ON u.id=l.user_id AND u.status='active'
         WHERE l.id = ? AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0
         ON DUPLICATE KEY UPDATE listing_id = VALUES(listing_id)`,
        [userId, listingId]
    );
    const [rows] = await db.execute(
        `SELECT f.listing_id
         FROM favorites f JOIN listings l ON l.id = f.listing_id
         JOIN users u ON u.id=l.user_id AND u.status='active'
         WHERE f.user_id = ? AND f.listing_id = ? AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0`,
        [userId, listingId]
    );
    return rows.length > 0;
}

async function removeFavorite(userId, listingId) {
    await db.execute(
        'DELETE FROM favorites WHERE user_id = ? AND listing_id = ?',
        [userId, listingId]
    );
}

module.exports = { getUserFavorites, addFavorite, removeFavorite };
