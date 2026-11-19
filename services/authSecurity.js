const logError = require('../services/logError');
const crypto = require('node:crypto');
const { MemoryStore, MariaDbStore } = require('./authRateStore');

const limits = Object.freeze({ source: 120, sourceWindow: 15 * 60000, failures: 5, failureWindow: 15 * 60000,
    registrations: 10, registrationWindow: 60 * 60000, registrationsPerEmail: 5,
    localBcrypt: 2, sharedBcrypt: 4, leaseMs: 120000, emailBackoffMax: 2000 });
const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase().slice(0, 255) : '';
const limited = seconds => Object.assign(new Error('Слишком много попыток. Подождите немного и повторите попытку.'), { status: 429, retryAfter: Math.max(1, Math.ceil(seconds)) });

function createAuthSecurity({ store, secret, policy = limits, sourceFor = req => req.ip || req.socket.remoteAddress } = {}) {
    if (!store || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('Auth security requires a store and a strong key');
    const key = (...parts) => crypto.createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
    let localBcrypt = 0;
    const bucket = (state, now, duration) => {
        if (!state.expiresAt || state.expiresAt <= now) { for (const name of Object.keys(state)) delete state[name]; state.count = 0; state.expiresAt = now + duration; }
        return state;
    };
    function respond(res, error) {
        res.set('Cache-Control', 'no-store');
        if (error.status === 429) {
            res.set('Retry-After', String(error.retryAfter || 1));
            return res.status(429).send('Слишком много попыток. Подождите немного и повторите попытку.');
        }
        logError('AUTH_PROTECTION_UNAVAILABLE', error);
        res.set('Retry-After', '5');
        return res.status(503).send('Вход и регистрация временно недоступны. Повторите попытку позже.');
    }
    async function guard(req, res, next, registration) {
        if (req.authProtection === (registration ? 'register' : 'login')) return next();
        res.set('Cache-Control', 'no-store');
        const email = normalizedEmail(req.body?.email), source = sourceFor(req);
        const sourceKey = key('source', source), pairKey = key('login-pair', source, email), emailKey = key('login-email', email);
        const registrationKey = key('registration-source', source), registrationEmailKey = key('registration-email', email);
        const token = crypto.randomUUID();
        const keys = registration ? [registrationKey, registrationEmailKey] : [pairKey, emailKey];
        try {
            const sourceWait = await store.run([sourceKey], (states, now) => {
                const common = bucket(states.get(sourceKey), now, policy.sourceWindow);
                if (common.count >= policy.source) return (common.expiresAt - now) / 1000;
                common.count++; return 0;
            });
            if (sourceWait) throw limited(sourceWait);
            const wait = await store.run(keys, (states, now) => {
                if (registration) {
                    const ip = bucket(states.get(registrationKey), now, policy.registrationWindow);
                    const address = bucket(states.get(registrationEmailKey), now, policy.registrationWindow);
                    if (ip.count >= policy.registrations) return (ip.expiresAt - now) / 1000;
                    if (address.count >= policy.registrationsPerEmail) return (address.expiresAt - now) / 1000;
                    ip.count++; address.count++; return 0;
                }
                const pair = bucket(states.get(pairKey), now, policy.failureWindow);
                const address = bucket(states.get(emailKey), now, policy.failureWindow);
                if (pair.count >= policy.failures) return (pair.expiresAt - now) / 1000;
                if (address.nextAllowedAt > now) return (address.nextAllowedAt - now) / 1000;
                if (address.inflightUntil > now) return 1;
                address.inflightToken = token; address.inflightUntil = now + policy.leaseMs;
                return 0;
            });
            if (wait) throw limited(wait);
            req.authProtection = registration ? 'register' : 'login';
            if (!registration) {
                req.authAttempt = { pairKey, emailKey, token };
                // Exceptions/session errors must release the email lease too.
                res.once('finish', () => { void finish(req, null).catch(error => logError('AUTH_LEASE_RELEASE_FAILED', error)); });
            }
            next();
        } catch (error) { respond(res, error); }
    }
    async function finish(req, success) {
        const attempt = req.authAttempt;
        if (!attempt || attempt.finished) return;
        attempt.finished = true;
        await store.run([attempt.pairKey, attempt.emailKey], (states, now) => {
            const pair = bucket(states.get(attempt.pairKey), now, policy.failureWindow);
            const address = bucket(states.get(attempt.emailKey), now, policy.failureWindow);
            if (address.inflightToken !== attempt.token) return;
            delete address.inflightToken; delete address.inflightUntil;
            if (success === true) { pair.count = 0; address.count = 0; delete address.nextAllowedAt; }
            if (success === false) {
                pair.count++; address.count++;
                if (address.count >= 3) address.nextAllowedAt = now + Math.min(policy.emailBackoffMax, 250 * (2 ** Math.min(address.count - 3, 4)));
            }
        });
    }
    async function bcryptWork(work) {
        if (localBcrypt >= policy.localBcrypt) throw limited(1);
        localBcrypt++;
        const gateKey = key('bcrypt-gate'), token = crypto.randomUUID();
        let acquired = false;
        try {
            acquired = await store.run([gateKey], (states, now) => {
                const state = states.get(gateKey);
                state.slots = (state.slots || []).filter(slot => slot.until > now);
                state.expiresAt = now + policy.leaseMs;
                if (state.slots.length >= policy.sharedBcrypt) return false;
                state.slots.push({ token, until: now + policy.leaseMs }); return true;
            });
            if (!acquired) throw limited(1);
            return await work();
        } finally {
            localBcrypt--;
            if (acquired) await store.run([gateKey], (states, now) => {
                const state = states.get(gateKey);
                state.slots = (state.slots || []).filter(slot => slot.token !== token && slot.until > now);
                state.expiresAt = now + policy.leaseMs;
            });
        }
    }
    return { login: (req, res, next) => guard(req, res, next, false), register: (req, res, next) => guard(req, res, next, true), finish, bcryptWork, respond };
}

let instance;
function getAuthSecurity() {
    if (!instance) {
        const mode = process.env.AUTH_RATE_STORE || 'memory';
        if (!['memory', 'mariadb'].includes(mode) || (process.env.NODE_ENV === 'production' && mode !== 'mariadb')) throw new Error('Production authentication requires AUTH_RATE_STORE=mariadb');
        const store = mode === 'mariadb' ? new MariaDbStore(require('../config/db')) : new MemoryStore();
        instance = createAuthSecurity({ store, secret: process.env.SESSION_SECRET });
    }
    return instance;
}
module.exports = { getAuthSecurity, createAuthSecurity, normalizedEmail, limits };
