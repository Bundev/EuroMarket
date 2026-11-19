const router = require('express').Router();
const history = require('../controllers/recentlyViewed.controller');
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');

router.get('/recently-viewed', auth, history.show);
router.post('/api/recently-viewed/:id', auth, csrf, history.record);
router.post('/recently-viewed/clear', auth, csrf, history.clear);
router.post('/recently-viewed/:id/remove', auth, csrf, history.remove);
router.post('/profile/viewing-history', auth, csrf, history.settings);

module.exports = router;
