const model = require('../models/savedSearch.model');
const { getAllCategories } = require('../models/category.model');
const criteria = require('../services/searchFilters');
const { flash } = require('../middleware/toasts');
const attributes = require('../services/listingAttributes');
const { SEARCH_SORTS } = require('../models/listing.model');

function id(value) {
    if (/^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n) return value;
    return null;
}

function privatePage(res) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

async function create(req, res) {
    privatePage(res);
    const categories = await getAllCategories();
    const parsed = await criteria.parse(req.body || {}, res.locals.countries, categories);
    const error = parsed.locationError || parsed.filterError;
    if (error) return res.status(400).send(error);
    const filters = parsed.filters;
    const sort = req.body?.sort ?? 'newest';
    if (typeof sort !== 'string' || !Object.hasOwn(SEARCH_SORTS, sort) ||
        (!filters.currency && sort.startsWith('price_'))) return res.status(400).send('Проверьте сортировку и валюту.');
    filters.sort = sort;
    try {
        filters.attributeQuery = attributes.filters(attributes.fieldsFor(filters.categoryId, categories), req.body || {}).query.toString();
    } catch (error) { return res.status(400).send(error.message); }
    const editId = req.body?.saved_search_id;
    if (editId !== undefined && (typeof editId !== 'string' || !id(editId) || !req.session.user)) return res.sendStatus(404);
    if (!req.session.user) {
        req.session.pendingSavedSearch = filters;
        flash(req, 'info', 'Войдите, чтобы сохранить поиск.');
        return res.redirect(303, '/login');
    }
    const name = req.body?.name === undefined ? filters.search || 'Поиск объявлений' :
        typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).send('Введите название поиска до 100 символов.');
    const result = await model.create(req.session.user.id, name, filters, editId);
    if (result === 'missing') return res.sendStatus(404);
    if (result === 'exists' && editId) return res.status(409).send('Поиск с такими условиями уже существует.');
    if (result === 'unauthorized') return res.redirect(303, '/login');
    if (result === 'limit') return res.status(409).send('Можно сохранить до 30 поисков.');
    delete req.session.pendingSavedSearch;
    flash(req, result === 'exists' ? 'info' : 'success', result === 'exists' ? 'Этот поиск уже сохранён.' : 'Поиск сохранён.');
    res.redirect(303, '/saved-searches');
}

async function page(req, res) {
    privatePage(res);
    const [searches, categories] = await Promise.all([model.list(req.session.user.id), getAllCategories()]);
    for (const search of searches) {
        try { search.attributeLabels = attributes.labels(attributes.savedFilters(search.categoryId, categories, search.attributeQuery).constraints); }
        catch { search.attributeLabels = []; search.stale = true; }
    }
    res.render('pages/saved-searches', { searches });
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
    const url = new URL(criteria.url(search), 'http://localhost');
    if (req.query.edit === '1') url.searchParams.set('edit_saved', searchId);
    res.redirect(url.pathname + url.search);
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
