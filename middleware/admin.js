const logError = require('../services/logError');
const db = require('../config/db');

async function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!req.session.user) return res.redirect('/login');
    try {
        const [rows] = await db.execute(
            "SELECT id, name FROM users WHERE id = ? AND role = 'admin' AND status = 'active'",
            [req.session.user.id]
        );
        if (!rows.length) return res.status(403).send('Доступ запрещён.');
        res.locals.admin = rows[0];
        if (req.method === 'GET') {
            res.locals.adminCounts = await require('../models/admin.model').counters();
        }
        next();
    } catch (error) {
        logError('Ошибка проверки администратора:', error);
        res.status(503).send('Повторите попытку позже.');
    }
}
module.exports = requireAdmin;
