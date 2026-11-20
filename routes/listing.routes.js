
const express = require('express');
const router = express.Router();

const listingController = require('../controllers/listing.controller');
const requireAuth = require('../middleware/auth');
const uploadListing = require('../middleware/uploadListing');
const contactCsrf = require('../middleware/contactCsrf');
const phoneController = require('../controllers/phone.controller');
const { createPhoneLimiter } = require('../middleware/phoneRateLimit');

router.post('/api/listings/:id/phone', contactCsrf, createPhoneLimiter(), phoneController.reveal);

// Форма создания объявления
router.get('/listings/create', requireAuth, listingController.createPage);

// Сохранение объявления
router.post(
    '/listings',
    contactCsrf,
    requireAuth,
    uploadListing.array('images', 10),
    listingController.store
);
router.get('/listings/:id', listingController.show);
router.get('/listing/:id/:slug', listingController.show);
router.get(
    '/listings/:id/edit',
    requireAuth,
    listingController.editPage
);

router.post(
    '/listings/:id/edit',
    contactCsrf,
    requireAuth,
    uploadListing.array('images', 10, 18),
    listingController.update
);

router.post(
    '/listings/:id/images/:imageId/delete',
    contactCsrf,
    requireAuth,
    listingController.removeImage
);

router.post(
    '/listings/:id/images',
    contactCsrf,
    requireAuth,
    uploadListing.array('images', 10),
    listingController.addListingImages
);

router.post(
    '/listings/:id/publish',
    contactCsrf,
    requireAuth,
    listingController.publish
);


router.post(
    '/listings/:id/unpublish',
    contactCsrf,
    requireAuth,
    listingController.unpublish
);

router.post(
    '/listings/:id/sold',
    contactCsrf,
    requireAuth,
    listingController.markSold
);

module.exports = router;
