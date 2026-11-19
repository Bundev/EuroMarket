const db = require('../config/db');

async function unreadCount(userId) {
    const [[row]] = await db.execute(
        `SELECT COUNT(*) AS total FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE (c.buyer_id = ? OR c.seller_id = ?) AND m.sender_id <> ? AND m.read_at IS NULL`,
        [userId, userId, userId]
    );
    return Number(row.total);
}

async function start(userId, listingId) {
    const [result] = await db.execute(
        `INSERT INTO conversations (listing_id, buyer_id, seller_id, listing_title)
         SELECT l.id, ?, l.user_id, l.title FROM listings l
         JOIN users seller ON seller.id = l.user_id AND seller.status = 'active'
         JOIN users buyer ON buyer.id = ? AND buyer.status = 'active'
         WHERE l.id = ? AND l.status = 'active' AND l.moderation_locked=0 AND l.user_id <> ?
         ON DUPLICATE KEY UPDATE conversations.id = LAST_INSERT_ID(conversations.id)`,
        [userId, userId, listingId, userId]
    );
    return result.insertId || null;
}

async function getConversation(id, userId) {
    const [rows] = await db.execute(
        `SELECT c.id, c.listing_id, c.listing_title, l.status AS listing_status,
                other.name AS other_name, other.status = 'active' AS can_send
         FROM conversations c
         LEFT JOIN listings l ON l.id = c.listing_id
         JOIN users other ON other.id = CASE WHEN c.buyer_id = ? THEN c.seller_id ELSE c.buyer_id END
         WHERE c.id = ? AND (c.buyer_id = ? OR c.seller_id = ?)`,
        [userId, id, userId, userId]
    );
    return rows[0] || null;
}

async function listConversations(userId, page = 1) {
    const [[count]] = await db.execute(
        'SELECT COUNT(*) AS total FROM conversations WHERE buyer_id = ? OR seller_id = ?',
        [userId, userId]
    );
    const pages = Math.max(1, Math.ceil(Number(count.total) / 20));
    page = Math.min(page, pages);
    const [rows] = await db.execute(
        `SELECT c.id, c.listing_title, c.listing_id, l.status AS listing_status, other.name AS other_name,
             last_message.body AS last_body, last_message.created_at AS last_created_at,
             (SELECT COUNT(*) FROM messages unread WHERE unread.conversation_id = c.id
                 AND unread.sender_id <> ? AND unread.read_at IS NULL) AS unread
         FROM conversations c
         LEFT JOIN listings l ON l.id = c.listing_id
         JOIN users other ON other.id = CASE WHEN c.buyer_id = ? THEN c.seller_id ELSE c.buyer_id END
         LEFT JOIN messages last_message ON last_message.id =
             (SELECT MAX(recent.id) FROM messages recent WHERE recent.conversation_id = c.id)
         WHERE c.buyer_id = ? OR c.seller_id = ?
         ORDER BY COALESCE(last_message.id, 0) DESC, c.id DESC LIMIT ? OFFSET ?`,
        [userId, userId, userId, userId, 20, (page - 1) * 20]
    );
    return { conversations: rows, page, pages };
}

function toMessage(row, userId) {
    return {
        id: row.id, body: row.body, createdAt: row.created_at,
        readAt: row.read_at, mine: Number(row.sender_id) === Number(userId)
    };
}

// Перед вызовом контроллер проверяет участие в диалоге.
async function history(conversationId, userId, { after = null, before = null } = {}) {
    const condition = after !== null ? 'AND id > ?' : before !== null ? 'AND id < ?' : '';
    const params = [conversationId];
    if (after !== null || before !== null) params.push(after ?? before);
    const [rows] = await db.execute(
        `SELECT id, sender_id, body, created_at, read_at FROM messages
         WHERE conversation_id = ? ${condition} ORDER BY id ${after !== null ? 'ASC' : 'DESC'} LIMIT 51`,
        params
    );
    const hasMore = rows.length > 50;
    const selected = rows.slice(0, 50);
    if (after === null) selected.reverse();
    const [[receipt]] = await db.execute(
        'SELECT MAX(id) AS read_through FROM messages WHERE conversation_id = ? AND sender_id = ? AND read_at IS NOT NULL',
        [conversationId, userId]
    );
    return { messages: selected.map(row => toMessage(row, userId)), hasMore, readThrough: Number(receipt.read_through || 0) };
}

async function send(conversationId, userId, body, clientKey) {
    await db.execute(
        `INSERT INTO messages (conversation_id, sender_id, body, client_key)
         SELECT c.id, ?, ?, ? FROM conversations c
         JOIN users buyer ON buyer.id = c.buyer_id AND buyer.status = 'active'
         JOIN users seller ON seller.id = c.seller_id AND seller.status = 'active'
         WHERE c.id = ? AND (c.buyer_id = ? OR c.seller_id = ?)
         ON DUPLICATE KEY UPDATE messages.id = LAST_INSERT_ID(messages.id)`,
        [userId, body, clientKey, conversationId, userId, userId]
    );
    const [rows] = await db.execute(
        'SELECT id, sender_id, body, created_at, read_at FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_key = ?',
        [conversationId, userId, clientKey]
    );
    if (!rows.length) return null;
    if (rows[0].body !== body) return { conflict: true };
    return toMessage(rows[0], userId);
}

async function markRead(conversationId, userId, upTo) {
    await db.execute(
        `UPDATE messages m JOIN conversations c ON c.id = m.conversation_id
         SET m.read_at = CURRENT_TIMESTAMP(3)
         WHERE m.conversation_id = ? AND (c.buyer_id = ? OR c.seller_id = ?)
           AND m.sender_id <> ? AND m.id <= ? AND m.read_at IS NULL`,
        [conversationId, userId, userId, userId, upTo]
    );
}

module.exports = { unreadCount, start, getConversation, listConversations, history, send, markRead };
