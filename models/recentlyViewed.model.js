const db = require('../config/db');
const transaction = require('../config/transaction');

async function lockUser(connection, userId) {
    const [[user]] = await connection.execute(
        "SELECT save_listing_history FROM users WHERE id=? AND status='active' FOR UPDATE", [userId]
    );
    return user;
}

async function record(userId, listingId) {
    return transaction(async connection => {
        const user = await lockUser(connection, userId);
        if (!user?.save_listing_history) return;
        const [[listing]] = await connection.execute(
            `SELECT l.id FROM listings l JOIN users seller ON seller.id=l.user_id AND seller.status='active'
             WHERE l.id=? AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 AND l.user_id<>?`, [listingId, userId]
        );
        if (!listing) return;

        // Assign the order after locking the user, including repeated views of one listing.
        await connection.execute('DELETE FROM recently_viewed WHERE user_id=? AND listing_id=?', [userId, listingId]);
        await connection.execute('INSERT INTO recently_viewed (user_id, listing_id) VALUES (?,?)', [userId, listingId]);
        const [[oldestToKeep]] = await connection.execute(
            'SELECT CAST(v.id AS CHAR) AS id FROM recently_viewed v WHERE v.user_id=? ORDER BY v.id DESC LIMIT 1 OFFSET 99', [userId]
        );
        if (oldestToKeep) await connection.execute('DELETE FROM recently_viewed WHERE user_id=? AND id<?', [userId, oldestToKeep.id]);
    });
}

async function remove(userId, listingId = null) {
    return transaction(async connection => {
        if (!await lockUser(connection, userId)) return;
        if (listingId === null) await connection.execute('DELETE FROM recently_viewed WHERE user_id=?', [userId]);
        else await connection.execute('DELETE FROM recently_viewed WHERE user_id=? AND listing_id=?', [userId, listingId]);
    });
}

async function setEnabled(userId, enabled) {
    await db.execute("UPDATE users SET save_listing_history=? WHERE id=? AND status='active'", [enabled, userId]);
}

async function hasEntries(userId) {
    const [[row]] = await db.execute('SELECT 1 FROM recently_viewed WHERE user_id=? LIMIT 1', [userId]);
    return Boolean(row);
}

async function preview(userId, excludedListingId = null) {
    const [rows] = await db.execute(
        `SELECT recent.id,recent.title,recent.price,recent.currency,
                (SELECT li.image_path FROM listing_images li WHERE li.listing_id=recent.id
                 ORDER BY li.sort_order, li.id LIMIT 1) AS main_image
         FROM (
             SELECT l.id,l.title,l.price,l.currency,v.id AS view_id
             FROM recently_viewed v JOIN listings l ON l.id=v.listing_id
             JOIN users seller ON seller.id=l.user_id AND seller.status='active'
             WHERE v.user_id=? AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0
             ${excludedListingId === null ? '' : 'AND l.id<>?'}
             ORDER BY v.id DESC LIMIT 4
         ) recent ORDER BY recent.view_id DESC`,
        excludedListingId === null ? [userId] : [userId, excludedListingId]
    );
    return rows;
}

module.exports = { record, remove, setEnabled, hasEntries, preview };
