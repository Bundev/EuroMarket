
const express = require('express');
const router = express.Router();

const authController = require('../controllers/auth.controller');
const protection = require('../services/authSecurity').getAuthSecurity();
const csrf = require('../middleware/contactCsrf');

router.get('/register', authController.registerPage);
router.post('/register', csrf, protection.register, authController.register);

router.get('/login', authController.loginPage);
router.post('/login', csrf, protection.login, authController.login);

router.post('/logout', csrf, authController.logout);

module.exports = router;
