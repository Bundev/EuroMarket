const logError = require('../services/logError');
const favoriteModel = require('../models/favorite.model');

async function change(req, res) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Войдите в аккаунт, чтобы сохранять объявления.' });
    }
    const rawId = req.params.id;
    const listingId = Number(rawId);
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(listingId)) {
        return res.status(400).json({ error: 'Некорректное объявление.' });
    }
    try {
        const userId = req.session.user.id;
        if (req.method === 'PUT') {
            const added = await favoriteModel.addFavorite(userId, listingId);
            if (!added) {
                return res.status(404).json({ error: 'Объявление больше недоступно.' });
            }
        } else {
            await favoriteModel.removeFavorite(userId, listingId);
        }
        res.json({ listingId, isFavorite: req.method === 'PUT' });
    } catch (error) {
        logError('Ошибка изменения избранного:', error);
        res.status(500).json({ error: 'Не удалось изменить избранное. Повторите попытку.' });
    }
}

module.exports = { change };
