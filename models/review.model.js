const db = require('../config/db');
const { findPublicById } = require('./user.model');
const transaction = require('../config/transaction');

function fail(message, status) {
    throw Object.assign(new Error(message), { status });
}

async function save(dealId, buyerId, rating, comment, editing) {
    return transaction(async connection => {
        const [[deal]] = await connection.execute(
            `SELECT seller_id, status, completed_at, buyer_confirmed_at, seller_confirmed_at
             FROM deals WHERE id=? AND buyer_id=? AND seller_id<>buyer_id FOR UPDATE`, [dealId, buyerId]
        );
        if (!deal) fail('Сделка не найдена.', 404);
        if (deal.status !== 'completed' || !deal.completed_at || !deal.buyer_confirmed_at || !deal.seller_confirmed_at) {
            fail('Отзыв доступен только после завершения сделки обеими сторонами.', 409);
        }
        if (editing) {
            const [[review]] = await connection.execute(
                `SELECT CURRENT_TIMESTAMP(3) < DATE_ADD(created_at, INTERVAL 7 DAY) AS editable
                 FROM reviews WHERE deal_id=? FOR UPDATE`, [dealId]
            );
            if (!review) fail('Отзыв не найден.', 404);
            if (!review.editable) fail('Срок редактирования отзыва истёк.', 409);
            const [result] = await connection.execute(
                `UPDATE reviews SET rating=?, comment=?, updated_at=CURRENT_TIMESTAMP(3),
                    moderation_status='pending', moderation_reason=NULL, moderation_version=moderation_version+1,
                    hidden_at=CURRENT_TIMESTAMP(3)
                 WHERE deal_id=? AND CURRENT_TIMESTAMP(3) < DATE_ADD(created_at, INTERVAL 7 DAY)`,
                [rating, comment, dealId]);
            if (!result.affectedRows) fail('Срок редактирования отзыва истёк.', 409);
            return;
        }
        const [[existing]] = await connection.execute('SELECT deal_id FROM reviews WHERE deal_id=? FOR UPDATE', [dealId]);
        if (existing) fail('По этой сделке уже есть отзыв.', 409);
        await connection.execute('INSERT INTO reviews(deal_id,rating,comment,hidden_at) VALUES (?,?,?,CURRENT_TIMESTAMP(3))',
            [dealId, rating, comment]);
    });
}

async function ratingFor(sellerId) {
    const [[rating]] = await db.execute(
        `SELECT COUNT(*) AS total, ROUND(AVG(r.rating), 2) AS average
         FROM deals d JOIN reviews r ON r.deal_id=d.id WHERE d.seller_id=? AND r.moderation_status='approved'`, [sellerId]
    );
    return { total: Number(rating.total), average: rating.average === null ? null : Number(rating.average) };
}

async function list(sellerId, requestedPage) {
    const seller = await findPublicById(sellerId);
    if (!seller) fail('Продавец не найден.', 404);
    const rating = await ratingFor(sellerId);
    const totalPages = Math.max(1, Math.ceil(rating.total / 20));
    const page = Math.min(requestedPage, totalPages);
    const [reviews] = await db.execute(
        `SELECT r.deal_id,r.rating,r.comment,r.created_at,r.updated_at,d.buyer_id,u.name AS author
         FROM deals d JOIN reviews r ON r.deal_id=d.id JOIN users u ON u.id=d.buyer_id
         WHERE d.seller_id=? AND r.moderation_status='approved' ORDER BY r.created_at DESC,r.deal_id DESC LIMIT ? OFFSET ?`,
        [sellerId, 20, (page - 1) * 20]
    );
    return { seller, rating, reviews, page, totalPages };
}

async function report(dealId, reporterId, reason) {
    return transaction(async connection => {
        const [[review]] = await connection.execute('SELECT moderation_status FROM reviews WHERE deal_id=? FOR UPDATE', [dealId]);
        if (review?.moderation_status !== 'approved') fail('Отзыв не найден.', 404);
        const [[deal]] = await connection.execute('SELECT buyer_id,seller_id FROM deals WHERE id=?', [dealId]);
        if (Number(deal.buyer_id) === Number(reporterId)) fail('Нельзя пожаловаться на собственный отзыв.', 403);
        const [[existing]] = await connection.execute(
            'SELECT reporter_id FROM review_reports WHERE deal_id=? AND reporter_id=? FOR UPDATE', [dealId, reporterId]
        );
        if (existing) fail('Вы уже отправили жалобу на этот отзыв.', 409);
        await connection.execute('INSERT INTO review_reports(deal_id,reporter_id,reason) VALUES (?,?,?)', [dealId, reporterId, reason]);
        return deal.seller_id;
    });
}

const adminSelect = `SELECT r.*, buyer.name AS author, d.buyer_id, seller.name AS seller, d.seller_id, d.listing_id, l.title AS listing_title
    FROM reviews r JOIN deals d ON d.id=r.deal_id JOIN users buyer ON buyer.id=d.buyer_id
    JOIN users seller ON seller.id=d.seller_id LEFT JOIN listings l ON l.id=d.listing_id`;

async function moderation(requestedPage, filter) {
    const [groups] = await db.query('SELECT moderation_status AS status, COUNT(*) AS total FROM reviews GROUP BY moderation_status');
    const counts = { pending: 0, all: 0, approved: 0, rejected: 0 };
    for (const group of groups) {
        counts[group.status] = Number(group.total);
        counts.all += Number(group.total);
    }
    const totalPages = Math.max(1, Math.ceil(counts[filter] / 20));
    const page = Math.min(requestedPage, totalPages);
    const options = filter === 'all' ? [] : [filter];
    const condition = options.length ? ' WHERE r.moderation_status=?' : '';
    const [reviews] = await db.execute(adminSelect + condition + ' ORDER BY r.created_at DESC,r.deal_id DESC LIMIT ? OFFSET ?',
        [...options, 20, (page - 1) * 20]);
    return { reviews, page, totalPages, counts };
}

async function moderationDetail(dealId) {
    const [[review]] = await db.execute(adminSelect + ' WHERE r.deal_id=?', [dealId]);
    if (!review) fail('Отзыв не найден.', 404);
    return review;
}

async function complaintQueue(requestedPage) {
    const [[count]] = await db.query('SELECT COUNT(DISTINCT deal_id) AS total FROM review_reports WHERE resolved_at IS NULL');
    const totalPages = Math.max(1, Math.ceil(Number(count.total) / 20));
    const page = Math.min(requestedPage, totalPages);
    const [items] = await db.execute(`SELECT deal_id,COUNT(*) AS total,MAX(created_at) AS last_report
        FROM review_reports WHERE resolved_at IS NULL GROUP BY deal_id ORDER BY last_report DESC,deal_id DESC LIMIT ? OFFSET ?`,
        [20, (page - 1) * 20]);
    return { items, page, totalPages };
}

async function complaints(dealId, requestedPage) {
    const review = await moderationDetail(dealId);
    const [[count]] = await db.execute('SELECT COUNT(*) AS total, COUNT(CASE WHEN resolved_at IS NULL THEN 1 END) AS openCount FROM review_reports WHERE deal_id=?', [dealId]);
    const totalPages = Math.max(1, Math.ceil(Number(count.total) / 20));
    const page = Math.min(requestedPage, totalPages);
    const [reports] = await db.execute(
        `SELECT p.reason,p.created_at,p.resolved_at,u.name AS author FROM review_reports p JOIN users u ON u.id=p.reporter_id
         WHERE p.deal_id=? ORDER BY p.created_at DESC,p.reporter_id DESC LIMIT ? OFFSET ?`, [dealId,20,(page-1)*20]
    );
    return { dealId, review, reports, page, totalPages, openCount: Number(count.openCount) };
}

module.exports = { save, ratingFor, list, report, moderation, moderationDetail, complaintQueue, complaints };
