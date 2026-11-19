const crypto = require('crypto');

function contactCsrf(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const token = req.get('X-CSRF-Token') ?? (req.is('multipart/form-data') ? undefined : req.body?._csrf);
    const expected = req.session?.favoritesCsrfToken;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
        typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
        const error = 'Не удалось подтвердить действие. Обновите страницу и повторите попытку.';
        if (/^\/api\//i.test(req.originalUrl || req.url) || req.is('application/json') || req.get('Accept')?.includes('application/json')) {
            return res.status(403).json({ error });
        }
        return res.status(403).send(error);
    }
    next();
}

module.exports = contactCsrf;
