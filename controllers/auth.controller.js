const logError = require('../services/logError');

const { getAuthSecurity, normalizedEmail } = require('../services/authSecurity');
const { flash, browserRequest } = require('../middleware/toasts');
const {
    createUser,
    findByEmail,
    verifyPassword
} = require('../models/user.model');
const registrationResponse = 'Если адрес доступен для регистрации, аккаунт создан. <a href="/login">Перейти ко входу</a>';
function registered(req, res) {
    if (!browserRequest(req)) return res.status(201).send(registrationResponse);
    flash(req, 'success', 'Если адрес доступен для регистрации, аккаунт создан. Теперь можно войти.');
    return res.redirect(303, '/login');
}

// Страница регистрации
function registerPage(req, res) {
    res.set('Cache-Control', 'no-store');
    res.render('pages/register');
}

// Регистрация пользователя
async function register(req, res) {
    try {
        const { name, email, password } = req.body || {};

        if (
            typeof name !== 'string' ||
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !name.trim() ||
            name.trim().length > 100 ||
            email.length > 255 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            return res.status(400).send('Некорректные данные регистрации');
        }

        await createUser({ name, email, password });

        registered(req, res);
    } catch (error) {
        if (
            error.message === 'EMAIL_EXISTS' ||
            error.code === 'ER_DUP_ENTRY'
        ) {
            return registered(req, res);
        }
        getAuthSecurity().respond(res, error);
    }
}

// Страница входа
function loginPage(req, res) {
    res.set('Cache-Control', 'no-store');
    res.render('pages/login');
}

// Вход пользователя
async function login(req, res) {
    try {
        const { email, password } = req.body || {};

        if (
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !email.trim() ||
            email.length > 255 ||
            !password ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            await getAuthSecurity().finish(req, null);
            return res.status(401).send('Неверный email или пароль');
        }

        const user = await findByEmail(normalizedEmail(email));

        const dummyHash =
            '$2b$12$C6UzMDM.H6dfI/f/IKcEeO6QJpZy1nVbWcv16O3MHuvb6jVWeIt4G';

        const validPassword = await verifyPassword(
            password,
            user ? user.password_hash : dummyHash
        );

        if (!user || !validPassword || user.status !== 'active') {
            await getAuthSecurity().finish(req, false);
            return res.status(401).send('Неверный email или пароль');
        }
        await getAuthSecurity().finish(req, true);

        const selectedCountry = req.session.selectedCountry;
        const pendingSavedSearch = req.session.pendingSavedSearch;
        req.session.regenerate((error) => {
            if (error) {
                logError('Ошибка сессии:', error);
                return res.status(500).send('Ошибка сервера');
            }

            req.session.selectedCountry = selectedCountry;
            if (pendingSavedSearch) req.session.pendingSavedSearch = pendingSavedSearch;
            req.session.user = {
                id: user.id,
                name: user.name,
                role: user.role
            };
            flash(req, 'success', 'Вы вошли в аккаунт.');

            req.session.save((error) => {
                if (error) {
                    logError('Ошибка сохранения сессии:', error);
                    return res.status(500).send('Ошибка сервера');
                }

                res.redirect(pendingSavedSearch ? '/saved-searches/new' : '/');
            });
        });
    } catch (error) {
        getAuthSecurity().respond(res, error);
    }
}

// Выход пользователя
function logout(req, res) {
    const selectedCountry = req.session.selectedCountry;
    // regenerate destroys the authenticated SID, then creates a clean guest session.
    req.session.regenerate((error) => {
        if (error) {
            logError('Ошибка выхода:', error);
            return res.status(500).send('Ошибка сервера');
        }

        req.session.selectedCountry = selectedCountry;
        flash(req, 'success', 'Вы вышли из аккаунта.');
        req.session.save(error => {
            if (error) return res.status(500).send('Не удалось сохранить сообщение о выходе.');
            res.redirect('/');
        });
    });
}

module.exports = {
    registerPage,
    register,
    loginPage,
    login,
    logout
};
