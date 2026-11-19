const crypto = require('node:crypto');
const db = require('../config/db');
const moderation = require('../models/listingModeration.model');
const { decideListing } = require('../models/admin.model');
const { getAllCategories } = require('../models/category.model');
const { getImagesByListingId } = require('../models/listingImage.model');
const { validateForReview } = require('../services/listingImages');
const { flash } = require('../middleware/toasts');

function id(value) {
    return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 4294967295 ? Number(value) : null;
}

async function queue(req, res) {
    const country = id(req.query.country);
    const category = id(req.query.category);
    if ((req.query.country && !country) || (req.query.category && !category)) {
        return res.status(400).send('Проверьте фильтры очереди.');
    }
    const [[countries], categories, result] = await Promise.all([
        db.query('SELECT id,name FROM countries ORDER BY name'),
        getAllCategories(),
        moderation.queue({ page: id(req.query.page) || 1, country, category })
    ]);
    res.render('admin/moderation', { ...result, countries, categories, country, category, requestKey: () => crypto.randomUUID() });
}

async function decide(req, res) {
    const listingId = id(req.params.id);
    const version = id(req.body?.version);
    const { mode, request_key: key } = req.body || {};
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!listingId || !version || !['approve','reject'].includes(mode) || reason.length > 450 ||
        (mode === 'reject' && !reason) || typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) {
        return res.status(400).send('Проверьте версию объявления и укажите причину отклонения.');
    }
    const [[listing]] = await db.execute(
        `SELECT l.status,l.review_version,l.moderation_locked,u.status AS seller_status
         FROM listings l JOIN users u ON u.id=l.user_id WHERE l.id=?`, [listingId]
    );
    let photosChecked = false;
    if (mode === 'approve' && listing?.status === 'pending_review' && Number(listing.review_version) === version &&
        !listing.moderation_locked && listing.seller_status === 'active') {
        const images = await getImagesByListingId(listingId);
        for (const image of images) {
            try { await validateForReview(image.image_path); }
            catch (error) {
                if (error.status === 400) return res.status(409).send('Фотография отсутствует или повреждена. Попросите продавца заменить её.');
                if (error.status === 503) return res.status(503).send('Проверка фотографий занята. Повторите попытку.');
                throw error;
            }
        }
        photosChecked = true;
    }
    await decideListing(Number(res.locals.admin.id), listingId, version, mode, reason || 'Проверка пройдена', key.toLowerCase(), photosChecked);
    flash(req, 'success', mode === 'approve' ? 'Объявление одобрено и опубликовано.' : 'Объявление отклонено.');
    res.redirect(303, '/admin/moderation');
}

module.exports = { queue, decide };
