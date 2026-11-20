const { randomUUID } = require('node:crypto');
const verification = require('../models/phoneVerification.model');
const reports = require('../models/sellerReport.model');
const { flash } = require('../middleware/toasts');

function id(value) {
    return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295 ? Number(value) : null;
}

async function verifyPhone(req, res) {
    const actor = req.session.user.id;
    const ip = req.ip || req.socket.remoteAddress;
    const sending = req.path.endsWith('/send');
    const code = req.body?.code;
    if (!sending && (typeof code !== 'string' || !/^\d{6}$/.test(code))) return res.status(400).send('Введите шесть цифр из SMS.');
    const result = sending ? await verification.sendCode(actor, ip) : await verification.confirm(actor, ip, code);
    if (typeof result === 'number') return res.set('Retry-After', String(result)).status(429).send('Слишком много попыток. Повторите позже.');
    if (result === 'unavailable') return res.status(503).send('Подтверждение по SMS сейчас недоступно.');
    if (result === 'invalid') return res.status(422).send('Не удалось подтвердить телефон. Проверьте номер и код или запросите новый код.');
    flash(req, 'success', sending ? 'Код отправлен по SMS.' : 'Телефон подтверждён.');
    res.redirect(303, '/profile#phone-verification');
}

async function report(req, res) {
    const seller = id(req.params.id);
    const author = req.session.user.id;
    const { reason, comment = '' } = req.body || {};
    if (!seller || seller === author || typeof reason !== 'string' || !Object.hasOwn(reports.reasons, reason) ||
        typeof comment !== 'string' || comment.trim().length > 1000) return res.status(400).send('Проверьте данные жалобы.');
    const result = await reports.create(author, seller, reason, comment.trim());
    if (result === 'unavailable') return res.status(404).send('Продавец недоступен.');
    if (result === 'duplicate') return res.status(409).send('Жалоба уже подана. Повторная жалоба доступна через сутки после отправки и после закрытия предыдущей.');
    flash(req, 'success', 'Жалоба отправлена модератору.');
    res.redirect(303, '/users/' + seller);
}

async function queue(req, res) {
    const status = ['accepted', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const page = id(req.query.page) || 1;
    const items = await reports.queue(status, page);
    res.render('admin/seller-reports', {
        items: items.slice(0, 20), nextPage: items.length > 20, page, status,
        reasons: reports.reasons, requestKey: randomUUID
    });
}

async function decide(req, res) {
    const reportId = id(req.params.id);
    const { status, reason, request_key: key } = req.body || {};
    if (!reportId || !['accepted', 'dismissed'].includes(status) || typeof reason !== 'string' || !reason.trim() ||
        reason.trim().length > 500 || typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) {
        return res.status(400).send('Укажите решение и его причину.');
    }
    await reports.decide(req.session.user.id, reportId, status, reason.trim(), key);
    flash(req, 'success', 'Решение по жалобе сохранено.');
    res.redirect(303, '/admin/seller-reports');
}

module.exports = { verifyPhone, report, queue, decide };
