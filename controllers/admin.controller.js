const crypto = require('crypto');
const model = require('../models/admin.model');
const categoryModel = require('../models/category.model');
const reasons = require('../config/reportReasons');
const { flash } = require('../middleware/toasts');

function id(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n <= 4294967295 ? n : null;
}
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function invalid(res) { return res.status(400).send('Проверьте параметры запроса.'); }

async function page(req, res) {
    const section = req.params.section || 'dashboard';
    const page = id(req.query.page) || 1;
    const query = new URLSearchParams();
    let data;
    if (section === 'dashboard') data = { stats: res.locals.adminCounts };
    else if (section === 'users') {
        const search = text(req.query.search, 100);
        query.set('search', search);
        data = { ...await model.users(search, page), search };
    } else if (section === 'listings') {
        const status = text(req.query.status, 20), country = req.query.country || '', category = req.query.category || '';
        if ((status && !['draft','active','sold','archived','pending_review','rejected'].includes(status)) || (country && !id(country)) || (category && !id(category))) return invalid(res);
        const filters = { status, country, category, search: text(req.query.search, 100) };
        for (const [key, value] of Object.entries(filters)) query.set(key, value);
        data = { ...await model.listings(filters, page), filters, categories: await categoryModel.getAllCategories() };
    } else if (section === 'reports') {
        const status = text(req.query.status, 20);
        if (status && !['open','accepted','rejected'].includes(status)) return invalid(res);
        query.set('status', status);
        data = { ...await model.reports(status, page), status, reasons };
    } else data = await model.logs(page);
    res.render('admin/panel', {
        section, data, requestKey: () => crypto.randomUUID(),
        pageUrl: number => { const params = new URLSearchParams(query); params.set('page', number); return '/admin/' + section + '?' + params; }
    });
}

async function user(req, res) {
    const userId = id(req.params.id), row = userId && await model.user(userId);
    if (!row) return res.status(404).send('Пользователь не найден.');
    res.render('admin/user', { profile: row, requestKey: crypto.randomUUID() });
}

async function change(req, res) {
    const target = id(req.params.id), reason = req.body?.reason, key = req.body?.request_key;
    if (!target || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500 ||
        typeof key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)) return invalid(res);
    const actor = Number(res.locals.admin.id);
    if (req.params.section === 'users') {
        if (!['active','blocked'].includes(req.body.status)) return invalid(res);
        await model.setUserStatus(actor, target, req.body.status, reason.trim(), key.toLowerCase());
        flash(req, 'success', req.body.status === 'blocked' ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.');
        return res.redirect(303, '/admin/users/' + target);
    }
    if (req.params.section === 'listings') {
        if (!['block','unblock'].includes(req.body.mode)) return invalid(res);
        await model.moderateListing(actor, target, req.body.mode, reason.trim(), key.toLowerCase());
        flash(req, 'success', req.body.mode === 'block' ? 'Объявление снято с публикации.' : 'Ограничение публикации снято.');
    } else {
        if (!['accepted','rejected'].includes(req.body.status)) return invalid(res);
        await model.decideReport(actor, target, req.body.status, reason.trim(), key.toLowerCase());
        flash(req, 'success', 'Жалоба обработана.');
    }
    res.redirect(303, '/admin/' + req.params.section);
}

async function report(req, res) {
    const listing = id(req.params.id), reason = req.body?.reason, comment = req.body?.comment ?? '';
    if (!listing || typeof reason !== 'string' || !Object.hasOwn(reasons, reason) || typeof comment !== 'string' || comment.trim().length > 1000) return invalid(res);
    const created = await model.createReport(req.session.user.id, listing, reason, comment.trim());
    if (!created) return res.status(404).send('Объявление недоступно или принадлежит вам.');
    flash(req, 'success', 'Жалоба передана на рассмотрение.');
    res.redirect(303, '/listings/' + listing);
}

module.exports = { page, user, change, report };
