const router = require('express').Router();
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const { flash } = require('../middleware/toasts');
const model = require('../models/negotiation.model');

function uint(value, min = 1) {
    return typeof value === 'string' && /^\d{1,10}$/.test(value) &&
        Number(value) >= min && Number(value) <= 4294967295 ? Number(value) : null;
}

function amount(value) {
    if (typeof value !== 'string' || !/^\d{1,10}(?:[.,]\d{1,2})?$/.test(value) || Number(value.replace(',', '.')) <= 0) return null;
    return value.replace(',', '.');
}

router.use('/offers', auth, (req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
});

router.get('/offers', async (req, res) => {
    const received = req.query.side === 'received';
    const offers = await model.list(req.session.user.id, received, uint(req.query.before) || 4294967296);
    const nextBefore = offers.length > 20 ? offers[19].id : null;
    res.render('pages/offers', { offers: offers.slice(0, 20), received, nextBefore });
});

router.get('/offers/:id', async (req, res) => {
    const id = uint(req.params.id);
    const result = id && await model.details(id, req.session.user.id);
    if (!result) return res.sendStatus(404);
    res.render('pages/offer', result);
});

router.post('/offers', csrf, async (req, res) => {
    const id = uint(req.body?.listing_id);
    const price = amount(req.body?.amount);
    const key = req.body?.request_key;
    const version = uint(req.body?.listing_version, 0);
    const currency = req.body?.currency;
    if (!id || !price || version === null || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
        typeof key !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(key)) return res.sendStatus(400);
    const offer = await model.start(id, req.session.user.id, price, key, version, currency);
    flash(req, 'success', 'Предложение отправлено.');
    res.redirect(303, '/offers/' + offer);
});

router.post('/offers/:id/reply', csrf, async (req, res) => {
    const id = uint(req.params.id);
    const version = uint(req.body?.version);
    const action = req.body?.action;
    const price = amount(req.body?.amount);
    if (!id || !version || !['accepted', 'declined', 'countered'].includes(action) ||
        (action === 'countered' && !price)) return res.sendStatus(400);
    await model.reply(id, req.session.user.id, version, action, price);
    flash(req, 'success', 'Ответ сохранён.');
    res.redirect(303, '/offers/' + id);
});

router.post('/offers/:id/checkout', csrf, async (req, res) => {
    const id = uint(req.params.id);
    if (!id) return res.sendStatus(400);
    const deal = await model.checkout(id, req.session.user.id);
    flash(req, 'success', 'Запрос на покупку отправлен продавцу.');
    res.redirect(303, '/deals/' + deal);
});

router.use('/offers', (error, req, res, next) => {
    if (![400, 403, 404, 409].includes(error.status)) return next(error);
    res.status(error.status).type('text').send(error.message);
});

module.exports = router;
