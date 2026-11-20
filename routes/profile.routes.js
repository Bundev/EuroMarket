
const express = require('express');
const router = express.Router();

const profileController = require('../controllers/profile.controller');
const seller = require('../controllers/seller.controller');
const requireAuth = require('../middleware/auth');
const csrf = require('../middleware/contactCsrf');
const trust = require('../controllers/sellerTrust.controller');
const { createPhoneLimiter } = require('../middleware/phoneRateLimit');

// Личный кабинет
router.get('/profile', requireAuth, profileController.index);
router.get('/my-listings', requireAuth, profileController.myListings);
router.post('/my-listings/lifecycle', requireAuth, csrf, require('../controllers/listingLifecycle.controller').change);
router.get('/users/:id', seller.show);
router.post('/profile', csrf, requireAuth, profileController.saveName);
router.post('/profile/phone', csrf, requireAuth, profileController.savePhone);
router.post(['/profile/phone/verification/send', '/profile/phone/verification/confirm'], requireAuth, csrf, trust.verifyPhone);
router.post('/users/:id/report', requireAuth, csrf,
    createPhoneLimiter({ limit: 5, windowMs: 3600000, keyFor: req => String(req.session.user.id) }), trust.report);

module.exports = router;
