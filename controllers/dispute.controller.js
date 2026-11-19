const { randomUUID } = require('node:crypto');
const model = require('../models/dispute.model');
const { flash } = require('../middleware/toasts');
const { reasons, statuses, actions } = require('../services/disputeView');

function positive(value) {
    return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295 ? Number(value) : null;
}

function fields(req, max) {
    const { request_key: key, body } = req.body || {};
    if (typeof key === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(key) &&
        typeof body === 'string' && body.trim() && body.trim().length <= max) {
        return { key: key.toLowerCase(), body: body.trim() };
    }
    throw Object.assign(new Error('Введите сообщение до ' + max + ' символов и повторите действие.'), { status: 400 });
}

async function open(req, res, images) {
    const reason = req.body?.reason;
    if (typeof reason !== 'string' || !Object.hasOwn(reasons, reason)) return res.status(400).send('Выберите причину спора.');
    const { key, body } = fields(req, 2000);
    const id = await model.open(req.dealId, Number(req.session.user.id), key, reason, body, images);
    flash(req, 'success', 'Спор открыт');
    const redirect = '/disputes/' + id;
    if (req.get('Accept')?.includes('application/json')) return res.status(201).json({ redirect });
    res.redirect(303, redirect);
}

async function show(req, res) {
    const id = positive(req.params.id);
    const actor = Number(req.session.user.id);
    const dispute = id && await model.findVisible(id, actor);
    if (!dispute) return res.status(404).send('Спор не найден.');
    const participant = [dispute.buyer_id, dispute.seller_id].some(party => Number(party) === actor);
    const active = model.openStatuses.includes(dispute.status);
    const history = await model.history(id, positive(req.query.page));
    res.render('pages/dispute-show', {
        dispute, ...history, reasons, statuses, actions,
        replyKey: active && participant ? randomUUID() : null,
        decisionKey: active && dispute.role === 'admin' ? randomUUID() : null
    });
}

async function image(req, res) {
    const id = positive(req.params.id);
    const position = positive(req.params.position);
    const bytes = id && position && position <= 5 && await model.image(id, position, req.session.user.id);
    if (!bytes) return res.status(404).end();
    res.set('X-Content-Type-Options', 'nosniff').type('image/webp').send(bytes);
}

async function reply(req, res) {
    const id = positive(req.params.id);
    if (!id) return res.status(404).send('Спор не найден.');
    const { key, body } = fields(req, 2000);
    await model.reply(id, Number(req.session.user.id), key, body);
    flash(req, 'success', 'Сообщение добавлено к спору');
    res.redirect(303, '/disputes/' + id);
}

async function queue(req, res) {
    const { status, reason } = req.query;
    const filters = {
        status: status === 'all' || (typeof status === 'string' && Object.hasOwn(statuses, status)) ? status : 'active',
        reason: typeof reason === 'string' && Object.hasOwn(reasons, reason) ? reason : null,
        dealId: positive(req.query.deal)
    };
    const result = await model.queue(filters, positive(req.query.page) || 1);
    res.render('admin/disputes', { ...result, filters, reasons, statuses, section: 'disputes' });
}

async function decide(req, res) {
    const id = positive(req.params.id);
    if (!id) return res.status(404).send('Спор не найден.');
    const { action, version } = req.body || {};
    const revision = positive(version);
    if (!['request_info', 'resolve', 'reject'].includes(action) || !revision) return res.status(400).send('Обновите страницу спора.');
    const { key, body } = fields(req, 500);
    await model.decide(id, Number(req.session.user.id), key, revision, action, body);
    flash(req, 'success', 'Действие по спору сохранено');
    res.redirect(303, '/disputes/' + id);
}

module.exports = { positive, open, show, image, reply, queue, decide };
