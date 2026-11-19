const router = require('express').Router();
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const tools = require('../models/marketplaceTools.model');
const { listingPath } = require('../services/seo');
const { flash } = require('../middleware/toasts');

function listingId(input) {
    return /^[1-9]\d{0,9}$/.test(input) && Number(input) <= 4294967295 ? Number(input) : null;
}

function privatePage(res) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

router.get('/compare', async (req, res) => {
    privatePage(res);
    const ids = typeof req.query.ids === 'string' && req.query.ids.length <= 43
        ? [...new Set(req.query.ids.split(',').map(listingId).filter(Boolean))].slice(0, 4) : [];
    const listings = await tools.comparison(ids);
    res.render('pages/compare', { listings, listingPath, hasSelection: ids.length > 0 });
});

router.get('/seller-stats', auth, async (req, res) => {
    privatePage(res);
    const page = typeof req.query.page === 'string' && /^[1-9]\d{0,8}$/.test(req.query.page) ? Number(req.query.page) : 1;
    res.render('pages/seller-stats', await tools.sellerStats(req.session.user.id, page));
});

router.post('/api/listing-views/:id', csrf, async (req, res) => {
    const id = listingId(req.params.id);
    if (!id) return res.sendStatus(400);
    if (/prefetch|prerender|preview/i.test([req.get('Purpose'), req.get('Sec-Purpose')].join(' '))) return res.sendStatus(204);
    const seen = req.session.countedListingViews || [];
    if (!seen.includes(id) && await tools.recordView(id, req.session.user?.id)) {
        req.session.countedListingViews = [...seen.slice(-99), id];
    }
    res.sendStatus(204);
});

router.post('/listings/:id/price-alert', auth, csrf, async (req, res) => {
    const id = listingId(req.params.id);
    const setting = req.body?.enabled;
    if (!id || !['yes', 'no'].includes(setting)) return res.sendStatus(400);
    if (!await tools.setPriceAlert(id, req.session.user.id, setting === 'yes')) return res.sendStatus(404);
    flash(req, 'success', 'Настройка уведомлений о цене сохранена.');
    res.redirect(303, '/listings/' + id);
});

module.exports = router;
