const crypto = require('node:crypto');
const db = require('../config/db');
const transaction = require('../config/transaction');
const { MariaDbStore } = require('../services/authRateStore');
const sms = require('../services/phoneSms');

const rateStore = new MariaDbStore(db);
const digest = (key, ...values) => crypto.createHmac('sha256', key).update(JSON.stringify(values)).digest();

async function account(userId, connection = db, lock = false) {
    const [[row]] = await connection.execute(
        "SELECT phone,phone_verified_at FROM users WHERE id=? AND status='active'" + (lock ? ' FOR UPDATE' : ''), [userId]);
    return row;
}

async function budget(key, action, userId, phone, ip) {
    const send = action === 'send';
    const limits = send ? [
        ['resend', userId, 1, 60000], ['account', userId, 5, 3600000],
        ['phone', phone, 5, 3600000], ['ip', ip, 20, 3600000]
    ] : [['account', userId, 15, 3600000], ['phone', phone, 20, 3600000], ['ip', ip, 60, 3600000]];
    const buckets = limits.map(([scope, value, max, ttl]) => [digest(key, 'phone-rate', action, scope, value).toString('hex'), max, ttl]);
    return rateStore.run(buckets.map(([key]) => key), (states, now) => {
        let wait = 0;
        for (const [id, max] of buckets) {
            const state = states.get(id);
            if ((state.count || 0) >= max) wait = Math.max(wait, state.expiresAt - now);
        }
        if (wait) return Math.ceil(wait / 1000);
        for (const [id, , ttl] of buckets) {
            const state = states.get(id);
            state.count = (state.count || 0) + 1;
            state.expiresAt ||= now + ttl;
        }
        return 0;
    });
}

async function sendCode(userId, ip) {
    const config = sms.configuration();
    if (!config) return 'unavailable';
    const initial = await account(userId);
    if (!initial?.phone || initial.phone_verified_at) return 'invalid';
    const wait = await budget(config.key, 'send', userId, initial.phone, ip);
    if (wait) return wait;
    const nonce = crypto.randomUUID();
    const code = String(crypto.randomInt(1000000)).padStart(6, '0');
    const staged = await transaction(async connection => {
        const user = await account(userId, connection, true);
        if (!user || user.phone !== initial.phone || user.phone_verified_at) return false;
        await connection.execute(
            `INSERT INTO phone_verifications(user_id,phone,nonce,code_hash,expires_at)
             VALUES (?,?,?,?,CURRENT_TIMESTAMP(3)+INTERVAL 10 MINUTE)
             ON DUPLICATE KEY UPDATE phone=VALUES(phone),nonce=VALUES(nonce),code_hash=VALUES(code_hash),
             expires_at=VALUES(expires_at),attempts=0,delivered=0`,
            [userId, user.phone, nonce, digest(config.key, 'phone-otp', nonce, userId, user.phone, code)]);
        return true;
    });
    if (!staged) return 'invalid';
    try { await sms.send(config, initial.phone, code); }
    catch {
        await db.execute('DELETE FROM phone_verifications WHERE user_id=? AND nonce=?', [userId, nonce]);
        return 'unavailable';
    }
    const [result] = await db.execute('UPDATE phone_verifications SET delivered=1 WHERE user_id=? AND nonce=?', [userId, nonce]);
    return result.affectedRows ? 'sent' : 'invalid';
}

async function confirm(userId, ip, code) {
    const config = sms.configuration();
    if (!config) return 'unavailable';
    const initial = await account(userId);
    if (!initial?.phone || initial.phone_verified_at) return 'invalid';
    const wait = await budget(config.key, 'confirm', userId, initial.phone, ip);
    if (wait) return wait;
    return transaction(async connection => {
        const user = await account(userId, connection, true);
        if (!user || user.phone !== initial.phone || user.phone_verified_at) return 'invalid';
        const [[entry]] = await connection.execute(
            `SELECT nonce,phone,code_hash,attempts FROM phone_verifications
             WHERE user_id=? AND delivered=1 AND expires_at>CURRENT_TIMESTAMP(3) FOR UPDATE`, [userId]);
        if (!entry || entry.phone !== user.phone || entry.attempts >= 5) return 'invalid';
        if (!crypto.timingSafeEqual(entry.code_hash, digest(config.key, 'phone-otp', entry.nonce, userId, user.phone, code))) {
            await connection.execute('UPDATE phone_verifications SET attempts=attempts+1 WHERE user_id=?', [userId]);
            return 'invalid';
        }
        await connection.execute('DELETE FROM phone_verifications WHERE user_id=?', [userId]);
        try {
            await connection.execute('UPDATE users SET phone_verified_at=CURRENT_TIMESTAMP(3) WHERE id=?', [userId]);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') return 'invalid';
            throw error;
        }
        return 'confirmed';
    });
}

module.exports = { sendCode, confirm };
