const model = require('../models/notification.model');
const messages = require('../models/message.model');
const listings = require('../models/listing.model');
const deals = require('../models/deal.model');
const disputes = require('../models/dispute.model');

function parseId(value) {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

async function page(req, res) {
    res.render('pages/notifications', await model.list(req.session.user.id, parseId(req.query.page) || 1));
}

async function latest(req, res) {
    const result = await model.list(req.session.user.id, 1, 5);
    res.json({ items: result.items, unread: await model.count(req.session.user.id) });
}

async function read(req, res) {
    const id = parseId(req.params.id);
    if (!id || !await model.read(req.session.user.id, id)) return res.status(404).json({ error: 'Уведомление не найдено.' });
    res.json({ unread: await model.count(req.session.user.id) });
}

async function readAll(req, res) {
    const value = req.body?.up_to;
    const id = typeof value === 'number' || typeof value === 'string' ? parseId(String(value)) : null;
    if (!id) return res.status(400).json({ error: 'Обновите список уведомлений.' });
    await model.readAll(req.session.user.id, id);
    res.json({ unread: await model.count(req.session.user.id) });
}

async function open(req, res) {
    const id = parseId(req.params.id);
    const link = id && await model.target(req.session.user.id, id);
    let permitted = false;
    if (link === '/my-listings') permitted = true;
    const chat = link && /^\/messages\/([1-9]\d*)$/.exec(link);
    const listing = link && /^\/listings\/([1-9]\d*)$/.exec(link);
    const reviews = link && /^\/users\/([1-9]\d*)\/reviews$/.exec(link);
    const deal = link && /^\/(?:deals|my-purchases)\/([1-9]\d{0,9})$/.exec(link);
    const dispute = link && /^\/disputes\/([1-9]\d{0,9})$/.exec(link);
    const offer = link && /^\/offers\/([1-9]\d{0,9})$/.exec(link);
    if (offer && Number(offer[1]) <= 4294967295) {
        permitted = Boolean(await require('../models/negotiation.model').details(Number(offer[1]), req.session.user.id));
    }
    if (dispute && Number(dispute[1]) <= 4294967295) {
        permitted = Boolean(await disputes.findVisible(Number(dispute[1]), req.session.user.id, false));
    }
    if (deal && Number(deal[1]) <= 4294967295) {
        permitted = Boolean(await deals.findParticipantDeal(Number(deal[1]), req.session.user.id));
    }
    if (reviews) permitted = Number(reviews[1]) === Number(req.session.user.id);
    if (chat) permitted = Boolean(await messages.getConversation(Number(chat[1]), req.session.user.id));
    if (listing) {
        const row = await listings.getListingById(Number(listing[1]));
        permitted = row && ((row.status === 'active' && !row.is_expired && !row.moderation_locked && row.seller_status === 'active') ||
            Number(row.user_id) === Number(req.session.user.id));
    }
    if (!permitted) return res.status(404).send('Уведомление или связанная страница больше недоступны.');
    res.redirect(deal ? '/deals/' + deal[1] : link);
}

module.exports = { page, latest, read, readAll, open };
