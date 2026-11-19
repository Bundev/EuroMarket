const verifyTestEnvironment = require('./test-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
        const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/003_create_messages.sql'), 'utf8');
        const statements = migration.split(';').map(sql => sql.trim()).filter(Boolean);
        for (let repeat = 0; repeat < 2; repeat++) for (const sql of statements) await db.query(sql);
        const schema = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
        for (const sql of statements) assert.ok(schema.replaceAll('\r\n', '\n').includes(sql.replaceAll('\r\n', '\n')));
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: db };
        await require('./apply-migrations')(db);
        await db.beginTransaction();
        const stamp = Date.now();
        const [countries] = await db.query("SELECT id FROM countries WHERE code='DE'");
        const country = countries[0]?.id ?? (await db.query(
            "INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"
        ))[0].insertId;
        const category = (await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Chat test')", ['chat-' + stamp]))[0].insertId;
        const password = 'TemporaryChatTest123';
        const hash = await bcrypt.hash(password, 4);
        const users = [];
        for (const name of ['Seller', 'Buyer', 'Stranger']) {
            const email = name.toLowerCase() + '-chat-' + stamp + '@example.invalid';
            const id = (await db.execute('INSERT INTO users(name,email,password_hash) VALUES (?,?,?)', [name, email, hash]))[0].insertId;
            users.push({ id, email, cookie: '', token: '' });
        }
        const [seller, buyer, stranger] = users;
        const listing = (await db.execute(
            `INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status)
             VALUES (?,?,?,'Chat fixture','Description',10,'EUR','active')`, [seller.id, category, country]
        ))[0].insertId;
        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '../views'));
        app.use(express.static(path.join(__dirname, '../public')));
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));
        app.use(session({ name: 'euromarket.sid', secret: 'messages-test-only', resave: false, saveUninitialized: false }));
        app.use(require('../middleware/pageContext'));
        for (const route of ['home', 'auth', 'profile', 'listing', 'search', 'favorite', 'message']) {
            app.use(require('../routes/' + route + '.routes'));
        }
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        const base = 'http://127.0.0.1:' + server.address().port;
        let checks = 0, buyerSends = 0;
        let api;
        async function request(user, url, method = 'GET', status = 200, body, token = user.token) {
            const response = await fetch(base + url, {
                method, redirect: 'manual',
                headers: { cookie: user.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            const text = await response.text();
            assert.equal(response.status, status, method + ' ' + url + ' -> ' + text);
            if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
            checks++;
            if (user === buyer && url === api && method === 'POST' && ![403, 404].includes(status)) buyerSends++;
            return { response, text };
        }
        for (const user of users) {
            const { text: loginPage } = await request(user, '/login');
            user.token = loginPage.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
            await request(user, '/login', 'POST', 302, { email: user.email, password });
            user.token = (await request(user, '/profile')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        }
        const guest = { cookie: '', token: '' };
        await request(guest, '/messages', 'GET', 302);
        await request(guest, '/api/messages/unread', 'GET', 401);
        await request(guest, '/messages/start', 'POST', 403, { listing_id: String(listing) });
        guest.token = (await request(guest, '/login')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        await request(guest, '/messages/start', 'POST', 302, { listing_id: String(listing) });
        await request(buyer, '/messages/start', 'POST', 403, { listing_id: String(listing) }, '');
        await request(seller, '/messages/start', 'POST', 404, { listing_id: String(listing) });
        const started = await request(buyer, '/messages/start', 'POST', 303, { listing_id: String(listing), buyer_id: stranger.id });
        const conversation = Number(started.response.headers.get('location').split('/').at(-1));
        const repeated = await request(buyer, '/messages/start', 'POST', 303, { listing_id: String(listing) });
        assert.equal(repeated.response.headers.get('location'), '/messages/' + conversation);
        assert.equal((await db.query('SELECT COUNT(*) AS n FROM conversations WHERE listing_id=?', [listing]))[0][0].n, 1);
        api = '/api/messages/' + conversation;
        await request(stranger, '/messages/' + conversation, 'GET', 404);
        await request(stranger, api, 'GET', 404);
        await request(stranger, api, 'POST', 404, { body: 'intrusion', client_key: crypto.randomUUID() });
        await request(stranger, api + '/read', 'POST', 404, { up_to: 4294967295 });
        await request(buyer, api, 'POST', 403, { body: 'x', client_key: crypto.randomUUID() }, '');
        const payload = { body: '<img src=x onerror=alert(1)> Hello', client_key: crypto.randomUUID(), sender_id: seller.id };
        const sent = JSON.parse((await request(buyer, api, 'POST', 200, payload)).text).message;
        assert.equal(sent.mine, true);
        assert.ok(!('sender_id' in sent));
        const replay = JSON.parse((await request(buyer, api, 'POST', 200, payload)).text).message;
        assert.equal(replay.id, sent.id);
        await request(buyer, api, 'POST', 409, { ...payload, body: 'different' });
        await request(buyer, api, 'POST', 400, { body: ' ', client_key: crypto.randomUUID() });
        await request(buyer, api, 'POST', 400, { body: 'x'.repeat(2001), client_key: crypto.randomUUID() });
        await request(buyer, api, 'POST', 400, { body: 'x', client_key: 'bad' });
        const unread = async user => JSON.parse((await request(user, '/api/messages/unread')).text).unread;
        assert.equal(await unread(seller), 1);
        const rendered = await request(seller, '/messages/' + conversation);
        assert.ok(rendered.text.includes('&lt;img'));
        assert.ok(!rendered.text.includes('<img src=x'));
        assert.equal(rendered.response.headers.get('cache-control'), 'no-store');
        await request(seller, api);
        assert.equal(await unread(seller), 1); // GET не отмечает сообщения прочитанными.
        await request(seller, api + '/read', 'POST', 200, { up_to: sent.id });
        assert.equal(await unread(seller), 0);
        assert.equal(JSON.parse((await request(buyer, api + '?after=' + sent.id)).text).readThrough, sent.id);
        const reply = JSON.parse((await request(seller, api, 'POST', 200, { body: 'Reply', client_key: crypto.randomUUID() })).text).message;
        assert.equal(await unread(buyer), 1);
        await request(buyer, api + '/read', 'POST', 200, { up_to: sent.id });
        assert.equal(await unread(buyer), 1);
        await request(buyer, api + '/read', 'POST', 200, { up_to: reply.id });
        assert.equal(await unread(buyer), 0);
        await request(buyer, api + '?after=bad', 'GET', 400);
        await db.execute("UPDATE listings SET status='draft' WHERE id=?", [listing]);
        await request(buyer, '/messages/start', 'POST', 404, { listing_id: String(listing) });
        assert.ok((await request(buyer, '/messages/' + conversation)).text.includes('Переписка сохранена'));
        await request(buyer, api, 'POST', 200, { body: 'Still in touch', client_key: crypto.randomUUID() });
        await db.execute('DELETE FROM listings WHERE id=?', [listing]);
        assert.equal((await db.execute('SELECT listing_id FROM conversations WHERE id=?', [conversation]))[0][0].listing_id, null);
        await request(buyer, '/messages/' + conversation);
        await request(buyer, api, 'POST', 200, { body: 'After deletion', client_key: crypto.randomUUID() });
        await db.execute("UPDATE users SET status='blocked' WHERE id=?", [seller.id]);
        await request(buyer, api, 'POST', 409, { body: 'Blocked', client_key: crypto.randomUUID() });
        await request(seller, api, 'GET', 401);
        await db.execute("UPDATE users SET status='active' WHERE id=?", [seller.id]);
        for (let i = 0; i < 55; i++) await db.execute(
            'INSERT INTO messages(conversation_id,sender_id,body,client_key) VALUES (?,?,?,?)',
            [conversation, seller.id, 'History ' + i, crypto.randomUUID()]
        );
        const latest = JSON.parse((await request(buyer, api)).text);
        assert.equal(latest.messages.length, 50);
        assert.equal(latest.hasMore, true);
        const older = JSON.parse((await request(buyer, api + '?before=' + latest.messages[0].id)).text);
        const all = [...older.messages, ...latest.messages];
        assert.equal(new Set(all.map(item => item.id)).size, all.length);
        assert.ok(all.every((item, index) => index === 0 || all[index - 1].id < item.id));
        const firstBatch = JSON.parse((await request(buyer, api + '?after=0')).text);
        assert.equal(firstBatch.messages.length, 50);
        const secondBatch = JSON.parse((await request(buyer, api + '?after=' + firstBatch.messages.at(-1).id)).text);
        assert.equal(firstBatch.messages.length + secondBatch.messages.length, all.length);
        while (buyerSends < 30) await request(buyer, api, 'POST', 200, { body: 'Rate test', client_key: crypto.randomUUID() });
        const limited = await request(buyer, api, 'POST', 429, { body: 'Limited', client_key: crypto.randomUUID() });
        assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
        assert.ok((await request(buyer, '/messages')).text.includes('Chat fixture'));
        assert.ok(!(await request(stranger, '/messages')).text.includes('Chat fixture'));
        console.log('Messages HTTP checks passed:', checks);
        console.log('Migration, duplicate prevention, authorization, escaping, CSRF, history, receipts, unread, retry and unavailable listings: OK');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) { await db.rollback(); await db.end(); }
    }
}
verifyTestEnvironment().then(run).catch(error => {
    console.error('Messages verification failed:', error.code || error.name, error.message);
    process.exitCode = 1;
});
