const { randomUUID } = require('node:crypto');
const logError = require('../services/logError');

function reply(req, res, status, message) {
    res.set('Cache-Control', 'no-store');
    if (/^\/api(?:\/|$)/i.test(req.path) || req.is('application/json') || req.accepts(['html', 'json']) === 'json') {
        return res.status(status).json({ error: message });
    }
    return res.status(status).type('text').send(message);
}

function notFound(req, res) {
    return reply(req, res, 404, 'Страница не найдена.');
}

function handleError(error, req, res, next) {
    const reference = randomUUID();
    logError('Ошибка запроса ' + reference, error);
    if (res.headersSent) {
        // Express's default error handler may log the original stack.
        req.socket.destroy();
        return;
    }
    res.set('X-Error-Id', reference);
    const status = [400, 413, 415].includes(error.status) ? error.status : 500;
    return reply(req, res, status, status === 500 ? 'Внутренняя ошибка сервера.' : 'Не удалось обработать запрос.');
}

module.exports = { notFound, handleError };
