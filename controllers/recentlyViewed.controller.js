const history = require('../models/recentlyViewed.model');
const { searchListings } = require('../models/listing.model');
const { listingPath } = require('../services/seo');
const { flash } = require('../middleware/toasts');

function listingId(value) {
    return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295 ? Number(value) : null;
}

function pageNumber(value) {
    return typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : 1;
}

async function show(req, res) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const userId = req.session.user.id;
    const data = await searchListings({ recentViewerId: userId }, pageNumber(req.query.page));
    const hasEntries = data.total > 0 || await history.hasEntries(userId);
    res.render('pages/recently-viewed', { ...data, hasEntries, listingPath });
}

async function record(req, res) {
    const id = listingId(req.params.id);
    if (!id) return res.sendStatus(400);
    const purpose = [req.get('Purpose'), req.get('Sec-Purpose')].join(' ');
    if (!/prefetch|prerender|preview/i.test(purpose)) await history.record(req.session.user.id, id);
    res.sendStatus(204);
}

async function clear(req, res) {
    await history.remove(req.session.user.id);
    flash(req, 'success', 'История просмотров очищена.');
    res.redirect(303, '/recently-viewed');
}

async function remove(req, res) {
    const id = listingId(req.params.id);
    if (!id) return res.status(400).send('Некорректный номер объявления.');
    await history.remove(req.session.user.id, id);
    flash(req, 'success', 'Объявление удалено из истории.');
    const page = pageNumber(req.body?.page);
    res.redirect(303, '/recently-viewed' + (page > 1 ? '?page=' + page : ''));
}

async function settings(req, res) {
    const setting = req.body?.save_listing_history;
    if (!['on', 'off'].includes(setting)) return res.status(400).send('Выберите настройку истории.');
    await history.setEnabled(req.session.user.id, setting === 'on');
    flash(req, 'success', 'Настройка истории просмотров сохранена.');
    res.redirect(303, '/profile');
}

module.exports = { show, record, clear, remove, settings };
