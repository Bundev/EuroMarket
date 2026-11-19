const verifyTestEnvironment = require('./test-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const sharp = require('sharp');

async function run() {
    let db, server;
    const checks = [], storageParent = path.resolve(__dirname, '../.storage');
    const storage = path.join(storageParent, 'toast-tests-' + crypto.randomUUID());
    const previousStorage = process.env.LISTING_IMAGE_STORAGE_ROOT;
    process.env.LISTING_IMAGE_STORAGE_ROOT = storage;
    try {
        db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: 'euromarket_test' });
        assert.equal((await db.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        await db.beginTransaction();
        const adapter = { execute: db.execute.bind(db), query: db.query.bind(db), async getConnection() {
            const key = 'toast_' + crypto.randomBytes(8).toString('hex');
            return { execute: db.execute.bind(db), query: db.query.bind(db), beginTransaction: () => db.query('SAVEPOINT ' + key), commit: () => db.query('RELEASE SAVEPOINT ' + key),
                async rollback() { await db.query('ROLLBACK TO SAVEPOINT ' + key); await db.query('RELEASE SAVEPOINT ' + key); }, release() {}, destroy() {} };
        } };
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: adapter };
        const stamp = crypto.randomUUID(), password = crypto.randomBytes(20).toString('hex');
        const hash = await bcrypt.hash(password, 4), users = [];
        for (const role of ['user', 'user', 'admin']) {
            const email = 'toast-' + users.length + '-' + stamp + '@example.invalid';
            const id = (await db.execute('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)', ['Toast fixture', email, hash, role]))[0].insertId;
            users.push({ id, email, cookie: '', token: '' });
        }
        const country = (await db.query("SELECT id FROM countries WHERE code='DE'"))[0][0]?.id || (await db.query("INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"))[0].insertId;
        const category = (await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Toast fixture')", ['toast-' + stamp]))[0].insertId;
        const app = express(); app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../views'));
        app.use(express.json()); app.use(express.urlencoded({ extended: false }));
        app.use(require('../middleware/toasts'));
        app.use(session({ name: 'euromarket.sid', secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false }));
        app.use(require('../middleware/authProtection'));
        app.use(require('../middleware/publicAssets')); app.use(require('../middleware/pageContext'));
        app.post('/test-escaped', (req, res) => res.status(400).send('<img src=x onerror="alert(1)">'));
        app.post('/test-json-error', (req, res) => res.set('Retry-After', '7').status(429).json({ error: 'Повторите попытку позже.' }));
        for (const route of ['home', 'auth', 'profile', 'listing', 'search', 'favorite', 'message', 'notification', 'admin']) app.use(require('../routes/' + route + '.routes'));
        server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
        const base = 'http://127.0.0.1:' + server.address().port;
        const seeds = html => [...html.matchAll(/data-toast-id="([^"]+)" data-toast-type="([^"]+)">([^<]*)<\/span>/g)].map(match => ({ id: match[1], type: match[2], text: match[3] }));
        async function request(user, url, body, expected = 200, json = false) {
            if (body !== undefined && ['/login','/register'].includes(url) && !user.token) await request(user, '/login');
            const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { cookie: user.cookie, ...(body instanceof FormData ? (json ? { Accept: 'application/json' } : {}) : { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }), 'X-CSRF-Token': user.token },
                ...(body === undefined ? {} : { body: body instanceof FormData ? body : json ? JSON.stringify(body) : new URLSearchParams(body) }) });
            const text = await response.text();
            assert.equal(response.status, expected, url + ': ' + text);
            if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
            const token = text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/); if (token) user.token = token[1];
            return { response, text, toasts: seeds(text) };
        }
        async function once(user, url, text) {
            const first = await request(user, url);
            assert.equal(first.toasts.length, 1); assert.ok(first.toasts[0].text.includes(text));
            assert.equal((await request(user, url)).toasts.length, 0);
            return first;
        }
        const [seller, buyer, admin] = users;
        const guest = { cookie: '', token: '' };
        async function rejects(user, method, url, body, json = false, extraTokens = []) {
            for (const token of [null, '0'.repeat(64), ...extraTokens]) {
                const headers = { cookie: user.cookie };
                if (token !== null) headers['X-CSRF-Token'] = token;
                if (json) headers.Accept = 'application/json';
                const response = await fetch(base + url, { method, headers, body, redirect: 'manual' });
                assert.equal(response.status, 403, method + ' ' + url);
                const text = await response.text();
                if (json) assert.match(JSON.parse(text).error, /Обновите страницу/);
                else assert.equal(seeds(text).filter(item => item.type === 'error').length, 1);
                if (token) assert.ok(!text.includes(token), 'Token exposed in CSRF response');
            }
        }
        const registration = { name: 'Toast registration', email: 'register-' + stamp + '@example.invalid', password };
        await request(guest, '/register');
        await rejects(guest, 'POST', '/register', new URLSearchParams(registration));
        assert.equal((await db.execute('SELECT id FROM users WHERE email=?', [registration.email]))[0].length, 0);
        await request(seller, '/login');
        const guestToken = seller.token;
        await rejects(seller, 'POST', '/login', new URLSearchParams({ email: seller.email, password }));
        await request(seller, '/profile', undefined, 302);
        await request(guest, '/register', registration, 303); const registered = await once(guest, '/login', 'Если адрес доступен');
        await request(guest, '/register', registration, 303); const duplicate = await once(guest, '/login', 'Если адрес доступен');
        assert.equal(registered.toasts[0].text, duplicate.toasts[0].text); checks.push('registration redirect, generic duplicate response, one-shot flash');
        const invalidRegister = await request(guest, '/register', { ...registration, password: 'short' }, 400);
        assert.equal(invalidRegister.toasts[0].type, 'error'); assert.ok(!invalidRegister.text.includes('short')); checks.push('registration error contains toast without password');
        const wrong = await request(seller, '/login', { email: seller.email, password: 'wrong' }, 401);
        assert.equal(wrong.toasts[0].type, 'error'); assert.match(wrong.toasts[0].text, /Неверный email или пароль/); checks.push('login failure preserves HTTP 401 and safe toast');
        await request(seller, '/login', { email: seller.email, password }, 302);
        await request(seller, '/api/messages/unread');
        await once(seller, '/profile', 'Вы вошли'); checks.push('login regeneration preserves flash; polling does not consume it');
        assert.notEqual(seller.token, guestToken);
        const beforeLogoutToken = seller.token;
        await rejects(seller, 'POST', '/logout', new URLSearchParams(), false, [guestToken]);
        await request(seller, '/profile');
        const oldCookie = seller.cookie;
        await request(seller, '/logout', {}, 302); assert.notEqual(seller.cookie, oldCookie);
        await once(seller, '/', 'Вы вышли');
        assert.notEqual(seller.token, beforeLogoutToken);
        await rejects(seller, 'POST', '/login', new URLSearchParams({ email: seller.email, password }), false, [beforeLogoutToken]);
        checks.push('CSRF rejects auth changes and invalidates tokens across both session rotations');
        await request({ cookie: oldCookie, token: '' }, '/profile', undefined, 302); checks.push('logout destroys old SID and flashes on clean guest session');
        await request(seller, '/login'); await request(seller, '/login', { email: seller.email, password }, 302); await request(seller, '/profile');
        const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: 'blue' } }).jpeg().toBuffer();
        function photoForm(create) {
            const form = new FormData(); form.append('_csrf', seller.token); form.append('images', new Blob([jpeg], { type: 'image/jpeg' }), 'test.jpg');
            if (create) for (const [key, value] of Object.entries({ title: 'Toast listing', description: 'Fixture', price: 10, country_id: country, category_id: category })) form.append(key, String(value));
            return form;
        }
        const createdListing = await request(seller, '/listings', photoForm(true), 200, true);
        const listing = (await db.execute('SELECT MAX(id) AS id FROM listings WHERE user_id=?', [seller.id]))[0][0].id;
        assert.equal(JSON.parse(createdListing.text).redirect, '/my-listings?created=' + listing);
        await once(seller, '/my-listings', 'Объявление создано'); checks.push('listing upload returns AJAX destination and one success flash');
        await request(seller, '/listings/' + listing + '/edit', { title: 'Updated toast listing', description: 'Changed', price: 20, category_id: category, country_id: country }, 302);
        await once(seller, '/listings/' + listing, 'Изменения объявления сохранены');
        await request(admin, '/login', { email: admin.email, password }, 302); await request(admin, '/profile');
        const approve = async () => {
            const [[row]] = await db.execute('SELECT review_version FROM listings WHERE id=?', [listing]);
            await request(admin, '/admin/moderation/' + listing, { mode:'approve', version:row.review_version, request_key:crypto.randomUUID() }, 303);
        };
        for (const [action, text] of [['publish', 'отправлено на проверку'], ['unpublish', 'снято с публикации'], ['publish', 'отправлено на проверку'], ['sold', 'проданное']]) {
            await request(seller, '/listings/' + listing + '/' + action, {}, 302); await once(seller, '/my-listings', text);
            if (action === 'publish') await approve();
        }
        checks.push('edit, publish, unpublish, sold: single success flashes');
        await db.execute("UPDATE listings SET status='draft' WHERE id=?", [listing]);
        const uploaded = await request(seller, '/listings/' + listing + '/images', photoForm(false), 200, true);
        assert.equal(JSON.parse(uploaded.text).redirect, '/listings/' + listing + '/edit');
        const editPage = await once(seller, '/listings/' + listing + '/edit', 'Фотографии добавлены');
        assert.match(editPage.text, /data-existing-count="2"/);
        assert.match(editPage.text, /src="\/js\/listing-upload.js"/);
        const image = (await db.execute('SELECT id FROM listing_images WHERE listing_id=? LIMIT 1', [listing]))[0][0].id;
        await request(seller, '/listings/' + listing + '/images/' + image + '/delete', { _csrf: seller.token }, 302);
        await once(seller, '/listings/' + listing + '/edit', 'Фотография удалена'); checks.push('upload and delete photo flashes');
        const badForm = new FormData(); badForm.append('_csrf', seller.token); badForm.append('images', new Blob(['<html>bad</html>'], { type: 'image/jpeg' }), 'bad.html');
        const badUpload = await request(seller, '/listings/' + listing + '/images', badForm, 400);
        assert.equal(badUpload.toasts[0].type, 'error'); assert.equal((await request(seller, '/profile')).toasts.length, 0); checks.push('upload error is a toast, no false success');
        const invalidProfile = await request(seller, '/profile/phone', { _csrf: seller.token, phone: 'invalid' }, 400); assert.equal(invalidProfile.toasts[0].type, 'error');
        await request(seller, '/profile/phone', { _csrf: seller.token, phone: '+380501234567', phone_public: '1' }, 303);
        await once(seller, '/profile', 'Телефон и его публичность обновлены');
        await request(seller, '/profile/phone', { _csrf: seller.token, phone: '+380501234567' }, 303);
        await once(seller, '/profile', 'Настройки профиля сохранены'); checks.push('profile validation, phone and public visibility');
        await request(seller, '/listings/' + listing + '/publish', {}, 302); await request(seller, '/profile'); await approve();
        await request(buyer, '/login', { email: buyer.email, password }, 302); await request(buyer, '/profile');
        const favorite = await fetch(base + '/api/favorites/' + listing, { method: 'PUT', headers: { cookie: buyer.cookie, 'X-CSRF-Token': buyer.token } });
        assert.equal(favorite.status, 200); assert.equal((await request(buyer, '/profile')).toasts.length, 0); checks.push('AJAX favorite success does not create duplicate server flash');
        const started = await request(buyer, '/messages/start', { _csrf: buyer.token, listing_id: listing }, 303);
        const conversation = started.response.headers.get('location').split('/').at(-1);
        const sent = await request(buyer, '/api/messages/' + conversation, { body: 'Toast message', client_key: crypto.randomUUID() }, 200, true);
        assert.ok(JSON.parse(sent.text).message.id); await request(buyer, '/api/messages/unread');
        assert.equal((await request(buyer, '/messages/' + conversation)).toasts.length, 0); checks.push('message polling/send do not duplicate client toast');
        await request(admin, '/login', { email: admin.email, password }, 302); await request(admin, '/profile');
        const action = extra => ({ reason: 'Toast test', request_key: crypto.randomUUID(), _csrf: admin.token, ...extra });
        const pendingReport = (await db.execute("INSERT INTO reports(author_id,listing_id,reason,comment) VALUES (?,?,'spam','Toast fixture')", [buyer.id, listing]))[0].insertId;
        const photoId = (await db.execute('SELECT id FROM listing_images WHERE listing_id=? LIMIT 1', [listing]))[0][0].id;
        const notice = (await db.execute('SELECT id FROM notifications WHERE user_id=? LIMIT 1', [seller.id]))[0][0].id;
        const tables = ['users', 'listings', 'listing_images', 'favorites', 'conversations', 'messages', 'notifications', 'reports', 'admin_logs'];
        const snapshot = async () => Promise.all(tables.map(async table => (await db.query('SELECT * FROM ' + table))[0]));
        const before = await snapshot();
        const imageService = require('../services/listingImages');
        const createJob = imageService.createJob;
        let jobs = 0;
        imageService.createJob = (...args) => { jobs++; return createJob(...args); };
        try {
            await rejects(seller, 'POST', '/listings', photoForm(true), true);
            await rejects(seller, 'POST', '/listings/' + listing + '/images', photoForm(false), true);
        } finally { imageService.createJob = createJob; }
        assert.equal(jobs, 0, 'Rejected multipart reached disk staging');
        const edit = { title: 'Changed title', description: 'Changed', price: 34, category_id: category, country_id: country };
        const adminForm = values => { const fields = action(values); delete fields._csrf; return fields; };
        for (const [user, path, fields] of [
            [seller, '/listings/' + listing + '/edit', edit],
            [seller, '/listings/' + listing + '/publish', {}],
            [seller, '/listings/' + listing + '/unpublish', {}],
            [seller, '/listings/' + listing + '/sold', {}],
            [seller, '/listings/' + listing + '/images/' + photoId + '/delete', {}],
            [seller, '/profile/phone', { phone: '+380501234568' }],
            [buyer, '/messages/start', { listing_id: listing }],
            [buyer, '/listings/' + listing + '/report', { reason: 'fraud' }],
            [admin, '/admin/users/' + buyer.id, adminForm({ status: 'blocked' })],
            [admin, '/admin/listings/' + listing, adminForm({ mode: 'block' })],
            [admin, '/admin/reports/' + pendingReport, adminForm({ status: 'accepted' })]
        ]) await rejects(user, 'POST', path, new URLSearchParams(fields));
        for (const [user, method, path] of [
            [buyer, 'PUT', '/api/favorites/' + listing],
            [buyer, 'DELETE', '/api/favorites/' + listing],
            [buyer, 'POST', '/api/messages/' + conversation],
            [seller, 'POST', '/api/messages/' + conversation + '/read'],
            [seller, 'POST', '/api/notifications/' + notice + '/read'],
            [seller, 'POST', '/api/notifications/read-all'],
            [buyer, 'POST', '/api/listings/' + listing + '/phone']
        ]) await rejects(user, method, path, new URLSearchParams(), true);
        assert.deepEqual(await snapshot(), before);
        assert.equal((await request(seller, '/profile')).toasts.length, 0);
        checks.push('20 mutation/API endpoints reject missing and bad tokens without DB changes or upload staging');
        for (const [status, text] of [['blocked', 'заблокирован'], ['active', 'разблокирован']]) {
            await request(admin, '/admin/users/' + buyer.id, action({ status }), 303); await once(admin, '/admin/users/' + buyer.id, text);
        }
        await request(admin, '/admin/listings/' + listing, action({ mode: 'block' }), 303);
        await once(admin, '/admin/listings', 'снято с публикации'); checks.push('admin blocking/unblocking and moderation');
        const report = pendingReport;
        await request(admin, '/admin/reports/' + report, action({ status: 'accepted' }), 303); await once(admin, '/admin/reports', 'Жалоба обработана');
        const forbidden = await request(admin, '/admin/users/' + admin.id, action({ status: 'blocked' }), 400); assert.equal(forbidden.toasts[0].type, 'error'); checks.push('report processing and admin error toast');
        const escaped = await request(guest, '/test-escaped', {}, 400); assert.ok(escaped.text.includes('&lt;img')); assert.ok(!escaped.text.includes('<img src=x')); checks.push('server toast content HTML-escaped');
        const formError = await request(guest, '/search?min_price=20&max_price=10', undefined, 400);
        assert.ok(formError.text.includes('alert alert-danger')); assert.ok(!formError.text.includes('Действие не выполнено')); assert.ok(!formError.text.includes('action-result-page'));
        const htmlError = await request(guest, '/test-json-error', {}, 429);
        assert.match(htmlError.response.headers.get('content-type'), /text\/html/); assert.equal(htmlError.toasts[0].text, 'Повторите попытку позже.'); assert.equal(htmlError.response.headers.get('retry-after'), '7');
        const jsonError = await request(guest, '/test-json-error', {}, 429, true);
        assert.match(jsonError.response.headers.get('content-type'), /application\/json/); assert.equal(JSON.parse(jsonError.text).error, 'Повторите попытку позже.');
        checks.push('inline form errors retained; HTML/JSON content types and statuses preserved');
        let limited;
        for (let i = 0; i <= 120; i++) {
            const response = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: guest.cookie, 'X-CSRF-Token': guest.token }, body: 'email=&password=' });
            if (response.status === 429) { limited = { response, text: await response.text() }; break; }
            assert.equal(response.status, 401); await response.text();
        }
        assert.ok(limited); assert.match(limited.response.headers.get('retry-after'), /^[1-9]\d*$/); assert.equal(seeds(limited.text)[0].type, 'warning'); checks.push('HTTP 429 and Retry-After preserved with warning toast');
        console.log('Toast integration checks passed:', checks.length);
        for (const check of checks) console.log('OK:', check);
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (db) { await db.rollback(); await db.end(); }
        assert.equal(path.dirname(storage), storageParent); assert.ok(path.basename(storage).startsWith('toast-tests-'));
        await fs.rm(storage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        if (previousStorage === undefined) delete process.env.LISTING_IMAGE_STORAGE_ROOT; else process.env.LISTING_IMAGE_STORAGE_ROOT = previousStorage;
    }
}
verifyTestEnvironment().then(run).catch(error => { console.error('Toast checks failed:', error.code || error.name, error.message); process.exitCode = 1; });
