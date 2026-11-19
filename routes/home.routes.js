const express = require('express');
const router = express.Router();

const homeController = require('../controllers/home.controller');

router.get('/', homeController.index);
router.get('/recommendations', homeController.feed);

module.exports = router;
