const logError = require('../services/logError');
const db = require('../config/db');
const listingModel = require('../models/listing.model');
const userModel = require('../models/user.model');
const { flash } = require('../middleware/toasts');
// Личный кабинет пользователя
async function index(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
        const [rows] = await db.execute(
            `SELECT id, name, email, role, phone, phone_public, phone_verified_at, created_at, save_listing_history
             FROM users
             WHERE id = ? AND status = 'active'
             LIMIT 1`,
            [req.session.user.id]
        );

        // Пользователь удалён или заблокирован
        if (!rows.length) {
            return req.session.destroy((error) => {
                if (error) {
                    logError('Ошибка сессии:', error);
                    return res.status(500).send('Ошибка сервера');
                }

                res.clearCookie('euromarket.sid');
                res.redirect('/login');
            });
        }

        res.render('pages/profile', { user: rows[0] });

    } catch (error) {
        logError('Ошибка профиля:', error);
        res.status(500).send('Ошибка сервера');
    }
}

function normalizePhone(value) {
    if (typeof value === 'string' && value.trim() === '') return null;
    if (typeof value !== 'string' || value.length > 50 ||
        !/^(?:\+|00)[\d\s().-]+$/.test(value.trim())) return undefined;
    let compact = value.trim().replace(/[\s().-]/g, '');
    if (compact.startsWith('00')) compact = '+' + compact.slice(2);
    return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : undefined;
}

async function savePhone(req, res) {
    const phone = normalizePhone(req.body.phone);
    if (phone === undefined) {
        return res.status(400).send('Введите телефон в международном формате: + и от 8 до 15 цифр.');
    }
    try {
        const [users] = await db.execute(
            "SELECT id FROM users WHERE id = ? AND status = 'active'", [req.session.user.id]
        );
        if (!users.length) return res.status(403).send('Профиль недоступен.');
        if (!await userModel.updatePhone(req.session.user.id, phone, phone !== null && req.body.phone_public === '1')) {
            return res.status(403).send('Профиль недоступен.');
        }
        flash(req, 'success', 'Настройки профиля сохранены. Телефон и его публичность обновлены.');
        res.redirect(303, '/profile');
    } catch (error) {
        logError('Ошибка настроек контакта:', error);
        res.status(500).send('Не удалось сохранить настройки контакта.');
    }
}

async function saveName(req, res, next) {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).send('Введите имя длиной до 100 символов.');
    try {
        if (!await userModel.updateName(req.session.user.id, name)) return res.status(403).send('Профиль недоступен.');
        flash(req, 'success', 'Имя сохранено.');
        return res.redirect(303, '/profile');
    } catch (error) { next(error); }
}

const tabs = { all: 'Все', active: 'Активные', draft: 'Черновики', pending_review: 'На модерации', rejected: 'Отклонённые', sold: 'Проданные', archived: 'Архив' };
const sorts = { newest: 'Сначала новые', oldest: 'Сначала старые', price_asc: 'По возрастанию цены', price_desc: 'По убыванию цены' };

async function myListings(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const status = typeof req.query.status === 'string' && Object.hasOwn(tabs, req.query.status) ? req.query.status : 'all';
    const sort = typeof req.query.sort === 'string' && Object.hasOwn(sorts, req.query.sort) ? req.query.sort : 'newest';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const requested = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
    const requestedPage = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
    try {
        const result = await listingModel.getUserListings(req.session.user.id, { status, q, sort, requestedPage });
        const pageUrl = overrides => '/my-listings?' + new URLSearchParams({ status, q, sort, ...overrides });
        res.render('pages/my-listings', { ...result, tabs, sorts, status, sort, q, pageUrl,
            lifecycleKey: require('node:crypto').randomUUID });
    } catch (error) { next(error); }
}

module.exports = { index, savePhone, normalizePhone, saveName, myListings };
