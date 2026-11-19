const logError = require('../services/logError');
const router = require('express').Router();
const controller = require('../controllers/notification.controller');
const requireUser = require('../controllers/message.controller').requireUser;
const csrf = require('../middleware/contactCsrf');
const handle = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (error) {
        logError('Ошибка уведомлений:', error);
        res.status(500).json({ error: 'Не удалось загрузить уведомления.' });
    }
};
router.use(['/notifications', '/api/notifications'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/notifications', handle(requireUser), handle(controller.page));
router.get('/notifications/:id/open', handle(requireUser), handle(controller.open));
router.get('/api/notifications', handle(requireUser), handle(controller.latest));
router.post('/api/notifications/read-all', csrf, handle(requireUser), handle(controller.readAll));
router.post('/api/notifications/:id/read', csrf, handle(requireUser), handle(controller.read));
module.exports = router;
