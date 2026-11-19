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
            res.locals.pendingModerationCount = await require('../models/listingModeration.model').stats();
            res.locals.openDisputeCount = await require('../models/dispute.model').openCount();
        }
        next();
    } catch (error) {
        logError('Ошибка проверки администратора:', error);
        res.status(503).send('Повторите попытку позже.');
    }
}
module.exports = requireAdmin;
