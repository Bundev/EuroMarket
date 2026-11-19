const model = require('../models/follow.model');
const { flash } = require('../middleware/toasts');
const logError = require('../services/logError');
const { searchListings } = require('../models/listing.model');
const { listingPath } = require('../services/seo');

const feedPath = '/following/feed';
const feedSorts = Object.freeze({
    newest: 'Сначала новые',
    price_asc: 'Сначала дешевле',
    price_desc: 'Сначала дороже'
});

function requestedPage(input) {
    const number = typeof input === 'string' && /^[1-9]\d*$/.test(input) ? Number(input) : 1;
    return Number.isSafeInteger(number) ? number : 1;
}

async function change(req, res) {
    const actor = Number(req.session.user?.id);
    if (!actor) return res.status(401).json({ error: 'Войдите в аккаунт, чтобы управлять подписками.' });
    const sellerId = Number(req.params.id);
    if (!/^[1-9]\d{0,9}$/.test(req.params.id) || sellerId > 4294967295) {
        return res.status(400).json({ error: 'Некорректный профиль продавца.' });
    }
    try {
        await model.change(sellerId, actor, req.method === 'PUT');
        res.json(await model.summary(sellerId, actor));
    } catch (error) {
        if ([400, 401, 404].includes(error.status)) return res.status(error.status).json({ error: error.message });
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            return res.status(409).json({ error: 'Повторите действие.' });
        }
        logError('Ошибка изменения подписки:', error);
        res.status(500).json({ error: 'Не удалось изменить подписку.' });
    }
}

async function page(req, res) {
    res.set('Cache-Control', 'private, no-store');
    const result = await model.list(req.session.user.id, requestedPage(req.query.page));
    if (!result) return res.redirect('/login');
    res.render('pages/following', result);
}

async function feed(req, res) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const followerId = req.session.user.id;
    const country = res.locals.selectedCountryInfo;
    const sortInput = req.query.sort;
    const sort = typeof sortInput === 'string' && Object.hasOwn(feedSorts, sortInput) ? sortInput : 'newest';
    const result = await searchListings({ followerId, countryId: country?.id, sort }, requestedPage(req.query.page));
    const hasFollows = result.total > 0 || await model.hasActiveFollows(followerId);
    const linkTo = page => {
        const query = new URLSearchParams();
        if (sort !== 'newest') query.set('sort', sort);
        if (page > 1) query.set('page', page);
        return query.size ? feedPath + '?' + query : feedPath;
    };
    res.render('pages/following-feed', {
        ...result, hasFollows, sort, sorts: feedSorts, feedPath, linkTo, listingPath,
        headerCountryAction: feedPath, headerCountrySort: sort === 'newest' ? '' : sort
    });
}

async function settings(req, res) {
    const value = req.body?.notify_followed_sellers;
    if (!['on', 'off'].includes(value)) return res.status(400).send('Выберите настройку уведомлений.');
    await model.setNotifications(req.session.user.id, value === 'on');
    flash(req, 'success', value === 'on' ? 'Уведомления о новых объявлениях включены' : 'Уведомления о новых объявлениях отключены');
    res.redirect(303, '/following');
}

module.exports = { change, page, feed, settings };
