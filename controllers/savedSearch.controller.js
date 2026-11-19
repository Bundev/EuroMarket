const model = require('../models/savedSearch.model');
const { getAllCategories } = require('../models/category.model');
const criteria = require('../services/searchFilters');
const { flash } = require('../middleware/toasts');

function id(value) {
    if (/^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n) return value;
    return null;
}

function privatePage(res) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

async function create(req, res) {
    privatePage(res);
    const parsed = await criteria.parse(req.body || {}, res.locals.countries, await getAllCategories());
    const error = parsed.locationError || parsed.filterError;
    if (error) return res.status(400).send(error);
    const filters = parsed.filters;
    if (!req.session.user) {
        req.session.pendingSavedSearch = filters;
        flash(req, 'info', 'Войдите, чтобы сохранить поиск.');
        return res.redirect(303, '/login');
    }
    const name = req.body?.name === undefined ? filters.search || 'Поиск объявлений' :
        typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).send('Введите название поиска до 100 символов.');
    const result = await model.create(req.session.user.id, name, filters);
    if (result === 'unauthorized') return res.redirect(303, '/login');
    if (result === 'limit') return res.status(409).send('Можно сохранить до 30 поисков.');
    delete req.session.pendingSavedSearch;
    flash(req, result === 'exists' ? 'info' : 'success', result === 'exists' ? 'Этот поиск уже сохранён.' : 'Поиск сохранён.');
    res.redirect(303, '/saved-searches');
}

async function page(req, res) {
    privatePage(res);
    res.render('pages/saved-searches', { searches: await model.list(req.session.user.id) });
}

function pending(req, res) {
    privatePage(res);
    const filters = req.session.pendingSavedSearch;
    if (!filters) return res.redirect('/saved-searches');
    res.render('pages/saved-searches', {
        searches: null, pendingFields: criteria.params(filters), pendingUrl: criteria.url(filters),
        pendingName: filters.search || 'Поиск объявлений'
    });
}

async function open(req, res) {
    privatePage(res);
    const searchId = id(req.params.id);
    const search = searchId && await model.find(req.session.user.id, searchId);
    if (!search) return res.status(404).send('Поиск не найден.');
    res.redirect(criteria.url(search));
}

async function change(req, res) {
    privatePage(res);
    const searchId = id(req.params.id);
    if (!searchId) return res.status(404).send('Поиск не найден.');
    const { intent, notify } = req.body || {};
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (intent !== 'delete' && (intent !== 'update' || !name || name.length > 100 || (notify !== undefined && notify !== '1'))) {
        return res.status(400).send('Проверьте название и настройку уведомлений.');
    }
    if (!await model.change(req.session.user.id, searchId, intent, name, notify === '1')) {
        return res.status(404).send('Поиск не найден.');
    }
    flash(req, 'success', intent === 'delete' ? 'Поиск удалён.' : 'Настройки поиска сохранены.');
    res.redirect(303, '/saved-searches');
}

module.exports = { create, page, pending, open, change };
