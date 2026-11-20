const lifecycle = require('../models/listingLifecycle.model');
const { flash } = require('../middleware/toasts');

async function change(req, res) {
    const { action, ids, request_key: key } = req.body || {};
    const selected = Array.isArray(ids) ? ids : ids === undefined ? [] : [ids];
    if (!['renew', 'bump', 'archive', 'restore'].includes(action) || !selected.length || selected.length > 50 ||
        (action === 'bump' && selected.length !== 1) ||
        selected.some(id => typeof id !== 'string' || !/^[1-9]\d{0,9}$/.test(id) || Number(id) > 4294967295) ||
        typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) {
        return res.status(400).send('Выберите от 1 до 50 объявлений и допустимое действие.');
    }
    const idsToUpdate = [...new Set(selected.map(Number))].sort((a,b) => a-b);
    const result = await lifecycle.apply(req.session.user.id, action, idsToUpdate, key);
    if (result.forbidden) return res.sendStatus(403);
    if (result.conflict) return res.status(409).send('Обновите страницу и повторите действие.');
    const skipped = Object.values(result.skipped).reduce((sum, count) => sum + count, 0);
    const reasons = Object.entries(result.skipped).map(([reason, count]) => reason + ' (' + count + ')').join(', ');
    const deadline = result.deadline ? ' Новый срок до ' + result.deadline + ' (UTC).' : '';
    const review = action === 'restore' && result.done ? ' Объявления отправлены на проверку.' : '';
    flash(req, skipped ? 'warning' : 'success', `Обработано: ${result.done}. Пропущено: ${skipped}.` +
        (reasons ? ' ' + reasons + '.' : '') + deadline + review);
    res.redirect(303, '/my-listings');
}

module.exports = { change };
