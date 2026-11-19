const router = require('express').Router();
const protection = require('../services/authSecurity').getAuthSecurity();
// Budgets are checked before session storage and pageContext DB queries.
const csrf = require('./contactCsrf');
router.post('/login', csrf, protection.login);
router.post('/register', csrf, protection.register);
module.exports = router;
