const db = require('../config/db');

const editableStatuses = ['draft', 'active', 'pending_review', 'rejected'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

async function lockEditable(connection, listingId, userId) {
    const [[owner]] = await connection.execute("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE", [userId]);
    if (!owner) fail(403, 'Аккаунт недоступен.');
    const [[listing]] = await connection.execute('SELECT * FROM listings WHERE id=? AND user_id=? FOR UPDATE', [listingId, userId]);
    if (!listing || !editableStatuses.includes(listing.status)) fail(404, 'Объявление недоступно.');
    const [[reserved]] = await connection.execute(
        "SELECT id FROM deals WHERE reserved_listing_id=? AND status='accepted' FOR UPDATE", [listingId]
    );
    if (reserved) fail(409, 'Условия и фотографии нельзя менять, пока идёт принятая сделка.');
    await connection.execute('SET @euromarket_actor_user_id = ?', [userId]);
    return listing;
}

async function contentChanged(connection, listing) {
    const pending = ['active', 'pending_review'].includes(listing.status);
    await connection.execute(
        `UPDATE listings SET status=?, review_version=review_version+1,
             review_submitted_at=IF(?, CURRENT_TIMESTAMP(3), review_submitted_at),
             review_reason=IF(?, NULL, review_reason), updated_at=CURRENT_TIMESTAMP
         WHERE id=?`, [pending ? 'pending_review' : listing.status, pending, pending, listing.id]
    );
    return pending;
}

async function stats() {
    const [[row]] = await db.query("SELECT COUNT(*) AS total FROM listings WHERE status='pending_review'");
    return Number(row.total);
}

async function queue({ page, country, category }) {
    const clauses = ["l.status='pending_review'"];
    const values = [];
    if (country) { clauses.push('l.country_id=?'); values.push(country); }
    if (category) { clauses.push('l.category_id=?'); values.push(category); }
    const where = clauses.join(' AND ');
    const [[count]] = await db.execute('SELECT COUNT(*) AS total FROM listings l WHERE ' + where, values);
    const totalPages = Math.max(1, Math.ceil(Number(count.total) / 20));
    page = Math.min(page, totalPages);
    const [items] = await db.execute(
        `SELECT l.id,l.title,l.description,l.price,l.currency,l.review_version,l.review_submitted_at,l.moderation_locked,
                u.name AS seller,u.status AS seller_status,c.name AS category,co.name AS country,
                (SELECT image_path FROM listing_images i WHERE i.listing_id=l.id ORDER BY i.sort_order,i.id LIMIT 1) AS image
         FROM listings l JOIN users u ON u.id=l.user_id JOIN categories c ON c.id=l.category_id
         JOIN countries co ON co.id=l.country_id WHERE ${where}
         ORDER BY l.review_submitted_at,l.id LIMIT ? OFFSET ?`, [...values, 20, (page - 1) * 20]
    );
    return { items, page, totalPages };
}

module.exports = { editableStatuses, lockEditable, contentChanged, stats, queue, fail };
