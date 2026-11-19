const router = require('express').Router();
const saved = require('../controllers/savedSearch.controller');
const auth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');

router.get('/saved-searches', auth, saved.page);
router.get('/saved-searches/new', auth, saved.pending);
router.get('/saved-searches/:id/open', auth, saved.open);
router.post('/saved-searches', csrf, saved.create);
router.post('/saved-searches/:id', auth, csrf, saved.change);

module.exports = router;
