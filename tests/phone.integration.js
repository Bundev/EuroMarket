require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

async function run() {
    let db, server;
    try {
        db = await mysql.createConnection({
            host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: 'euromarket_test'
        });
        assert.equal((await db.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/002_user_phone_public.sql'), 'utf8');
        await db.query(migration);
        await db.query(migration);
        const dbPath = require.resolve('../config/db');
        require.cache[dbPath] = { loaded: true, exports: db };
        await require('./apply-migrations')(db);
        await db.beginTransaction();
        const stamp = Date.now();
        const [countries] = await db.query("SELECT id FROM countries WHERE code='DE'");
        const country = countries[0]?.id ?? (await db.query(
            "INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"
        ))[0].insertId;
        const category = (await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Phone test')", ['phone-' + stamp]))[0].insertId;
        const password = 'TemporaryContactTest123';
        const hash = await bcrypt.hash(password, 4);
        const users = [];
        for (let i = 0; i < 2; i++) {
            const email = 'phone-' + stamp + '-' + i + '@example.invalid';
            const id = (await db.execute(
                "INSERT INTO users(name,email,password_hash) VALUES ('Contact test',?,?)", [email, hash]
            ))[0].insertId;
            users.push({ id, email, cookie: '', token: '' });
        }
        const [owner, other] = users;
        const listingIds = [];
        for (const status of ['active', 'active', 'active', 'draft', 'sold']) {
            listingIds.push((await db.execute(
                `INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status)
                 VALUES (?,?,?,'Contact listing','Fixture',10,'EUR',?)`,
                [owner.id, category, country, status]
            ))[0].insertId);
        }
        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '../views'));
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));
        app.use(session({ name: 'euromarket.sid', secret: 'phone-test-only', resave: false, saveUninitialized: false }));
        app.use(require('../middleware/pageContext'));
        for (const route of ['home', 'auth', 'profile', 'listing', 'search', 'favorite']) {
            app.use(require('../routes/' + route + '.routes'));
        }
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        const base = 'http://127.0.0.1:' + server.address().port;
        let checks = 0, contactRequests = 0;
        async function request(user, route, method = 'GET', status = 200, body, token = user.token) {
            const response = await fetch(base + route, {
                method, redirect: 'manual',
                headers: {
                    cookie: user.cookie, 'content-type': 'application/json', 'X-CSRF-Token': token,
                    'X-Forwarded-For': '198.51.100.' + checks
                },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            assert.equal(response.status, status);
            const text = await response.text();
            if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
            checks++;
            if (route.startsWith('/api/listings/') && method === 'POST' && status !== 403) contactRequests++;
            return { response, text };
        }
        for (const user of users) {
            const { text: loginPage } = await request(user, '/login');
            user.token = loginPage.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
            await request(user, '/login', 'POST', 302, { email: user.email, password });
            user.token = (await request(user, '/profile')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        }
        const guest = { cookie: '', token: '' };
        guest.token = (await request(guest, '/listing/' + listingIds[0] + '/contact-listing')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        const endpoint = '/api/listings/' + listingIds[0] + '/phone';
        const phone = '+380501234567';
        const ownRow = async id => (await db.execute('SELECT phone,phone_public FROM users WHERE id=?', [id]))[0][0];
        await request(owner, '/profile/phone', 'POST', 403, { phone, phone_public: '1' }, '');
        await request(owner, '/profile/phone', 'POST', 400, { phone: 'invalid' });
        await request(owner, '/profile/phone', 'POST', 400, { phone: ['+123456789'] });
        await request(owner, '/profile/phone', 'POST', 400, { phone: '+1234567890123456' });
        await request(owner, '/profile/phone', 'POST', 303, { phone: '00380 (50) 123-45-67', phone_public: '1' });
        assert.equal((await ownRow(owner.id)).phone, phone);
        assert.equal((await ownRow(owner.id)).phone_public, 1);
        const model = require('../models/listing.model');
        const listing = await model.getListingById(listingIds[0]);
        assert.equal(Number(listing.seller_active_count), 3);
        assert.ok(listing.seller_created_at);
        assert.ok(!('phone' in listing));
        const html = (await request(guest, '/listing/' + listingIds[0] + '/contact-listing')).text;
        assert.ok(!html.includes(phone));
        assert.ok(html.includes('data-phone-listing'));
        await request(guest, endpoint, 'POST', 403, undefined, '');
        const publicContact = await request(guest, endpoint, 'POST');
        assert.equal(JSON.parse(publicContact.text).phone, phone);
        assert.equal(publicContact.response.headers.get('cache-control'), 'no-store');
        await request(owner, '/profile/phone', 'POST', 303, { phone, phone_public: '0' });
        const hidden = await request(guest, endpoint, 'POST', 404);
        await request(owner, '/profile/phone', 'POST', 303, { phone: '', phone_public: '1' });
        assert.equal((await ownRow(owner.id)).phone, null);
        assert.equal((await ownRow(owner.id)).phone_public, 0);
        const missing = await request(guest, endpoint, 'POST', 404);
        assert.equal(hidden.text, missing.text);
        await request(owner, '/profile/phone', 'POST', 303, { phone, phone_public: '1' });
        await request(other, '/profile/phone', 'POST', 303, { user_id: owner.id, phone: '+4915112345678', phone_public: '1' });
        assert.equal((await ownRow(owner.id)).phone, phone);
        assert.equal((await ownRow(other.id)).phone, '+4915112345678');
        await request(guest, '/profile/phone', 'POST', 302, { phone });
        await request(other, '/profile/' + owner.id, 'GET', 404);
        const ownProfile = await request(other, '/profile');
        assert.ok(!ownProfile.text.includes(phone));
        assert.equal(ownProfile.response.headers.get('cache-control'), 'no-store');
        await db.execute("UPDATE listings SET status='draft' WHERE id=?", [listingIds[0]]);
        await request(guest, endpoint, 'POST', 404);
        await request(guest, '/listings/' + listingIds[0], 'GET', 404);
        const activeEndpoint = '/api/listings/' + listingIds[1] + '/phone';
        await db.execute("UPDATE users SET status='blocked' WHERE id=?", [owner.id]);
        await request(guest, activeEndpoint, 'POST', 404);
        await db.execute("UPDATE users SET status='active' WHERE id=?", [owner.id]);
        await request(guest, '/api/listings/4294967295/phone', 'POST', 404);
        await request(guest, endpoint, 'GET', 404);
        while (contactRequests < 10) await request(guest, activeEndpoint, 'POST');
        const limited = await request(guest, activeEndpoint, 'POST', 429);
        assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
        const { createPhoneLimiter } = require('../middleware/phoneRateLimit');
        let time = 0, passed = 0, code = 0;
        const limiter = createPhoneLimiter({ limit: 1, windowMs: 100, now: () => time });
        const req = { socket: { remoteAddress: 'test' } };
        const res = { set() {}, status(value) { code = value; return this; }, json() {} };
        limiter(req, res, () => passed++);
        limiter(req, res, () => passed++);
        assert.equal(code, 429);
        time = 101;
        limiter(req, res, () => passed++);
        assert.equal(passed, 2);
        console.log('Phone HTTP checks passed:', checks);
        console.log('Privacy, CSRF, normalization, ownership, availability, seller metadata, spoofed headers and rate-limit reset: OK');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) { await db.rollback(); await db.end(); }
    }
}
run().catch(error => {
    console.error('Phone verification failed:', error.code || error.name);
    process.exitCode = 1;
});
