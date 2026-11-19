const logError = require('../services/logError');

const express = require('express');
const router = express.Router();

const cityModel = require('../models/city.model');

router.get('/api/cities', async (req, res) => {
    try {
        const countryId = Number(req.query.country_id);

        if (!Number.isSafeInteger(countryId) || countryId <= 0) {
            return res.status(400).json({
                error: 'Некорректная страна'
            });
        }

        const cities = await cityModel.getCitiesByCountry(countryId);

        res.json(cities);

    } catch (error) {
        logError('Ошибка получения городов:', error);
        res.status(500).json({
            error: 'Ошибка сервера'
        });
    }
});

module.exports = router;
