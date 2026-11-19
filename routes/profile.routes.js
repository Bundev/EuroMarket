
const express = require('express');
const router = express.Router();

const profileController = require('../controllers/profile.controller');
const seller = require('../controllers/seller.controller');
const requireAuth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');

// Личный кабинет
router.get('/profile', requireAuth, profileController.index);
router.get('/my-listings', requireAuth, profileController.myListings);
router.get('/users/:id', seller.show);
router.post('/profile', csrf, requireAuth, profileController.saveName);
router.post('/profile/phone', csrf, requireAuth, profileController.savePhone);

module.exports = router;
