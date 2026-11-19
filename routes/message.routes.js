const logError = require('../services/logError');
const router = require('express').Router();
const controller = require('../controllers/message.controller');
const csrf = require('../middleware/contactCsrf');
const { createPhoneLimiter: createLimiter } = require('../middleware/phoneRateLimit');
const handle = fn => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (error) {
        logError('Ошибка переписки:', error);
        res.status(500).json({ error: 'Не удалось загрузить переписку. Повторите попытку.' });
    }
};
const authenticated = handle(controller.requireUser);
const participant = handle(controller.authorizeConversation);
const keyFor = req => String(req.session.user.id);
const startLimit = createLimiter({ limit: 10, windowMs: 60000, keyFor });
const sendLimit = createLimiter({ limit: 30, windowMs: 60000, keyFor });
router.use(['/messages', '/api/messages'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/messages', authenticated, handle(controller.inbox));
router.post('/messages/start', csrf, authenticated, startLimit, handle(controller.start));
router.get('/messages/:id', authenticated, handle(controller.conversation));
router.get('/api/messages/unread', authenticated, handle(controller.unread));
router.get('/api/messages/:id', authenticated, participant, handle(controller.history));
router.post('/api/messages/:id', csrf, authenticated, participant, sendLimit, handle(controller.send));
router.post('/api/messages/:id/read', csrf, authenticated, participant, handle(controller.read));
module.exports = router;
