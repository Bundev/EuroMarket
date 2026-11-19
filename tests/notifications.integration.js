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
        const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/004_create_notifications.sql'), 'utf8');
        const [tablePart, rest] = migration.split('DELIMITER $$');
        const statements = [
            ...tablePart.split(';').map(s => s.trim()).filter(Boolean),
            ...rest.split('DELIMITER ;')[0].split('$$').map(s => s.trim()).filter(Boolean)
        ];
        for (let repeat = 0; repeat < 2; repeat++) for (const statement of statements) await db.query(statement);
        assert.ok(fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8').replaceAll('\r\n', '\n').includes(migration.replaceAll('\r\n', '\n')));
        const adapter = {
            execute: db.execute.bind(db), query: db.query.bind(db),
            async getConnection() {
                return {
                    execute: db.execute.bind(db), query: db.query.bind(db),
                    beginTransaction: () => db.query('SAVEPOINT notification_test'),
                    commit: () => db.query('RELEASE SAVEPOINT notification_test'),
                    async rollback() {
                        await db.query('ROLLBACK TO SAVEPOINT notification_test');
                        await db.query('RELEASE SAVEPOINT notification_test');
                    },
                    release() {}, destroy() {}
                };
            }
        };
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: adapter };
        await require('./apply-migrations')(db);
        await db.beginTransaction();
        const stamp = Date.now();
        const [countries] = await db.query("SELECT id FROM countries WHERE code='DE'");
        const country = countries[0]?.id ?? (await db.query(
            "INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"
        ))[0].insertId;
        const category = (await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Notifications')", ['notifications-' + stamp]))[0].insertId;
        const password = 'TemporaryNotifications123';
        const hash = await bcrypt.hash(password, 4);
        const users = [];
        for (const name of ['Seller', 'Buyer', 'Stranger']) {
            const email = name + '-notification-' + stamp + '@example.invalid';
            const id = (await db.execute('INSERT INTO users(name,email,password_hash) VALUES (?,?,?)', [name, email, hash]))[0].insertId;
            users.push({ id, email, cookie: '', token: '' });
        }
        const [seller, buyer, stranger] = users;
        const listing = (await db.execute(
            `INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status)
             VALUES (?,?,?,'Notification fixture','Description',10,'EUR','active')`, [seller.id, category, country]
        ))[0].insertId;
        const messages = require('../models/message.model');
        const notices = require('../models/notification.model');
        const listings = require('../models/listing.model');
        const conversation = await messages.start(buyer.id, listing);
        const key = crypto.randomUUID();
        await messages.send(conversation, buyer.id, 'Message', key);
        await messages.send(conversation, buyer.id, 'Message', key);
        assert.equal(await notices.count(seller.id), 1);
        assert.equal(await notices.count(buyer.id), 0);
        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '../views'));
        app.use(express.static(path.join(__dirname, '../public')));
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));
        app.use(session({ name: 'euromarket.sid', secret: 'notifications-test', resave: false, saveUninitialized: false }));
        app.use(require('../middleware/pageContext'));
        for (const route of ['home', 'auth', 'profile', 'listing', 'search', 'message', 'notification', 'favorite']) {
            app.use(require('../routes/' + route + '.routes'));
        }
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        const base = 'http://127.0.0.1:' + server.address().port;
        let checks = 0;
        async function request(user, url, method = 'GET', status = 200, body, token = user.token) {
            const response = await fetch(base + url, {
                method, redirect: 'manual',
                headers: { cookie: user.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            const text = await response.text();
            assert.equal(response.status, status, url);
            if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
            checks++;
            return { response, text };
        }
        for (const user of users) {
            const { text: loginPage } = await request(user, '/login');
            user.token = loginPage.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
            await request(user, '/login', 'POST', 302, { email: user.email, password });
            user.token = (await request(user, '/profile')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        }
        const guest = { cookie: '', token: '' };
        await request(guest, '/notifications', 'GET', 302);
        await request(guest, '/api/notifications', 'GET', 401);
        const data = JSON.parse((await request(seller, '/api/notifications')).text);
        assert.equal(data.unread, 1);
        assert.equal(data.items.length, 1);
        assert.ok(!('user_id' in data.items[0]));
        const notification = data.items[0].id;
        assert.equal((await request(seller, '/notifications')).response.headers.get('cache-control'), 'no-store');
        assert.ok((await request(seller, '/notifications')).text.includes('Notification fixture'));
        assert.ok(!(await request(stranger, '/notifications')).text.includes('Notification fixture'));
        await request(stranger, '/api/notifications/' + notification + '/read', 'POST', 404, {});
        await request(stranger, '/notifications/' + notification + '/open', 'GET', 404);
        await request(seller, '/api/notifications/' + notification + '/read', 'POST', 403, {}, '');
        const target = await request(seller, '/notifications/' + notification + '/open', 'GET', 302);
        assert.equal(target.response.headers.get('location'), '/messages/' + conversation);
        await request(seller, '/api/notifications/' + notification + '/read', 'POST', 200, {});
        await request(seller, '/api/notifications/' + notification + '/read', 'POST', 200, {});
        assert.equal(await notices.count(seller.id), 0);
        assert.equal(await messages.unreadCount(seller.id), 1); // Это независимые счётчики.
        await listings.unpublishListing(listing, seller.id);
        assert.equal((await notices.list(seller.id)).items.length, 1);
        assert.equal((await db.query('SELECT @euromarket_actor_user_id AS actor'))[0][0].actor, null);
        await db.execute("UPDATE users SET role='admin' WHERE id=?", [stranger.id]);
        await listings.publishListing(listing, seller.id);
        const [[pending]] = await db.execute('SELECT review_version FROM listings WHERE id=?', [listing]);
        await require('../models/admin.model').decideListing(stranger.id, listing, pending.review_version,
            'approve', 'Test approval', crypto.randomUUID(), true);
        assert.equal(await notices.count(seller.id), 1);
        await db.execute("UPDATE listings SET status='active' WHERE id=?", [listing]);
        assert.equal(await notices.count(seller.id), 1);
        await listings.markListingSold(listing, seller.id);
        assert.equal(await notices.count(seller.id), 1);
        await db.execute("UPDATE listings SET status='archived' WHERE id=?", [listing]);
        assert.equal(await notices.count(seller.id), 2);
        const statusNotice = (await notices.list(seller.id)).items[0];
        assert.equal((await request(seller, '/notifications/' + statusNotice.id + '/open', 'GET', 302)).response.headers.get('location'), '/listings/' + listing);
        for (let i = 0; i < 24; i++) await messages.send(conversation, buyer.id, 'Another message', crypto.randomUUID());
        const latest = JSON.parse((await request(seller, '/api/notifications')).text);
        assert.equal(latest.items.length, 5);
        const full = await notices.list(seller.id);
        const second = await notices.list(seller.id, 2);
        assert.equal(full.items.length, 20);
        assert.equal(second.items.length, 7);
        assert.equal(new Set([...full.items, ...second.items].map(item => item.id)).size, 27);
        await request(seller, '/notifications?page=9999999999');
        const upTo = latest.items[0].id;
        await messages.send(conversation, buyer.id, 'Newer event', crypto.randomUUID());
        await request(seller, '/api/notifications/read-all', 'POST', 403, { up_to: upTo }, '');
        await request(seller, '/api/notifications/read-all', 'POST', 400, { up_to: [1] });
        await request(seller, '/api/notifications/read-all', 'POST', 200, { up_to: upTo });
        assert.equal(await notices.count(seller.id), 1);
        const counts = JSON.parse((await request(seller, '/api/messages/unread')).text);
        assert.equal(counts.notifications, 1);
        assert.ok(counts.unread > 0);
        await db.execute('INSERT INTO favorites(user_id,listing_id) VALUES (?,?)', [buyer.id, listing]);
        assert.equal(await notices.count(seller.id), 1);
        await db.execute('DELETE FROM listings WHERE id=?', [listing]);
        await request(seller, '/notifications/' + statusNotice.id + '/open', 'GET', 404);
        await request(seller, '/notifications/' + notification + '/open', 'GET', 302);
        console.log('Notifications HTTP checks passed:', checks);
        console.log('Atomic events, retries, owner suppression, isolation, target access, CSRF, pagination, read-all snapshot and shared polling: OK');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) { await db.rollback(); await db.end(); }
    }
}
verifyTestEnvironment().then(run).catch(error => {
    console.error('Notifications verification failed:', error.code || error.name, error.message);
    process.exitCode = 1;
});
