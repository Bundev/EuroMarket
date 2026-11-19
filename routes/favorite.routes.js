const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const searchController = require('../controllers/search.controller');
const favoriteController = require('../controllers/favorite.controller');
const csrf = require('../middleware/contactCsrf');

router.get('/favorites', requireAuth, searchController.searchPage);
router.put('/api/favorites/:id', csrf, favoriteController.change);
router.delete('/api/favorites/:id', csrf, favoriteController.change);

module.exports = router;
