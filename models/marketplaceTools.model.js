const db = require('../config/db');
const transaction = require('../config/transaction');
const attributes = require('./listingAttributes.model');

// Both seller pages select at most one page of listings before computing these counts.
const listingMetrics = `l.views,
    (SELECT COUNT(*) FROM favorites f WHERE f.listing_id=l.id) AS favorites,
    (SELECT COUNT(*) FROM conversations c WHERE c.listing_id=l.id) AS contacts`;

async function comparison(ids) {
    if (!ids.length) return [];
    const [rows] = await db.execute(
        `SELECT l.id,l.title,l.item_condition,l.price,l.currency,c.id AS category_id,c.name AS category,
                co.name AS country,ci.name AS city,
                (SELECT i.image_path FROM listing_images i WHERE i.listing_id=l.id ORDER BY i.sort_order,i.id LIMIT 1) AS main_image
         FROM listings l JOIN users u ON u.id=l.user_id AND u.status='active'
         JOIN countries co ON co.id=l.country_id JOIN categories c ON c.id=l.category_id
         LEFT JOIN cities ci ON ci.id=l.city_id
         WHERE l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 AND l.id IN (${ids.map(() => '?').join(',')})`, ids);
    const values = await attributes.load(rows.map(row => row.id), db, true);
    const byId = new Map(rows.map(row => [row.id, { ...row, characteristics: attributes.formatted(values.get(row.id), row.item_condition) }]));
    return ids.map(id => byId.get(id)).filter(Boolean);
}

async function prices(id, userId) {
    const [rows] = await db.execute(
        `SELECT h.price,h.currency,h.is_drop,h.published_at
         FROM listing_price_history h JOIN listings l ON l.id=h.listing_id JOIN users u ON u.id=l.user_id
         WHERE l.id=? AND (l.user_id=? OR (l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 AND u.status='active'))
         ORDER BY h.id DESC LIMIT 30`, [id, userId ?? null]);
    return rows;
}

async function recordView(id, userId) {
    return transaction(async connection => {
        const [[listing]] = await connection.execute(
            "SELECT user_id FROM listings WHERE id=? AND status='active' AND moderation_locked=0 AND user_id<>?",
            [id, userId ?? 0]);
        if (!listing) return false;
        const [[seller]] = await connection.execute("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE", [listing.user_id]);
        if (!seller) return false;
        const [result] = await connection.execute(
            `UPDATE listings SET views=views+1,updated_at=updated_at
             WHERE id=? AND user_id=? AND status='active' AND moderation_locked=0`, [id, seller.id]);
        return result.affectedRows > 0;
    });
}

async function sellerStats(userId, requestedPage) {
    const [[totals]] = await db.execute(
        `SELECT COUNT(*) AS total,COALESCE(SUM(l.views),0) AS views,
           (SELECT COUNT(*) FROM listings fl JOIN favorites f ON f.listing_id=fl.id WHERE fl.user_id=?) AS favorites,
           (SELECT COUNT(*) FROM listings cl JOIN conversations c ON c.listing_id=cl.id WHERE cl.user_id=?) AS contacts
         FROM listings l WHERE l.user_id=?`, [userId, userId, userId]);
    const totalPages = Math.ceil(Number(totals.total) / 20);
    const page = Math.min(requestedPage, totalPages || 1);
    const [listings] = await db.execute(
        `SELECT l.id,l.title,${listingMetrics}
         FROM (SELECT id,title,views FROM listings WHERE user_id=? ORDER BY id DESC LIMIT 20 OFFSET ?) l
         ORDER BY l.id DESC`, [userId, (page - 1) * 20]);
    return { totals, listings, totalPages, page };
}

async function priceAlert(id, userId) {
    const [[row]] = await db.execute('SELECT notify_price_drop FROM favorites WHERE listing_id=? AND user_id=?', [id, userId]);
    return row ? Boolean(row.notify_price_drop) : null;
}

async function setPriceAlert(id, userId, enabled) {
    const [result] = await db.execute(
        `UPDATE favorites f JOIN listings l ON l.id=f.listing_id JOIN users u ON u.id=l.user_id
         SET f.notify_price_drop=? WHERE f.listing_id=? AND f.user_id=? AND l.user_id<>f.user_id
           AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 AND u.status='active'`, [enabled, id, userId]);
    return result.affectedRows > 0;
}

module.exports = { comparison, prices, recordView, sellerStats, listingMetrics, priceAlert, setPriceAlert };
