const verifyTestEnvironment = require('./test-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { MemoryStore, MariaDbStore } = require('../services/authRateStore');
const auth = require('../services/authSecurity');

async function run() {
    const options = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: 'euromarket_test' };
    let db, server, sharedPool;
    const sharedKeys = new Set(), checks = [];
    try {
        db = await mysql.createConnection(options);
        assert.equal((await db.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/006_auth_rate_limits.sql'), 'utf8');
        await db.query(migration); await db.query(migration);
        await db.beginTransaction();
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: db };
        let now = Date.now(), source = 'office-A';
        const store = new MemoryStore({ now: () => now });
        const protection = auth.createAuthSecurity({ store, secret: crypto.randomBytes(32).toString('hex'), sourceFor: () => source });
        require.cache[require.resolve('../services/authSecurity')].exports = { ...auth, getAuthSecurity: () => protection };
        const password = crypto.randomBytes(20).toString('hex');
        const hash = await bcrypt.hash(password, 12), users = [];
        const stamp = crypto.randomUUID();
        for (const role of ['user', 'admin', 'user']) {
            const email = 'auth-' + users.length + '-' + stamp + '@example.invalid';
            const id = (await db.execute('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)', ['Auth fixture', email, hash, role]))[0].insertId;
            users.push({ id, email });
        }
        const app = express();
        app.set('trust proxy', require('../config/trustedProxy'));
        app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
        app.use(express.json()); app.use(express.urlencoded({ extended: false }));
        app.use(session({ name: 'euromarket.sid', secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false }));
        app.use(require('../middleware/authProtection'));
        app.use(require('../middleware/pageContext'));
        app.use(require('../routes/auth.routes'));
        app.use(require('../routes/profile.routes'));
        app.use(require('../routes/admin.routes'));
        app.get('/test-session', (req, res) => { req.session.touchTest = true; res.json({ id: req.sessionID, user: req.session.user || null }); });
        server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
        const base = 'http://127.0.0.1:' + server.address().port;
        let cookie = '', token = '';
        async function request(url, body, status, extraHeaders = {}) {
            if (body !== undefined) await request('/login', undefined, 200);
            const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const text = await response.text();
            if (url === '/login' && body === undefined) token = text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
            assert.equal(response.status, status, url + ': ' + text);
            if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
            if (status === 429) { assert.match(response.headers.get('retry-after'), /^[1-9]\d*$/); assert.equal(response.headers.get('cache-control'), 'no-store'); }
            return { response, text };
        }
        const credentials = { email: users[0].email, password };
        const initialSession = JSON.parse((await request('/test-session', undefined, 200)).text).id;
        await request('/login', credentials, 302);
        const authenticated = JSON.parse((await request('/test-session', undefined, 200)).text);
        assert.notEqual(authenticated.id, initialSession); assert.equal(authenticated.user.id, users[0].id);
        checks.push('valid login regenerates session');
        await request('/logout', {}, 302); await request('/login', credentials, 302);
        checks.push('logout then login works');
        const wrong = await request('/login', { ...credentials, password: 'wrong-password' }, 401);
        const missing = await request('/login', { email: 'missing-' + stamp + '@example.invalid', password: 'wrong-password' }, 401);
        assert.equal(wrong.text, missing.text); checks.push('unknown email and wrong password have identical response');
        const accented = await request('/login', { email: users[0].email.replace('auth', 'áuth'), password }, 401);
        assert.equal(accented.text, missing.text); checks.push('accent aliases cannot authenticate or bypass normalized keys');
        source = 'normalization'; now += 900001;
        for (let i = 0; i < 5; i++) {
            await request('/login', { email: i % 2 ? '  ' + users[0].email.toUpperCase() + '  ' : users[0].email, password: 'wrong-password' }, 401);
            now += 3000;
        }
        const blocked = await request('/login', credentials, 429); assert.ok(Number(blocked.response.headers.get('retry-after')) > 800);
        checks.push('normalized email pair reaches 5 failures with valid Retry-After');
        await request('/login', { email: users[1].email, password }, 302);
        await request('/admin', undefined, 200); checks.push('another account at same IP and admin role remain usable');
        source = 'other-office'; await request('/login', credentials, 302);
        await request('/admin', undefined, 403); checks.push('other source is not account-locked; normal user is not admin');
        source = 'short-cooldown'; now += 900001;
        for (let i = 0; i < 3; i++) { await request('/login', { ...credentials, password: 'wrong-password' }, 401); now += i < 2 ? 3000 : 0; }
        source = 'fresh-office';
        const cooldown = await request('/login', credentials, 429); assert.ok(Number(cooldown.response.headers.get('retry-after')) <= 2);
        now += 3000; await request('/login', credentials, 302); checks.push('cross-IP email backoff is short and expires');
        source = 'reset'; now += 900001;
        for (let i = 0; i < 4; i++) { await request('/login', { ...credentials, password: 'wrong-password' }, 401); now += 3000; }
        await request('/login', credentials, 302);
        for (let i = 0; i < 4; i++) { await request('/login', { ...credentials, password: 'wrong-password' }, 401); now += 3000; }
        checks.push('successful login resets pair failure count');
        source = 'aggregate'; now += 900001;
        for (let i = 0; i < 120; i++) await request('/login', {}, 401);
        await request('/login', credentials, 429);
        now += 900001; await request('/login', credentials, 302); checks.push('aggregate source limit and expiry');
        source = 'success-budget';
        // Fill all but one source slot without bcrypt, then a success must not reset it.
        for (let i = 0; i < 119; i++) await request('/login', {}, 401);
        await request('/login', credentials, 302); await request('/login', credentials, 429); checks.push('success does not reset aggregate budget');
        source = 'registrations'; now += 3600001;
        const registration = { name: 'New fixture', email: 'new-' + stamp + '@example.invalid', password };
        const created = await request('/register', { ...registration, role: 'admin' }, 201);
        const duplicate = await request('/register', registration, 201); assert.equal(created.text, duplicate.text);
        assert.equal((await db.execute('SELECT role FROM users WHERE email=?', [registration.email]))[0][0].role, 'user');
        for (let i = 0; i < 8; i++) await request('/register', { ...registration, email: 'new-' + i + '-' + stamp + '@example.invalid' }, 201);
        await request('/register', { ...registration, email: 'over-' + stamp + '@example.invalid' }, 429);
        checks.push('registration budget; duplicate response identical; role injection ignored');
        source = 'registration-other-source';
        for (let i = 0; i < 3; i++) await request('/register', registration, 201);
        await request('/register', registration, 429); checks.push('registration per-email budget across sources');
        source = 'blocked-user'; now += 3600001;
        await db.execute("UPDATE users SET status='blocked' WHERE id=?", [users[2].id]);
        const blockedUser = await request('/login', { email: users[2].email, password }, 401);
        assert.equal(blockedUser.text, missing.text); checks.push('blocked account uses generic failure');

        // No password appears in keys or store values.
        for (const [key, value] of store.entries) { assert.match(key, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(value).includes(password)); assert.ok(!JSON.stringify(value).includes(users[0].email)); }
        checks.push('store contains no plaintext emails/passwords');

        let leaseNow = Date.now(), leaseSource = 'lease-one';
        const leases = auth.createAuthSecurity({ store: new MemoryStore({ now: () => leaseNow }), secret: crypto.randomBytes(32).toString('hex'), sourceFor: () => leaseSource });
        const firstLease = { body: { email: 'lease@example.invalid' } };
        const admitted = () => ({ set() {}, once() {}, status(code) { assert.fail('Unexpected denial: ' + code); } });
        await leases.login(firstLease, admitted(), () => {});
        leaseSource = 'lease-two'; let leaseStatus;
        await leases.login({ body: firstLease.body }, { set() {}, status(code) { leaseStatus = code; return this; }, send() {} }, () => assert.fail('Concurrent email lease bypass'));
        assert.equal(leaseStatus, 429);
        leaseNow += auth.limits.leaseMs + 1;
        const recoveredLease = { body: firstLease.body };
        await leases.login(recoveredLease, admitted(), () => {}); await leases.finish(recoveredLease, true);
        checks.push('per-email in-flight lease shared across sources and expires after crash');
        const bounded = new MemoryStore({ now: () => leaseNow, maxKeys: 1 });
        await bounded.run(['one'], states => { states.get('one').expiresAt = leaseNow + 1; });
        await assert.rejects(bounded.run(['two'], () => {}), error => error.status === 429);
        leaseNow += 2;
        await bounded.run(['two'], states => { states.get('two').expiresAt = leaseNow + 1; });
        assert.equal(bounded.entries.size, 1); checks.push('bounded memory store prunes expired keys');

        // Bound local bcrypt work, including error cleanup; no actual CPU-heavy loop needed.
        const pending = []; let active = 0, maximum = 0;
        const work = () => protection.bcryptWork(() => new Promise(resolve => { active++; maximum = Math.max(maximum, active); pending.push(() => { active--; resolve(); }); }));
        const first = work(), second = work();
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(work(), error => error.status === 429 && error.retryAfter === 1);
        pending.splice(0).forEach(resolve => resolve()); await Promise.all([first, second]); assert.equal(maximum, 2);
        await assert.rejects(protection.bcryptWork(() => { throw new Error('Test bcrypt failure'); }));
        await protection.bcryptWork(() => Promise.resolve()); checks.push('bcrypt concurrency 2, overflow and release after error');

        // Direct HTTP clients cannot rotate their source by supplying forwarding headers.
        const spoofProtection = auth.createAuthSecurity({ store: new MemoryStore(), secret: crypto.randomBytes(32).toString('hex'), policy: { ...auth.limits, source: 3 } });
        const spoofApp = express(); spoofApp.set('trust proxy', false); spoofApp.use(express.json());
        spoofApp.post('/login', spoofProtection.register, (req, res) => res.sendStatus(204));
        const spoofServer = await new Promise(resolve => { const value = spoofApp.listen(0, '127.0.0.1', () => resolve(value)); });
        try {
            for (let i = 0; i < 4; i++) {
                const response = await fetch('http://127.0.0.1:' + spoofServer.address().port + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.' + i, 'Forwarded': 'for=192.0.2.' + i, 'X-Real-IP': '192.0.2.' + i }, body: JSON.stringify({ email: 'spoof-' + i + '@example.invalid' }) });
                assert.equal(response.status, i < 3 ? 204 : 429);
            }
        } finally { spoofServer.closeAllConnections(); await new Promise(resolve => spoofServer.close(resolve)); }
        checks.push('forged forwarding headers do not bypass source limit');

        // Two independent application instances share atomic MariaDB counters and leases.
        sharedPool = mysql.createPool({ ...options, connectionLimit: 8 });
        assert.equal((await sharedPool.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        class TrackingStore extends MariaDbStore { run(keys, fn) { keys.forEach(key => sharedKeys.add(key)); return super.run(keys, fn); } }
        const sharedSecret = crypto.randomBytes(32).toString('hex');
        const a = auth.createAuthSecurity({ store: new TrackingStore(sharedPool), secret: sharedSecret, policy: { ...auth.limits, source: 3 }, sourceFor: () => 'shared-source' });
        const b = auth.createAuthSecurity({ store: new TrackingStore(sharedPool), secret: sharedSecret, policy: { ...auth.limits, source: 3 }, sourceFor: () => 'shared-source' });
        async function invoke(instance, i) {
            let status = 204, retry;
            const res = { set(key, value) { if (key === 'Retry-After') retry = value; }, status(value) { status = value; return this; }, send() {} };
            await instance.register({ body: { email: 'shared-' + i + '@example.invalid' } }, res, () => {});
            if (status === 429) assert.ok(Number(retry) > 0);
            return status;
        }
        const sharedResults = await Promise.all(Array.from({ length: 12 }, (_, i) => invoke(i % 2 ? a : b, i)));
        assert.equal(sharedResults.filter(status => status === 204).length, 3);
        assert.equal(sharedResults.filter(status => status === 429).length, 9); checks.push('MariaDB shared source budget atomic across instances');
        const gatePolicy = { ...auth.limits, localBcrypt: 2, sharedBcrypt: 2 };
        const gateA = auth.createAuthSecurity({ store: new TrackingStore(sharedPool), secret: sharedSecret, policy: gatePolicy });
        const gateB = auth.createAuthSecurity({ store: new TrackingStore(sharedPool), secret: sharedSecret, policy: gatePolicy });
        const sharedPending = [];
        const occupied = [gateA.bcryptWork(() => new Promise(resolve => sharedPending.push(resolve))), gateB.bcryptWork(() => new Promise(resolve => sharedPending.push(resolve)))];
        for (let i = 0; sharedPending.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(sharedPending.length, 2);
        await assert.rejects(gateB.bcryptWork(() => Promise.resolve()), error => error.status === 429);
        sharedPending.forEach(resolve => resolve()); await Promise.all(occupied);
        await gateA.bcryptWork(() => Promise.resolve()); checks.push('MariaDB shared bcrypt slots across instances');
        const unavailable = auth.createAuthSecurity({ store: { run: async () => { throw Object.assign(new Error('Unavailable'), { code: 'TEST_STORE_DOWN' }); } }, secret: sharedSecret });
        let unavailableStatus;
        await unavailable.login({ body: {}, socket: { remoteAddress: '127.0.0.1' } }, { set() {}, status(code) { unavailableStatus = code; return this; }, send() {} }, () => assert.fail('Must fail closed'));
        assert.equal(unavailableStatus, 503); checks.push('store failure fails closed');
        console.log('Authentication security checks passed:', checks.length);
        for (const check of checks) console.log('OK:', check);
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (db) { await db.rollback(); await db.end(); }
        if (sharedPool) {
            for (const key of sharedKeys) await sharedPool.execute('DELETE FROM auth_rate_limits WHERE key_hash=?', [key]);
            await sharedPool.end();
        }
    }
}
verifyTestEnvironment().then(run).catch(error => { console.error('Auth security checks failed:', error.code || error.name, error.message); process.exitCode = 1; });
