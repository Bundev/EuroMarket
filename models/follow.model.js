const db = require('../config/db');
const transaction = require('../config/transaction');

async function summary(sellerId, viewerId) {
    const [[row]] = await db.execute(
        `SELECT COUNT(*) AS total, COALESCE(MAX(f.follower_id=?),0) AS following
         FROM seller_follows f JOIN users viewer ON viewer.id=f.follower_id AND viewer.status='active'
         WHERE f.seller_id=?`, [viewerId ?? null, sellerId]
    );
    return { total: Number(row.total), following: Boolean(Number(row.following)) };
}

async function isFollowing(sellerId, viewerId) {
    const [[row]] = await db.execute(
        'SELECT 1 FROM seller_follows WHERE seller_id=? AND follower_id=?',
        [sellerId, viewerId]
    );
    return Boolean(row);
}

async function change(sellerId, actorId, following) {
    if (sellerId === actorId) throw Object.assign(new Error('Нельзя подписаться на свой профиль.'), { status: 400 });
    return transaction(async connection => {
        const [users] = await connection.execute('SELECT id,status FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE', [sellerId, actorId]);
        const actor = users.find(user => Number(user.id) === actorId);
        const seller = users.find(user => Number(user.id) === sellerId);
        if (actor?.status !== 'active') throw Object.assign(new Error('Войдите в аккаунт, чтобы управлять подписками.'), { status: 401 });
        if (following) {
            if (seller?.status !== 'active') throw Object.assign(new Error('Продавец недоступен.'), { status: 404 });
            await connection.execute(
                'INSERT INTO seller_follows (seller_id,follower_id) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id', [sellerId, actorId]);
        } else {
            await connection.execute('DELETE FROM seller_follows WHERE seller_id=? AND follower_id=?', [sellerId, actorId]);
        }
    });
}

async function list(actorId, requestedPage) {
    const [[actor]] = await db.execute("SELECT notify_followed_sellers FROM users WHERE id=? AND status='active'", [actorId]);
    if (!actor) return null;
    const from = "FROM seller_follows f JOIN users seller ON seller.id=f.seller_id AND seller.status='active' WHERE f.follower_id=?";
    const [[count]] = await db.execute('SELECT COUNT(*) AS total ' + from, [actorId]);
    const totalPages = Math.max(1, Math.ceil(Number(count.total) / 20));
    const page = Math.min(requestedPage, totalPages);
    const [sellers] = await db.execute('SELECT seller.id,seller.name ' + from + ' ORDER BY f.id DESC LIMIT 20 OFFSET ?', [actorId, (page - 1) * 20]);
    return { sellers, page, totalPages, notificationsEnabled: Boolean(actor.notify_followed_sellers) };
}

async function setNotifications(actorId, enabled) {
    await db.execute("UPDATE users SET notify_followed_sellers=? WHERE id=? AND status='active'", [enabled, actorId]);
}

async function hasActiveFollows(actorId) {
    const [[row]] = await db.execute(
        `SELECT 1 FROM seller_follows f JOIN users seller ON seller.id=f.seller_id AND seller.status='active'
         WHERE f.follower_id=? LIMIT 1`, [actorId]
    );
    return Boolean(row);
}

module.exports = { summary, isFollowing, change, list, setNotifications, hasActiveFollows };
