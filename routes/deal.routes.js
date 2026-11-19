const logError = require('../services/logError');
const router = require('express').Router();
const controller = require('../controllers/deal.controller');
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const { createPhoneLimiter } = require('../middleware/phoneRateLimit');

const handle = action => async (req, res) => {
    try { await action(req, res); }
    catch (error) {
        if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).send(error.message);
        if (['ER_DUP_ENTRY', 'ER_CHECKREAD', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
            return res.status(409).send('Сделка изменилась. Обновите страницу и повторите действие.');
        }
        logError('Ошибка сделки:', error);
        res.status(500).send('Не удалось обработать сделку.');
    }
};

router.get('/my-purchases', auth, handle(controller.index));
router.get('/my-purchases/:id', auth, handle(controller.show));
router.get('/deals/:id', auth, handle(controller.show));
router.post('/listings/:id/purchase', csrf, auth,
    createPhoneLimiter({ limit: 10, windowMs: 60000, keyFor: req => String(req.session.user.id) }), handle(controller.start));
router.post(['/deals/:id', '/my-purchases/:id'], csrf, auth, handle(controller.change));
module.exports = router;
