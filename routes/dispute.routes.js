const router = require('express').Router();
const controller = require('../controllers/dispute.controller');
const deals = require('../models/deal.model');
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const upload = require('../middleware/uploadDispute');
const { createPhoneLimiter } = require('../middleware/phoneRateLimit');
const logError = require('../services/logError');

function privateResponse(_req, res, next) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
}

const handle = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (error) {
        if (error.status >= 400 && error.status < 500 || error.status === 503) return res.status(error.status).send(error.message);
        if (['ER_DUP_ENTRY','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            return res.status(409).send('Спор изменился. Обновите страницу и повторите действие.');
        }
        logError('Ошибка обработки спора:', error);
        res.status(500).send('Действие по спору не выполнено. Повторите попытку позже.');
    }
};

const rate = limit => createPhoneLimiter({ limit, keyFor: req => String(req.session.user.id) });
async function participant(req, res, next) {
    const id = controller.positive(req.params.id);
    if (!id || !await deals.findParticipantDeal(id, req.session.user.id)) return res.status(404).send('Сделка не найдена.');
    req.dealId = id;
    next();
}

router.post('/deals/:id/disputes', privateResponse, auth, csrf, rate(10), handle(participant), handle(upload(controller.open)));
router.get('/disputes/:id', privateResponse, auth, handle(controller.show));
router.get('/disputes/:id/images/:position', privateResponse, auth, rate(120), handle(controller.image));
router.post('/disputes/:id/reply', privateResponse, auth, csrf, rate(30), handle(controller.reply));

module.exports = router;
