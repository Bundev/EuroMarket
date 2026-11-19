const deals = require('../models/deal.model');
const { flash } = require('../middleware/toasts');
const { localImage } = require('../services/seo');
const { statuses, actionState, timeline } = require('../services/dealView');
const { randomUUID } = require('node:crypto');
const disputes = require('../models/dispute.model');
const { reasons, statuses: disputeStatuses } = require('../services/disputeView');

function id(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
    const number = Number(value);
    return number <= 4294967295 ? number : null;
}

async function index(req, res) {
    res.set('Cache-Control', 'no-store');
    const side = req.query.side === 'seller' ? 'seller' : 'buyer';
    const result = await deals.list(req.session.user.id, side, id(req.query.page) || 1);
    res.render('pages/my-purchases', { ...result, side, statuses, actionState });
}

async function show(req, res) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const dealId = id(req.params.id);
    const userId = Number(req.session.user.id);
    const deal = dealId && await deals.findDetails(dealId, userId);
    if (!deal) return res.status(404).send('Сделка не найдена.');
    if (req.path.startsWith('/my-purchases/')) return res.redirect('/deals/' + dealId);
    const dispute = await disputes.latestForDeal(dealId);
    const activeDispute = dispute && disputes.openStatuses.includes(dispute.status);
    const side = Number(deal.seller_id) === userId ? 'seller' : Number(deal.buyer_id) === userId ? 'buyer' : 'admin';
    const canSeeListing = Number(deal.listing_owner_id) === userId || deal.viewer_role === 'admin' ||
        (!deal.moderation_locked && deal.listing_owner_status === 'active' &&
            (deal.listing_status === 'active' || (side === 'buyer' && deal.status === 'completed' && deal.listing_status === 'sold')));
    const { actions, available } = actionState({
        ...deal, active_dispute_id: activeDispute ? dispute.id : null,
        parties_active: deal.parties_active && Number(deal.listing_owner_id) === Number(deal.seller_id)
    }, side);
    res.render('pages/deal-show', {
        deal, side, actions, available, statusLabel: statuses[deal.status], events: timeline(deal),
        dispute, activeDispute, disputeStatuses, reasons,
        disputeKey: side !== 'admin' && !activeDispute ? randomUUID() : null,
        product: canSeeListing ? { title: deal.title, image: localImage(deal.image_path) } : null
    });
}

async function start(req, res) {
    const listingId = id(req.params.id);
    if (!listingId) return res.status(404).send('Объявление не найдено.');
    const requestKey = req.body?.purchase_request_key;
    if (typeof requestKey !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
        return res.status(400).send('Обновите страницу и повторите запрос на покупку.');
    }
    const dealId = await deals.requestPurchase(listingId, Number(req.session.user.id), requestKey.toLowerCase());
    flash(req, 'success', 'Запрос на покупку отправлен продавцу');
    res.redirect(303, '/deals/' + dealId);
}

async function change(req, res) {
    const dealId = id(req.params.id), action = req.body?.action;
    if (!dealId || !['accept', 'decline', 'confirm', 'cancel'].includes(action)) {
        return res.status(400).send('Выберите допустимое действие.');
    }
    const message = await deals.transition(dealId, Number(req.session.user.id), action);
    flash(req, 'success', message);
    res.redirect(303, '/deals/' + dealId);
}

module.exports = { index, show, start, change };
