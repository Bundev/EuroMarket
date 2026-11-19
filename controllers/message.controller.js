const db = require('../config/db');
const model = require('../models/message.model');

function id(value, allowZero = false) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= (allowZero ? 0 : 1) && number <= 4294967295 ? number : null;
}

async function requireUser(req, res, next) {
    if (!req.session.user) {
        return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Войдите в аккаунт.' }) : res.redirect('/login');
    }
    const [users] = await db.execute("SELECT id FROM users WHERE id = ? AND status = 'active'", [req.session.user.id]);
    if (!users.length) return res.status(403).send('Аккаунт недоступен.');
    next();
}

async function start(req, res) {
    const listingId = id(req.body?.listing_id);
    if (!listingId) return res.status(400).send('Некорректное объявление.');
    const conversationId = await model.start(req.session.user.id, listingId);
    if (!conversationId) return res.status(404).send('Объявление недоступно или принадлежит вам.');
    res.redirect(303, '/messages/' + conversationId);
}

async function inbox(req, res) {
    res.render('pages/messages', await model.listConversations(req.session.user.id, id(req.query.page) || 1));
}

async function conversation(req, res) {
    const conversationId = id(req.params.id);
    const chat = conversationId && await model.getConversation(conversationId, req.session.user.id);
    if (!chat) return res.status(404).send('Диалог не найден.');
    res.render('pages/conversation', { chat, history: await model.history(conversationId, req.session.user.id) });
}

async function authorizeConversation(req, res, next) {
    const conversationId = id(req.params.id);
    const chat = conversationId && await model.getConversation(conversationId, req.session.user.id);
    if (!chat) return res.status(404).json({ error: 'Диалог не найден.' });
    res.locals.chat = chat;
    next();
}

async function history(req, res) {
    const after = req.query.after === undefined ? null : id(req.query.after, true);
    const before = req.query.before === undefined ? null : id(req.query.before);
    if ((req.query.after !== undefined && after === null) ||
        (req.query.before !== undefined && before === null) ||
        (after !== null && before !== null)) {
        return res.status(400).json({ error: 'Некорректная страница сообщений.' });
    }
    res.json(await model.history(res.locals.chat.id, req.session.user.id, { after, before }));
}

async function send(req, res) {
    const body = req.body?.body;
    const key = req.body?.client_key;
    if (typeof body !== 'string' || !body.trim() || body.length > 2000 ||
        typeof key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)) {
        return res.status(400).json({ error: 'Введите сообщение длиной от 1 до 2000 символов.' });
    }
    if (!res.locals.chat.can_send) return res.status(409).json({ error: 'Собеседник больше недоступен.' });
    const message = await model.send(res.locals.chat.id, req.session.user.id, body.trim(), key.toLowerCase());
    if (!message) return res.status(409).json({ error: 'Диалог больше недоступен.' });
    if (message.conflict) return res.status(409).json({ error: 'Обновите страницу и повторите отправку.' });
    res.json({ message });
}

async function read(req, res) {
    const upTo = typeof req.body?.up_to === 'number' ? id(String(req.body.up_to), true) : id(req.body?.up_to, true);
    if (upTo === null) return res.status(400).json({ error: 'Некорректное сообщение.' });
    await model.markRead(res.locals.chat.id, req.session.user.id, upTo);
    res.json({ unread: await model.unreadCount(req.session.user.id) });
}

async function unread(req, res) {
    res.json({ unread: res.locals.unreadMessages, notifications: res.locals.unreadNotifications });
}

module.exports = { requireUser, start, inbox, conversation, authorizeConversation, history, send, read, unread };
