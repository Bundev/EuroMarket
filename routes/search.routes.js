
const express = require('express');
const router = express.Router();

const searchController = require('../controllers/search.controller');

router.get('/search', searchController.searchPage);
router.get('/category/:slug', searchController.searchPage);

module.exports = router;
