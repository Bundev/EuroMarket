const router = require('express').Router();
const reviews = require('../controllers/review.controller');
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const { createPhoneLimiter } = require('../middleware/phoneRateLimit');

const handle = action => async (req, res, next) => {
    try { await action(req, res); }
    catch (error) {
        if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).send(error.message);
        if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_CHECKREAD'].includes(error.code)) {
            return res.status(409).send('Данные изменились. Обновите страницу и повторите действие.');
        }
        next(error);
    }
};

router.get('/users/:id/reviews', handle(reviews.page));
router.post('/my-purchases/:id/review', csrf, auth, handle(reviews.save));
router.post('/reviews/:id/report', csrf, auth, createPhoneLimiter({
    limit: 10, windowMs: 60000, keyFor: req => String(req.session.user.id)
}), handle(reviews.report));
module.exports = router;
