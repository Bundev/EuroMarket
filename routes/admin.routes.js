const logError = require('../services/logError');
const router = require('express').Router();
const controller = require('../controllers/admin.controller');
const reviews = require('../controllers/review.controller');
const listingModeration = require('../controllers/listingModeration.controller');
const disputes = require('../controllers/dispute.controller');
const requireAdmin = require('../middleware/admin');
const requireAuth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const { createPhoneLimiter } = require('../middleware/phoneRateLimit');
const handle = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (error) {
        if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).send(error.message);
        if (['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT','ER_CHECKREAD'].includes(error.code)) {
            return res.status(409).send('Объявление изменилось. Обновите страницу и повторите проверку.');
        }
        logError('Ошибка модерации:', error);
        res.status(500).send('Не удалось выполнить действие. Обновите страницу и повторите попытку.');
    }
};
router.use('/admin', (req, res, next) => req.method === 'POST' ? csrf(req, res, next) : next(), requireAdmin);
router.get('/admin', handle(controller.page));
router.get('/admin/users/:id', handle(controller.user));
router.get('/admin/moderation', handle(listingModeration.queue));
router.post('/admin/moderation/:id', handle(listingModeration.decide));
router.get('/admin/reviews', handle(reviews.adminPage));
router.get('/admin/reviews/:id/reports', handle(reviews.adminComplaints));
router.post('/admin/reviews/:id', handle(reviews.adminChange));
router.get('/admin/disputes', handle(disputes.queue));
router.post('/admin/disputes/:id', createPhoneLimiter({ limit: 30, keyFor: req => String(req.session.user.id) }), handle(disputes.decide));
for (const section of ['users', 'listings', 'reports', 'logs']) {
    router.get('/admin/' + section, (req, res, next) => {
        req.params.section = section;
        return handle(controller.page)(req, res, next);
    });
    if (section !== 'logs') {
        router.post('/admin/' + section + '/:id', (req, res, next) => {
            req.params.section = section;
            return handle(controller.change)(req, res, next);
        });
    }
}
router.post('/listings/:id/report', csrf, requireAuth, createPhoneLimiter({ limit: 5, windowMs: 60000, keyFor: req => String(req.session.user.id) }), handle(controller.report));
module.exports = router;
