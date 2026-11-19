const db = require('../config/db');

async function count(userId) {
    const [[row]] = await db.execute('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
    return Number(row.total);
}

async function list(userId, page = 1, pageSize = 20) {
    const [[row]] = await db.execute('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?', [userId]);
    const pages = Math.max(1, Math.ceil(Number(row.total) / pageSize));
    page = Math.min(page, pages);
    const [items] = await db.execute(
        'SELECT id, type, text, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
        [userId, pageSize, (page - 1) * pageSize]
    );
    return { items, page, pages };
}

async function read(userId, id) {
    const [rows] = await db.execute('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
    if (!rows.length) return false;
    await db.execute('UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND user_id = ?', [id, userId]);
    return true;
}

async function readAll(userId, upTo) {
    await db.execute('UPDATE notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND id <= ? AND read_at IS NULL', [userId, upTo]);
}

async function target(userId, id) {
    const [rows] = await db.execute('SELECT link FROM notifications WHERE user_id = ? AND id = ?', [userId, id]);
    return rows[0]?.link || null;
}

async function insertEvent(connection, userId, eventKey, text, link) {
    await connection.execute(
        `INSERT INTO notifications (user_id, event_key, type, text, link)
         VALUES (?, ?, 'deal', ?, ?) ON DUPLICATE KEY UPDATE id = id`,
        [userId, eventKey, text, link]
    );
}

function insertDealEvent(connection, userId, dealId, event, text) {
    return insertEvent(connection, userId, `deal:${dealId}:${event}`, text, `/deals/${dealId}`);
}

function insertDisputeEvent(connection, userId, disputeId, entryId, text) {
    return insertEvent(connection, userId, `dispute:${disputeId}:${entryId}`, text, `/disputes/${disputeId}`);
}

module.exports = { count, list, read, readAll, target, insertDealEvent, insertDisputeEvent };
