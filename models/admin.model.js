const db = require('../config/db');
const transaction = require('../config/transaction');
const { enqueue } = require('./publicationJob.model');

function fail(message, status = 409) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

async function paginate(select, from, params, page) {
    const [[count]] = await db.execute('SELECT COUNT(*) AS total ' + from, params);
    const pages = Math.max(1, Math.ceil(Number(count.total) / 20));
    page = Math.min(page, pages);
    const [items] = await db.execute(select + ' ' + from + ' ORDER BY id DESC LIMIT ? OFFSET ?', [...params, 20, (page - 1) * 20]);
    return { items, page, pages, total: Number(count.total) };
}

async function stats() {
    const [[row]] = await db.query(
        `SELECT (SELECT COUNT(*) FROM users) AS users,
                (SELECT COUNT(*) FROM listings) AS listings,
                (SELECT COUNT(*) FROM listings WHERE status='active') AS active,
                (SELECT COUNT(*) FROM reports WHERE status='open') AS reports`
    );
    return row;
}

async function users(search, page) {
    return paginate('SELECT id,name,email,role,status,created_at', 'FROM users WHERE name LIKE ? OR email LIKE ?', ['%' + search + '%', '%' + search + '%'], page);
}

async function user(id) {
    const [rows] = await db.execute(
        `SELECT id,name,email,role,status,block_reason,created_at,
           (SELECT COUNT(*) FROM listings WHERE user_id=users.id) AS listings_count
         FROM users WHERE id=?`, [id]
    );
    return rows[0] || null;
}

async function listings(filters, page) {
    const clauses = ['1=1'], params = [];
    for (const [key, column] of [['status', 'status'], ['country', 'country_id'], ['category', 'category_id']]) {
        if (filters[key]) { clauses.push(column + ' = ?'); params.push(filters[key]); }
    }
    if (filters.search) { clauses.push('title LIKE ?'); params.push('%' + filters.search + '%'); }
    return paginate('SELECT id,title,user_id,status,country_id,category_id,moderation_locked,moderation_reason',
        'FROM listings WHERE ' + clauses.join(' AND '), params, page);
}

async function reports(status, page) {
    return paginate(
        `SELECT r.id,r.author_id,r.listing_id,r.reason,r.comment,r.status,r.created_at,r.review_reason,
           u.name AS author_name,l.title AS listing_title`,
        'FROM reports r LEFT JOIN users u ON u.id=r.author_id LEFT JOIN listings l ON l.id=r.listing_id' + (status ? ' WHERE r.status=?' : ''),
        status ? [status] : [], page
    );
}

async function logs(page) {
    return paginate('SELECT id,admin_name,action,target_id,reason,before_state,after_state,created_at', 'FROM admin_logs', [], page);
}

async function mutate(actorId, action, targetId, reason, key, work) {
    return transaction(async connection => {
        const [admins] = await connection.execute("SELECT id,name FROM users WHERE id=? AND role='admin' AND status='active' FOR UPDATE", [actorId]);
        if (!admins.length) fail('Доступ запрещён.', 403);
        const [previous] = await connection.execute('SELECT admin_id,action,target_id,reason FROM admin_logs WHERE action_key=? FOR UPDATE', [key]);
        if (previous.length) {
            const row = previous[0];
            if (Number(row.admin_id) !== actorId || row.action !== action || Number(row.target_id) !== targetId || row.reason !== reason) fail('Повторите действие с новой страницы.');
            return;
        }
        await connection.execute('SET @euromarket_actor_user_id = ?', [actorId]);
        const { before, after } = await work(connection);
        await connection.execute(
            'INSERT INTO admin_logs(admin_id,admin_name,action_key,action,target_id,reason,before_state,after_state) VALUES (?,?,?,?,?,?,?,?)',
            [actorId, admins[0].name, key, action, targetId, reason, JSON.stringify(before), JSON.stringify(after)]
        );
    });
}

async function setUserStatus(actorId, targetId, status, reason, key) {
    if (actorId === targetId && status === 'blocked') fail('Нельзя заблокировать собственную учётную запись.', 400);
    return mutate(actorId, 'user_' + status, targetId, reason, key, async connection => {
        const [rows] = await connection.execute('SELECT status FROM users WHERE id=? FOR UPDATE', [targetId]);
        if (!rows.length) fail('Пользователь не найден.', 404);
        if (rows[0].status === status) fail('Статус пользователя уже изменён.');
        await connection.execute('UPDATE users SET status=?,block_reason=? WHERE id=?', [status, status === 'blocked' ? reason : null, targetId]);
        if (status === 'blocked') {
            await connection.execute(
                "UPDATE listings SET status='draft',moderation_locked=1,moderation_reason=? WHERE user_id=? AND status IN ('active','pending_review')",
                [('Аккаунт заблокирован: ' + reason).slice(0, 500), targetId]
            );
        }
        return { before: rows[0], after: { status } };
    });
}

async function moderateListing(actorId, listingId, mode, reason, key) {
    return mutate(actorId, 'listing_' + mode, listingId, reason, key, async connection => {
        const [rows] = await connection.execute('SELECT status,moderation_locked FROM listings WHERE id=? FOR UPDATE', [listingId]);
        if (!rows.length) fail('Объявление не найдено.', 404);
        const before = rows[0];
        if (mode === 'block') {
            if (before.moderation_locked || !['active', 'draft', 'pending_review', 'rejected'].includes(before.status)) fail('Объявление уже ограничено или недоступно.');
            await connection.execute("UPDATE listings SET status='draft',moderation_locked=1,moderation_reason=? WHERE id=?", [reason, listingId]);
        } else {
            if (!before.moderation_locked) fail('У объявления нет ограничения.');
            await connection.execute("UPDATE listings SET status='draft',moderation_locked=0,moderation_reason=NULL WHERE id=?", [listingId]);
        }
        return { before, after: { status: 'draft', moderation_locked: mode === 'block' } };
    });
}

async function decideReport(actorId, reportId, status, reason, key) {
    return mutate(actorId, 'report_' + status, reportId, reason, key, async connection => {
        const [rows] = await connection.execute('SELECT status FROM reports WHERE id=? FOR UPDATE', [reportId]);
        if (!rows.length) fail('Жалоба не найдена.', 404);
        if (rows[0].status !== 'open') fail('Жалоба уже рассмотрена.');
        await connection.execute('UPDATE reports SET status=?,reviewer_id=?,reviewed_at=CURRENT_TIMESTAMP(3),review_reason=? WHERE id=?', [status, actorId, reason, reportId]);
        return { before: rows[0], after: { status } };
    });
}

async function createReport(authorId, listingId, reason, comment) {
    const [result] = await db.execute(
        `INSERT INTO reports(author_id,listing_id,reason,comment)
         SELECT ?,l.id,?,? FROM listings l JOIN users u ON u.id=? AND u.status='active'
         WHERE l.id=? AND l.user_id<>? AND l.status='active' AND l.moderation_locked=0
         ON DUPLICATE KEY UPDATE reports.id=LAST_INSERT_ID(reports.id)`,
        [authorId, reason, comment, authorId, listingId, authorId]
    );
    return result.insertId || null;
}

async function moderateReview(actorId, dealId, mode, reason, key) {
    return mutate(actorId, 'review_' + mode, dealId, reason, key, async connection => {
        const [[review]] = await connection.execute('SELECT hidden_at FROM reviews WHERE deal_id=? FOR UPDATE', [dealId]);
        if (!review) fail('Отзыв не найден.', 404);
        if (mode === 'hide' && !review.hidden_at) {
            await connection.execute('UPDATE reviews SET hidden_at=CURRENT_TIMESTAMP(3) WHERE deal_id=?', [dealId]);
        } else if (mode === 'restore' && review.hidden_at) {
            await connection.execute('UPDATE reviews SET hidden_at=NULL WHERE deal_id=?', [dealId]);
        } else if (mode !== 'dismiss') {
            fail('Видимость отзыва уже изменилась.');
        }
        const [reports] = await connection.execute(
            'UPDATE review_reports SET resolved_at=CURRENT_TIMESTAMP(3) WHERE deal_id=? AND resolved_at IS NULL', [dealId]
        );
        if (mode === 'dismiss' && !reports.affectedRows) fail('Открытых жалоб нет.');
        const hidden = mode === 'hide' || (mode === 'dismiss' && Boolean(review.hidden_at));
        return { before: { hidden: Boolean(review.hidden_at) }, after: { hidden, resolved: reports.affectedRows } };
    });
}

async function decideListing(actorId, listingId, version, mode, reason, key, photosChecked) {
    const [[owner]] = await db.execute('SELECT user_id FROM listings WHERE id=?', [listingId]);
    if (!owner) fail('Объявление не найдено.', 404);
    return mutate(actorId, 'listing_review_' + mode + '_v' + version, listingId, reason, key, async connection => {
        const [[seller]] = await connection.execute('SELECT status FROM users WHERE id=? FOR UPDATE', [owner.user_id]);
        const [[listing]] = await connection.execute(
            'SELECT user_id,status,moderation_locked,review_version,subscription_announcement_pending FROM listings WHERE id=? FOR UPDATE', [listingId]
        );
        if (!listing || listing.user_id !== owner.user_id || listing.status !== 'pending_review' || Number(listing.review_version) !== version) {
            fail('Версия объявления изменилась. Откройте его повторно и проверьте содержимое.');
        }
        if (mode === 'approve' && (listing.moderation_locked || seller?.status !== 'active')) {
            fail('Объявление или аккаунт продавца ограничены.');
        }
        if (mode === 'approve' && !photosChecked) fail('Откройте актуальную версию объявления и повторите проверку.');
        const status = mode === 'approve' ? 'active' : 'rejected';
        await connection.execute('UPDATE listings SET status=?,review_reason=?,subscription_announcement_pending=? WHERE id=?',
            [status, mode === 'reject' ? reason : null, mode === 'reject' && Boolean(listing.subscription_announcement_pending), listingId]);
        if (mode === 'approve' && listing.subscription_announcement_pending) {
            await enqueue(connection, listingId, listing.user_id, version);
        }
        return { before: { status: listing.status, version }, after: { status, version } };
    });
}

module.exports = { stats, users, user, listings, reports, logs, mutate, setUserStatus, moderateListing, decideReport, createReport, moderateReview, decideListing };
