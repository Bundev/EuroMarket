const logError = require('../services/logError');
const listingModel = require('../models/listing.model');

async function reveal(req, res) {
    const rawId = req.params.id;
    const id = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) {
        return res.status(404).json({ error: 'Телефон недоступен.' });
    }
    try {
        const phone = await listingModel.getPublicPhone(id);
        if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
            return res.status(404).json({ error: 'Телефон недоступен.' });
        }
        res.json({ phone });
    } catch (error) {
        logError('Ошибка получения контакта:', error);
        res.status(500).json({ error: 'Не удалось загрузить контакт.' });
    }
}

module.exports = { reveal };
