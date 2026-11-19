function createPhoneLimiter({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now, keyFor = req => req.socket.remoteAddress } = {}) {
    const clients = new Map();
    return (req, res, next) => {
        const time = now();
        // Адрес соединения не позволяет обходить лимит подменой X-Forwarded-For.
        const key = keyFor(req);
        let entry = clients.get(key);
        if (!entry || entry.expires <= time) {
            if (clients.size >= 10000) {
                for (const [address, item] of clients) {
                    if (item.expires <= time) clients.delete(address);
                }
                if (clients.size >= 10000) return res.status(503).json({ error: 'Повторите попытку позже.' });
            }
            entry = { count: 0, expires: time + windowMs };
            clients.set(key, entry);
        }
        if (entry.count >= limit) {
            res.set('Retry-After', String(Math.ceil((entry.expires - time) / 1000)));
            return res.status(429).json({ error: 'Слишком много запросов. Повторите попытку позже.' });
        }
        entry.count++;
        next();
    };
}

module.exports = { createPhoneLimiter };
