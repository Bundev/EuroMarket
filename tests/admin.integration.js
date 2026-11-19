require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
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
        await require('./apply-migrations')(db);
        await require('./apply-migrations')(db);
        await db.beginTransaction();
        let failAudit = false;
        const execute = async (sql, params) => {
            if (failAudit && sql.startsWith('INSERT INTO admin_logs')) {
                failAudit = false;
                const error = new Error('Test transaction rollback');
                error.code = 'ER_TEST_ROLLBACK';
                throw error;
            }
            return db.execute(sql, params);
        };
        const adapter = {
            execute, query: db.query.bind(db),
            async getConnection() {
                const savepoint = 'admin_test_' + crypto.randomBytes(8).toString('hex');
                return {
                    execute, query: db.query.bind(db),
                    beginTransaction: () => db.query('SAVEPOINT ' + savepoint),
                    commit: () => db.query('RELEASE SAVEPOINT ' + savepoint),
                    async rollback() {
                        await db.query('ROLLBACK TO SAVEPOINT ' + savepoint);
                        await db.query('RELEASE SAVEPOINT ' + savepoint);
                    },
                    release() {}, destroy() {}
                };
            }
        };
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: adapter };
        const stamp = Date.now(), password = crypto.randomBytes(24).toString('hex');
        const [countries] = await db.query("SELECT id FROM countries WHERE code='DE'");
        const country = countries[0]?.id ?? (await db.query("INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"))[0].insertId;
        const category = (await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Admin test')", ['admin-' + stamp]))[0].insertId;
        const hash = await bcrypt.hash(password, 4), users = [];
        for (const [name, role] of [['Admin','admin'],['Seller','user'],['Buyer','user']]) {
            const email = name + '-admin-test-' + stamp + '@example.invalid';
            const id = (await db.execute('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)', [name, email, hash, role]))[0].insertId;
            users.push({ id, email, cookie: '', token: '' });
        }
        const [admin, seller, buyer] = users;
        const listing = (await db.execute(
            `INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status)
             VALUES (?,?,?,'Moderation fixture','Description',10,'EUR','active')`, [seller.id, category, country]
        ))[0].insertId;
        const app = express();
        app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '../views'));
        app.use(express.static(path.join(__dirname, '../public')));
        app.use(express.json()); app.use(express.urlencoded({ extended: false }));
        app.use(session({ name: 'euromarket.sid', secret: 'admin-test-only', resave: false, saveUninitialized: false }));
        app.use(require('../middleware/pageContext'));
        for (const route of ['home','auth','profile','listing','search','message','notification','favorite','admin']) app.use(require('../routes/' + route + '.routes'));
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
            assert.equal(response.status, status, method + ' ' + url + ' -> ' + text);
            if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
            checks++;
            return { response, text };
        }
        async function login(user, expected = 302) {
            const { text: loginPage } = await request(user, '/login');
            user.token = loginPage.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
            await request(user, '/login', 'POST', expected, { email: user.email, password });
            if (expected === 302) user.token = (await request(user, '/profile')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        }
        for (const user of users) await login(user);
        const guest = { cookie: '', token: '' };
        await request(guest, '/admin', 'GET', 302);
        for (const route of ['/admin','/admin/users','/admin/listings','/admin/reports','/admin/logs']) {
            await request(buyer, route, 'GET', 403);
            await request(admin, route);
        }
        await request(admin, '/admin/users/' + seller.id);
        await request(admin, '/admin/users?search=' + encodeURIComponent("' OR 1=1 --"));
        await request(admin, '/admin/listings?country=' + encodeURIComponent('1 OR 1=1'), 'GET', 400);
        await request(admin, '/admin/listings?status=invalid', 'GET', 400);
        const action = (extra = {}) => ({ reason: 'Moderation test', request_key: crypto.randomUUID(), ...extra });
        await request(buyer, '/admin/listings/' + listing, 'POST', 403, action({ mode:'block',role:'admin' }));
        await request(admin, '/admin/listings/' + listing, 'POST', 403, action({ mode:'block' }), '');
        await request(admin, '/admin/users/' + admin.id, 'POST', 400, action({ status:'blocked' }));
        const reportUrl = '/listings/' + listing + '/report';
        await request(buyer, reportUrl, 'POST', 403, { reason:'fraud',comment:'test' }, '');
        await request(seller, reportUrl, 'POST', 404, { reason:'fraud',comment:'self' });
        await request(buyer, reportUrl, 'POST', 303, { reason:'fraud',comment:'<script>test</script>' });
        await request(buyer, reportUrl, 'POST', 303, { reason:'spam',comment:'duplicate' });
        await request(buyer, reportUrl, 'POST', 400, { reason:'invalid' });
        const [reports] = await db.execute('SELECT id FROM reports WHERE listing_id=?', [listing]);
        assert.equal(reports.length, 1);
        const report = reports[0].id;
        const html = (await request(admin, '/admin/reports')).text;
        assert.ok(html.includes('&lt;script&gt;'));
        const decision = action({ status:'accepted' });
        await request(admin, '/admin/reports/' + report, 'POST', 303, decision);
        await request(admin, '/admin/reports/' + report, 'POST', 303, decision);
        await request(admin, '/admin/reports/' + report, 'POST', 409, action({ status:'rejected' }));
        await request(buyer, reportUrl, 'POST', 303, { reason:'other',comment:'new open report' });
        const [[secondReport]] = await db.execute("SELECT id FROM reports WHERE listing_id=? AND status='open'", [listing]);
        await request(admin, '/admin/reports/' + secondReport.id, 'POST', 303, action({ status:'rejected' }));
        const row = async () => (await db.execute('SELECT status,moderation_locked FROM listings WHERE id=?', [listing]))[0][0];
        const notices = async () => (await db.execute('SELECT COUNT(*) AS n FROM notifications WHERE user_id=?', [seller.id]))[0][0].n;
        failAudit = true;
        await request(admin, '/admin/listings/' + listing, 'POST', 500, action({ mode:'block' }));
        assert.equal((await row()).status, 'active'); assert.equal(await notices(), 0);
        const moderation = action({ mode:'block',reason:'Unsafe content' });
        await request(admin, '/admin/listings/' + listing, 'POST', 303, moderation);
        await request(admin, '/admin/listings/' + listing, 'POST', 303, moderation);
        assert.equal((await row()).status, 'draft'); assert.equal((await row()).moderation_locked, 1); assert.equal(await notices(), 1);
        await request(seller, '/listings/' + listing + '/publish', 'POST', 404, { moderation_locked:0,status:'active' });
        await assert.rejects(db.execute("UPDATE listings SET status='active' WHERE id=?", [listing]), error => error.code === 'ER_SIGNAL_EXCEPTION');
        await request(buyer, '/listings/' + listing, 'GET', 404);
        await request(admin, '/listings/' + listing);
        await request(buyer, reportUrl, 'POST', 404, { reason:'fraud' });
        await request(buyer, reportUrl, 'POST', 429, { reason:'fraud' });
        await request(admin, '/admin/listings/' + listing, 'POST', 303, action({ mode:'unblock' }));
        await request(seller, '/listings/' + listing + '/publish', 'POST', 302);
        assert.equal((await row()).status, 'pending_review'); assert.equal(await notices(), 2);
        const block = action({ status:'blocked' });
        await request(admin, '/admin/users/' + seller.id, 'POST', 303, block);
        await request(admin, '/admin/users/' + seller.id, 'POST', 303, block);
        assert.equal((await row()).moderation_locked, 1);
        await request(seller, '/profile', 'GET', 302);
        await request(seller, '/api/messages/unread', 'GET', 401);
        await login(seller, 401);
        await request(buyer, '/listings/' + listing, 'GET', 404);
        await request(admin, '/admin/users/' + seller.id, 'POST', 303, action({ status:'active' }));
        await login(seller);
        await request(seller, '/listings/' + listing + '/publish', 'POST', 404);
        await request(admin, '/admin/listings/' + listing, 'POST', 303, action({ mode:'unblock' }));
        await request(seller, '/listings/' + listing + '/publish', 'POST', 302);
        await db.execute("UPDATE users SET role='user' WHERE id=?", [admin.id]);
        await request(admin, '/admin', 'GET', 403);
        await request(admin, '/admin/listings/' + listing, 'POST', 403, action({ mode:'block',role:'admin' }));
        await db.execute("UPDATE users SET role='admin' WHERE id=?", [admin.id]);
        await db.execute("UPDATE users SET status='blocked' WHERE id=?", [seller.id]);
        await assert.rejects(db.execute("UPDATE listings SET status='active' WHERE id=?", [listing]), error => error.code === 'ER_SIGNAL_EXCEPTION');
        await db.execute("UPDATE users SET status='active' WHERE id=?", [seller.id]);
        const logPage = await request(admin, '/admin/logs');
        assert.ok(logPage.text.includes('Unsafe content'));
        const [logs] = await db.execute('SELECT admin_id,reason FROM admin_logs WHERE admin_id=?', [admin.id]);
        assert.equal(logs.length, 7);
        assert.ok(logs.every(log => log.admin_id === admin.id && log.reason));
        assert.equal((await db.query('SELECT @euromarket_actor_user_id AS actor'))[0][0].actor, null);
        await request(admin, '/admin/users?page=99999999');
        await request(admin, '/admin/listings?country=' + country + '&category=' + category + '&status=active');
        const adminModel = require('../models/admin.model');
        for (let i = 0; i < 22; i++) {
            const userId = (await db.execute('INSERT INTO users(name,email,password_hash) VALUES (?,?,?)',
                ['Pagination user ' + i, 'pagination-admin-' + stamp + '-' + i + '@example.invalid', hash]))[0].insertId;
            const listingId = (await db.execute(
                "INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status) VALUES (?,?,?,?,'Fixture',10,'EUR','active')",
                [userId, category, country, 'Pagination listing ' + i]
            ))[0].insertId;
            await adminModel.createReport(buyer.id, listingId, 'spam', 'Pagination report');
        }
        assert.equal((await adminModel.users('Pagination user', 2)).items.length, 2);
        assert.equal((await adminModel.listings({ search:'Pagination listing' }, 2)).items.length, 2);
        assert.equal((await adminModel.reports('open', 2)).items.length, 2);
        assert.equal((await adminModel.users("' OR 1=1 --", 1)).total, 0);
        await request(admin, '/admin/users?search=Pagination&page=2');
        await request(admin, '/admin/listings?search=Pagination&page=2');
        await request(admin, '/admin/reports?status=open&page=2');
        console.log('Admin HTTP checks passed:', checks);
        console.log('Role checks, blocked sessions, reports, CSRF, injection, audit, rollback, retries and moderation publication guard: OK');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) { await db.rollback(); await db.end(); }
    }
}
run().catch(error => {
    console.error('Admin verification failed:', error.code || error.name, error.message);
    process.exitCode = 1;
});
