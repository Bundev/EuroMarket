const router = require('express').Router();
const controller = require('../controllers/follow.controller');
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');

router.get('/following', auth, controller.page);
router.get('/following/feed', auth, controller.feed);
router.post('/following/settings', auth, csrf, controller.settings);
router.put('/api/following/:id', csrf, controller.change);
router.delete('/api/following/:id', csrf, controller.change);

module.exports = router;
