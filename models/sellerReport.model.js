const db = require('../config/db');
const transaction = require('../config/transaction');
const { mutate } = require('./admin.model');

const reasons = Object.freeze({ fraud: 'Мошенничество', harassment: 'Оскорбления или угрозы', impersonation: 'Выдаёт себя за другого', other: 'Другое' });

async function create(author, seller, reason, comment) {
    return transaction(async connection => {
        const [parties] = await connection.execute(
            'SELECT id,status FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE', [author, seller]);
        if (parties.length !== 2 || parties.some(user => user.status !== 'active')) return 'unavailable';
        const [[recent]] = await connection.execute(
            `SELECT id FROM seller_reports WHERE author_id=? AND seller_id=?
             AND (status='open' OR created_at>CURRENT_TIMESTAMP(3)-INTERVAL 1 DAY) LIMIT 1`, [author, seller]);
        if (recent) return 'duplicate';
        await connection.execute('INSERT INTO seller_reports(author_id,seller_id,reason,comment) VALUES (?,?,?,?)',
            [author, seller, reason, comment]);
        return 'created';
    });
}

async function queue(status, page) {
    const [reports] = await db.execute(
        `SELECT r.id,r.seller_id,r.reason,r.comment,r.status,r.created_at,u.name AS seller_name
         FROM seller_reports r JOIN users u ON u.id=r.seller_id
         WHERE r.status=? ORDER BY r.id DESC LIMIT 21 OFFSET ?`, [status, (page - 1) * 20]);
    return reports;
}

async function decide(actor, id, status, reason, key) {
    return mutate(actor, 'seller_report_' + status, id, reason, key, async connection => {
        const [[row]] = await connection.execute('SELECT status FROM seller_reports WHERE id=? FOR UPDATE', [id]);
        if (!row || row.status !== 'open') throw Object.assign(new Error('Жалоба уже закрыта или недоступна.'), { status: 409 });
        await connection.execute('UPDATE seller_reports SET status=?,reviewer_id=?,reviewed_at=CURRENT_TIMESTAMP(3) WHERE id=?',
            [status, actor, id]);
        return { before: { status: row.status }, after: { status } };
    });
}

module.exports = { create, queue, decide, reasons };
