const crypto = require('node:crypto');
const reviews = require('../models/review.model');
const { moderateReview } = require('../models/admin.model');
const { flash } = require('../middleware/toasts');
const seo = require('../services/seo');
const filters = { pending: 'Ожидают проверки', all: 'Все отзывы', approved: 'Одобрены', rejected: 'Отклонены' };

function id(value) {
    return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295 ? Number(value) : null;
}

async function page(req, res) {
    const sellerId = id(req.params.id);
    if (!sellerId) return res.status(404).send('Продавец не найден.');
    res.set('Cache-Control', 'no-store');
    const data = await reviews.list(sellerId, id(req.query.page) || 1);
    res.locals.pageBreadcrumbs = require('../services/breadcrumbs').trail(
        { name: data.seller.name, path: seo.sellerProfilePath(sellerId) }, { name: 'Отзывы', path: seo.sellerPath(sellerId) });
    const suffix = data.page > 1 ? ' · страница ' + data.page : '';
    seo.apply(res, {
        path: seo.pagedPath(seo.sellerPath(sellerId), data.page),
        title: 'Отзывы о продавце №' + sellerId + suffix + ' — EuroMarket',
        description: 'Публичные отзывы о продавце №' + sellerId + ' от покупателей с завершёнными сделками на EuroMarket' + suffix + '.',
        indexable: req.query.page === undefined || String(data.page) === req.query.page
    });
    res.render('pages/seller-reviews', data);
}

async function save(req, res) {
    const dealId = id(req.params.id);
    const { rating, comment = '', mode } = req.body || {};
    if (!dealId || !['create', 'edit'].includes(mode) || typeof rating !== 'string' || !/^[1-5]$/.test(rating) ||
        typeof comment !== 'string' || comment.length > 1500) {
        return res.status(400).send('Укажите от 1 до 5 звёзд и комментарий не длиннее 1500 символов.');
    }
    await reviews.save(dealId, req.session.user.id, Number(rating), comment.trim(), mode === 'edit');
    flash(req, 'success', 'Отзыв отправлен на модерацию.');
    res.redirect(303, '/my-purchases');
}

async function report(req, res) {
    const dealId = id(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!dealId || !reason || reason.length > 500) return res.status(400).send('Укажите причину жалобы длиной до 500 символов.');
    const sellerId = await reviews.report(dealId, req.session.user.id, reason);
    flash(req, 'success', 'Жалоба передана модератору.');
    res.redirect(303, '/users/' + sellerId + '/reviews');
}

async function adminPage(req, res) {
    const filter = typeof req.query.filter === 'string' && Object.hasOwn(filters, req.query.filter) ? req.query.filter : 'pending';
    const result = await reviews.moderation(id(req.query.page) || 1, filter);
    res.render('admin/reviews', { ...result, filters, filter, detail: false, requestKey: crypto.randomUUID });
}

async function adminDetail(req, res) {
    const dealId = id(req.params.id);
    if (!dealId) return res.sendStatus(404);
    res.render('admin/reviews', { reviews: [await reviews.moderationDetail(dealId)], filters, detail: true, requestKey: crypto.randomUUID });
}

async function adminComplaintQueue(req, res) {
    res.render('admin/review-report-queue', await reviews.complaintQueue(id(req.query.page) || 1));
}

async function adminComplaints(req, res) {
    const dealId = id(req.params.id);
    if (!dealId) return res.status(404).send('Отзыв не найден.');
    res.render('admin/review-reports', { ...await reviews.complaints(dealId, id(req.query.page) || 1), requestKey: crypto.randomUUID });
}

async function adminChange(req, res) {
    const dealId = id(req.params.id);
    const { mode, reason = '', request_key: key, version } = req.body || {};
    const complaint = req.path.startsWith('/admin/reports/reviews/');
    if (!dealId || !(complaint ? ['dismiss'] : ['approve', 'reject']).includes(mode) ||
        typeof version !== 'string' || !/^\d{1,10}$/.test(version) || Number(version) > 4294967295 ||
        typeof reason !== 'string' || (mode !== 'approve' && !reason.trim()) || reason.length > 500 ||
        typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) {
        return res.status(400).send('Проверьте действие и причину модерации.');
    }
    await moderateReview(Number(res.locals.admin.id), dealId, Number(version), mode, reason.trim(), key.toLowerCase());
    flash(req, 'success', { approve: 'Отзыв одобрен.', reject: 'Отзыв отклонён.', dismiss: 'Жалобы закрыты.' }[mode]);
    res.redirect(303, mode === 'dismiss' ? '/admin/reports/reviews/' + dealId : '/admin/reviews/' + dealId);
}

module.exports = { page, save, report, adminPage, adminDetail, adminComplaintQueue, adminComplaints, adminChange };
