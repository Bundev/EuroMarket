const db = require('../config/db');
const transaction = require('../config/transaction');
const { mutate } = require('./admin.model');
const { insertDisputeEvent } = require('./notification.model');

const openStatuses = ['open', 'info_requested'];
const decisions = { request_info: 'info_requested', resolve: 'resolved', reject: 'rejected' };
const notices = {
    opened: 'Открыт спор по сделке',
    request_info: 'Администратор запросил дополнительную информацию по спору',
    resolve: 'Администратор вынес решение по спору',
    reject: 'Администратор отклонил спор'
};

function fail(message, status = 409) {
    throw Object.assign(new Error(message), { status });
}

async function latestForDeal(dealId) {
    const [[row]] = await db.execute(
        'SELECT id,status FROM deal_disputes WHERE deal_id=? ORDER BY (open_deal_id IS NOT NULL) DESC, id DESC LIMIT 1',
        [dealId]
    );
    return row;
}

async function openCount() {
    const [[row]] = await db.query("SELECT COUNT(*) AS total FROM deal_disputes WHERE status IN ('open','info_requested')");
    return Number(row.total);
}

async function findVisible(id, actor, allowAdmin = true) {
    const [[row]] = await db.execute(
        `SELECT s.id,s.deal_id,s.reason,s.status,s.version,s.created_at,
                d.buyer_id,d.seller_id,viewer.role
         FROM deal_disputes s JOIN deals d ON d.id=s.deal_id
         JOIN users viewer ON viewer.id=? AND viewer.status='active'
         WHERE s.id=? AND (viewer.id IN (d.buyer_id,d.seller_id) OR (? AND viewer.role='admin'))`,
        [actor, id, allowAdmin]
    );
    return row;
}

async function image(id, position, actor) {
    const [[row]] = await db.execute(
        `SELECT i.image_data FROM deal_dispute_images i
         JOIN deal_disputes s ON s.id=i.dispute_id JOIN deals d ON d.id=s.deal_id
         JOIN users viewer ON viewer.id=? AND viewer.status='active'
         WHERE i.dispute_id=? AND i.position=? AND (viewer.id IN (d.buyer_id,d.seller_id) OR viewer.role='admin')`,
        [actor, id, position]
    );
    return row?.image_data;
}

async function history(id, page) {
    const [[count]] = await db.execute('SELECT COUNT(*) AS total FROM deal_dispute_entries WHERE dispute_id=?', [id]);
    const pages = Math.max(1, Math.ceil(Number(count.total) / 25));
    page = Math.min(page || pages, pages);
    const [items] = await db.execute(
        `SELECT e.action,e.body,e.created_at,u.name AS actor_name
         FROM deal_dispute_entries e JOIN users u ON u.id=e.actor_id
         WHERE e.dispute_id=? ORDER BY e.id LIMIT 25 OFFSET ?`, [id, (page - 1) * 25]
    );
    const [images] = await db.execute('SELECT position FROM deal_dispute_images WHERE dispute_id=? ORDER BY position', [id]);
    return { items, images, page, pages };
}

async function queue({ status, reason, dealId }, page) {
    const from = `FROM deal_disputes s WHERE
        (? <> 'active' OR s.open_deal_id IS NOT NULL)
        AND (? IS NULL OR s.status=?) AND (? IS NULL OR s.reason=?)
        AND (? IS NULL OR s.deal_id=?)`;
    const exact = status === 'active' ? null : status;
    const params = [status, exact, exact, reason, reason, dealId, dealId];
    const [[count]] = await db.execute('SELECT COUNT(*) AS total ' + from, params);
    const pages = Math.max(1, Math.ceil(Number(count.total) / 20));
    page = Math.min(page, pages);
    const [items] = await db.execute('SELECT s.id,s.deal_id,s.reason,s.status,s.created_at ' + from +
        ' ORDER BY s.id DESC LIMIT 20 OFFSET ?', [...params, (page - 1) * 20]);
    return { items, page, pages };
}

async function append(connection, disputeId, actor, key, action, body, parties) {
    const [entry] = await connection.execute(
        'INSERT INTO deal_dispute_entries(dispute_id,actor_id,request_key,action,body) VALUES (?,?,?,?,?)',
        [disputeId, actor, key, action, body]
    );
    if (parties) {
        const text = notices[action] + ' №' + parties.deal_id;
        for (const recipient of [parties.buyer_id, parties.seller_id]) {
            await insertDisputeEvent(connection, recipient, disputeId, entry.insertId, text);
        }
    }
}

async function open(dealId, actor, key, reason, body, images) {
    const [[parties]] = await db.execute(
        'SELECT id AS deal_id,buyer_id,seller_id FROM deals WHERE id=? AND (buyer_id=? OR seller_id=?)',
        [dealId, actor, actor]
    );
    if (!parties) fail('Сделка не найдена.', 404);
    return transaction(async connection => {
        const [users] = await connection.execute('SELECT id,status FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE',
            [parties.buyer_id, parties.seller_id]);
        if (!users.some(user => Number(user.id) === actor && user.status === 'active')) fail('Доступ запрещён.', 403);
        const [[deal]] = await connection.execute('SELECT id FROM deals WHERE id=? FOR UPDATE', [dealId]);
        if (!deal) fail('Сделка не найдена.', 404);
        const [[prior]] = await connection.execute(
            'SELECT id FROM deal_disputes WHERE deal_id=? AND opened_by=? AND opening_key=?', [dealId, actor, key]);
        if (prior) return prior.id;
        const [[existing]] = await connection.execute('SELECT id FROM deal_disputes WHERE open_deal_id=?', [dealId]);
        if (existing) fail('По этой сделке уже открыт спор.');
        const [dispute] = await connection.execute(
            'INSERT INTO deal_disputes(deal_id,opened_by,opening_key,reason) VALUES (?,?,?,?)', [dealId, actor, key, reason]);
        for (const [index, bytes] of images.entries()) {
            await connection.execute('INSERT INTO deal_dispute_images(dispute_id,position,image_data) VALUES (?,?,?)',
                [dispute.insertId, index + 1, bytes]);
        }
        await append(connection, dispute.insertId, actor, key, 'opened', body, parties);
        return dispute.insertId;
    });
}

async function reply(id, actor, key, body) {
    const dispute = await findVisible(id, actor, false);
    if (!dispute) fail('Спор не найден.', 404);
    return transaction(async connection => {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE", [actor]);
        if (!user) fail('Доступ запрещён.', 403);
        const [[current]] = await connection.execute('SELECT status FROM deal_disputes WHERE id=? FOR UPDATE', [id]);
        const [[prior]] = await connection.execute(
            'SELECT action,body FROM deal_dispute_entries WHERE dispute_id=? AND actor_id=? AND request_key=?', [id, actor, key]);
        if (prior?.action === 'reply' && prior.body === body) return;
        if (prior) fail('Обновите страницу и повторите действие.');
        if (!current || !openStatuses.includes(current.status)) fail('Спор уже закрыт.');
        await append(connection, id, actor, key, 'reply', body);
        await connection.execute('UPDATE deal_disputes SET version=version+1 WHERE id=?', [id]);
    });
}

async function decide(id, actor, key, version, action, body) {
    const dispute = await findVisible(id, actor);
    if (!dispute) fail('Спор не найден.', 404);
    return mutate(actor, 'dispute_' + action, id, body, key, async connection => {
        const [[current]] = await connection.execute('SELECT status,version FROM deal_disputes WHERE id=? FOR UPDATE', [id]);
        if (!current || !openStatuses.includes(current.status) || current.version !== version) {
            fail('Спор изменился. Обновите страницу перед принятием решения.');
        }
        const status = decisions[action];
        await connection.execute('UPDATE deal_disputes SET status=?,version=version+1 WHERE id=?', [status, id]);
        await append(connection, id, actor, key, action, body, dispute);
        return { before: { status: current.status }, after: { status } };
    });
}

module.exports = { openStatuses, openCount, latestForDeal, findVisible, image, history, queue, open, reply, decide };
