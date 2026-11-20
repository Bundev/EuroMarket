const db = require('../config/db');
const transaction = require('../config/transaction');
const { lockParties, lockListing, requestPurchase } = require('./deal.model');
const { requireGoodsCategory } = require('./category.model');

const events = {
    offered: 'Новое предложение цены',
    countered: 'Получена встречная цена',
    accepted: 'Предложение цены принято',
    declined: 'Предложение цены отклонено'
};

function fail(message, status = 409) {
    throw Object.assign(new Error(message), { status });
}

async function participant(id, actor) {
    const [[row]] = await db.execute(
        'SELECT * FROM price_negotiations WHERE id=? AND (buyer_id=? OR seller_id=?)', [id, actor, actor]);
    if (!row) fail('Переговоры не найдены.', 404);
    return row;
}

async function available(connection, listingId, buyer, seller) {
    if (!await lockParties(connection, buyer, seller)) fail('Объявление недоступно для торга.', 404);
    const listing = await lockListing(connection, listingId);
    if (!listing || listing.user_id !== seller || listing.status !== 'active' ||
        listing.is_expired || listing.moderation_locked) fail('Объявление недоступно для торга.', 404);
    await requireGoodsCategory(connection, listing.category_id);
    if (!listing.bargaining_enabled) fail('Объявление недоступно для торга.', 404);
    const [[reserved]] = await connection.execute('SELECT id FROM deals WHERE reserved_listing_id=? FOR UPDATE', [listingId]);
    if (reserved) fail('Объявление зарезервировано.');
    return listing;
}

async function event(connection, row, version, actor, action, amount) {
    await connection.execute(
        'INSERT INTO price_negotiation_events (negotiation_id,version,actor_id,action,amount) VALUES (?,?,?,?,?)',
        [row.id, version, actor, action, amount]);
    await connection.execute(
        `INSERT INTO notifications (user_id,event_key,type,text,link) VALUES (?,?,'listing_status',?,?)
         ON DUPLICATE KEY UPDATE notifications.id=notifications.id`,
        [actor === row.buyer_id ? row.seller_id : row.buyer_id, 'price-offer:' + row.id + ':' + version,
            events[action] + ' · ' + amount + ' ' + row.currency, '/offers/' + row.id]);
}

async function start(listingId, buyer, amount, requestKey, listingVersion, currency) {
    const [[sellerRow]] = await db.execute('SELECT user_id FROM listings WHERE id=?', [listingId]);
    const seller = sellerRow?.user_id;
    if (!seller || buyer === seller) fail('Объявление недоступно для торга.', 404);
    return transaction(async connection => {
        const listing = await available(connection, listingId, buyer, seller);
        const [[replayed]] = await connection.execute(
            'SELECT id FROM price_negotiations WHERE listing_id=? AND buyer_id=? AND request_key=?',
            [listingId, buyer, requestKey]);
        if (replayed) return replayed.id;
        if (listing.review_version !== listingVersion || listing.currency !== currency) fail('Обновите страницу объявления.');
        await connection.execute(
            `UPDATE price_negotiations SET status='expired' WHERE listing_id=? AND active_buyer_id=?
             AND (listing_version<>? OR updated_at<=CURRENT_TIMESTAMP(3)-INTERVAL 7 DAY)`,
            [listingId, buyer, listing.review_version]);
        const [[active]] = await connection.execute(
            'SELECT id FROM price_negotiations WHERE listing_id=? AND active_buyer_id=?', [listingId, buyer]);
        if (active) fail('По этому объявлению уже идут переговоры.');
        const [[recentDecline]] = await connection.execute(
            `SELECT id FROM price_negotiations WHERE listing_id=? AND buyer_id=? AND status='declined'
             AND updated_at>CURRENT_TIMESTAMP(3)-INTERVAL 24 HOUR LIMIT 1`, [listingId, buyer]);
        if (recentDecline) fail('Новое предложение можно отправить через 24 часа после отказа.');
        const [result] = await connection.execute(
            `INSERT INTO price_negotiations
             (listing_id,buyer_id,seller_id,listing_title,listed_price,amount,currency,listing_version,last_actor_id,request_key)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [listingId, buyer, seller, listing.title, listing.price, amount, listing.currency, listing.review_version, buyer, requestKey]);
        await event(connection, { id: result.insertId, buyer_id: buyer, seller_id: seller, currency }, 1, buyer, 'offered', amount);
        return result.insertId;
    });
}

async function reply(id, actor, version, action, amount) {
    const initial = await participant(id, actor);
    await transaction(async connection => {
        const listing = await available(connection, initial.listing_id, initial.buyer_id, initial.seller_id);
        const [[row]] = await connection.execute(
            'SELECT *, updated_at>CURRENT_TIMESTAMP(3)-INTERVAL 7 DAY AS fresh FROM price_negotiations WHERE id=? FOR UPDATE', [id]);
        if (!row || !row.fresh || row.status !== 'open' || row.last_actor_id === actor ||
            row.version !== version || row.listing_version !== listing.review_version || row.currency !== listing.currency) {
            fail('Предложение изменилось или больше недоступно. Обновите страницу.');
        }
        if (action === 'countered' && version >= 98) fail('Лимит встречных цен достигнут. Примите или отклоните предложение.');
        const status = action === 'countered' ? 'open' : action;
        const nextAmount = action === 'countered' ? amount : row.amount;
        await connection.execute(
            'UPDATE price_negotiations SET amount=?,last_actor_id=?,status=?,version=version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',
            [nextAmount, actor, status, id]);
        await event(connection, row, version + 1, actor, action, nextAmount);
    });
}

async function details(id, actor) {
    const [[offer]] = await db.execute(
        `SELECT n.*, l.price AS current_price,
         (l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 AND l.bargaining_enabled AND l.user_id=n.seller_id
          AND l.review_version=n.listing_version AND l.currency=n.currency AND b.status='active' AND s.status='active'
          AND n.updated_at>CURRENT_TIMESTAMP(3)-INTERVAL 7 DAY
          AND NOT EXISTS (SELECT 1 FROM deals WHERE reserved_listing_id=l.id)) AS available
         FROM price_negotiations n JOIN listings l ON l.id=n.listing_id
         JOIN users b ON b.id=n.buyer_id JOIN users s ON s.id=n.seller_id
         WHERE n.id=? AND (n.buyer_id=? OR n.seller_id=?)`, [id, actor, actor]);
    if (!offer) return null;
    if (!offer.available) offer.current_price = offer.listed_price;
    const [history] = await db.execute(
        'SELECT actor_id,action,amount,created_at FROM price_negotiation_events WHERE negotiation_id=? ORDER BY version DESC LIMIT 100', [id]);
    return { offer, history };
}

async function list(actor, received, before) {
    const side = received ? 'seller_id' : 'buyer_id';
    const [rows] = await db.execute(
        `SELECT id,listing_title,amount,currency,status,updated_at FROM price_negotiations
         WHERE ${side}=? AND id<? ORDER BY id DESC LIMIT 21`, [actor, before]);
    return rows;
}

async function checkout(id, actor) {
    const offer = await participant(id, actor);
    if (offer.buyer_id !== actor) fail('Переговоры не найдены.', 404);
    if (offer.deal_id) return offer.deal_id;
    return requestPurchase(offer.listing_id, actor, require('node:crypto').randomUUID(), id);
}

module.exports = { start, reply, details, list, checkout };
