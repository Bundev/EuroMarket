const db = require('../config/db');
const breadcrumbs = require('../services/breadcrumbs');
const crypto = require('crypto');
const favoriteModel = require('../models/favorite.model');
const messageModel = require('../models/message.model');
const notificationModel = require('../models/notification.model');

async function pageContext(req, res, next) {
    try {
        let viewingHistoryEnabled = false;
        if (req.session.user) {
            const [users] = await db.execute('SELECT id, name, role, status, save_listing_history FROM users WHERE id = ?', [req.session.user.id]);
            if (!users.length || users[0].status !== 'active') delete req.session.user;
            else {
                req.session.user = { id: users[0].id, name: users[0].name, role: users[0].role };
                viewingHistoryEnabled = Boolean(users[0].save_listing_history);
            }
        }
        const [countries] = await db.execute(
            `SELECT id, code, name, currency
             FROM countries
             WHERE is_active = 1
             ORDER BY name`
        );
        const isValidCountry = code => code === 'all' ||
            countries.some(country => country.code === code);
        const defaultCountry = countries.some(country => country.code === 'DE') ? 'DE' : 'all';
        let selectedCountry = isValidCountry(req.session.selectedCountry)
            ? req.session.selectedCountry
            : defaultCountry;

        if (typeof req.query.country === 'string' && isValidCountry(req.query.country)) {
            selectedCountry = req.query.country;
        }
        req.session.selectedCountry = selectedCountry;
        if (!req.session.favoritesCsrfToken) {
            req.session.favoritesCsrfToken = crypto.randomBytes(32).toString('hex');
        }
        const favorites = req.session.user
            ? await favoriteModel.getUserFavorites(req.session.user.id)
            : [];

        Object.assign(res.locals, {
            pageBreadcrumbs: breadcrumbs.forRequest(req),
            user: req.session.user || null,
            viewingHistoryEnabled,
            unreadMessages: req.session.user ? await messageModel.unreadCount(req.session.user.id) : 0,
            unreadNotifications: req.session.user ? await notificationModel.count(req.session.user.id) : 0,
            countries,
            selectedCountry,
            headerSearchQuery: typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '',
            favoritesCsrfToken: req.session.favoritesCsrfToken,
            favoriteIds: new Set(favorites.map(item => Number(item.listing_id))),
            unavailableFavorites: favorites.filter(item => item.status !== 'active').length,
            selectedCountryInfo: countries.find(country => country.code === selectedCountry) || null
        });
        next();
    } catch (error) {
        next(error);
    }
}

module.exports = pageContext;
