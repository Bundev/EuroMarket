const crypto = require('node:crypto');
const reviews = require('../models/review.model');
const { moderateReview } = require('../models/admin.model');
const { flash } = require('../middleware/toasts');
const seo = require('../services/seo');

function id(value) {
    return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295 ? Number(value) : null;
}

async function page(req, res) {
    const sellerId = id(req.params.id);
    if (!sellerId) return res.status(404).send('Продавец не найден.');
    res.set('Cache-Control', 'no-store');
    const data = await reviews.list(sellerId, id(req.query.page) || 1);
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
    flash(req, 'success', mode === 'edit' ? 'Отзыв обновлён.' : 'Отзыв опубликован.');
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
    const complaintsOnly = req.query.filter !== 'all';
    const result = await reviews.moderation(id(req.query.page) || 1, complaintsOnly);
    res.render('admin/reviews', { ...result, complaintsOnly, requestKey: () => crypto.randomUUID() });
}

async function adminComplaints(req, res) {
    const dealId = id(req.params.id);
    if (!dealId) return res.status(404).send('Отзыв не найден.');
    res.render('admin/review-reports', await reviews.complaints(dealId, id(req.query.page) || 1));
}

async function adminChange(req, res) {
    const dealId = id(req.params.id);
    const { mode, reason, request_key: key } = req.body || {};
    if (!dealId || !['hide', 'restore', 'dismiss'].includes(mode) ||
        typeof reason !== 'string' || !reason.trim() || reason.length > 500 ||
        typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) {
        return res.status(400).send('Проверьте действие и причину модерации.');
    }
    await moderateReview(Number(res.locals.admin.id), dealId, mode, reason.trim(), key.toLowerCase());
    flash(req, 'success', { hide: 'Отзыв скрыт.', restore: 'Видимость отзыва восстановлена.', dismiss: 'Жалобы закрыты.' }[mode]);
    res.redirect(303, '/admin/reviews?filter=all');
}

module.exports = { page, save, report, adminPage, adminComplaints, adminChange };
