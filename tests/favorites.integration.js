const verifyTestEnvironment = require('./test-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

// Все SQL-запросы теста выполняются только в euromarket_test.
async function run() {
    let db;
    let server;
    let transactionStarted = false;
    try {
        db = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: 'euromarket_test'
        });
        const [[selected]] = await db.query('SELECT DATABASE() AS name');
        assert.equal(selected.name, 'euromarket_test');
        const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/001_create_favorites.sql'), 'utf8');
        const schema = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
        const normalize = sql => sql.replace(/\r\n/g, '\n').trim();
        assert.equal(normalize(schema.match(/CREATE TABLE IF NOT EXISTS favorites \([\s\S]*?;/)[0]), normalize(migration));
        await db.query(migration);
        const [[definition]] = await db.query('SHOW CREATE TABLE favorites');
        await db.query(migration);
        const [[repeated]] = await db.query('SHOW CREATE TABLE favorites');
        assert.equal(repeated['Create Table'], definition['Create Table']);
        assert.match(definition['Create Table'], /PRIMARY KEY \(`user_id`,`listing_id`\)/);
        assert.equal((definition['Create Table'].match(/ON DELETE CASCADE/g) || []).length, 2);

        // Контроллеры и модели получают то же тестовое соединение и транзакцию.
        const dbPath = require.resolve('../config/db');
        require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
        await require('./apply-migrations')(db);
        await db.beginTransaction();
        transactionStarted = true;
        const stamp = Date.now();
        const [countries] = await db.query("SELECT id FROM countries WHERE code = 'DE'");
        const countryId = countries[0]?.id ?? (await db.execute(
            "INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"
        ))[0].insertId;
        const categoryId = (await db.execute(
            "INSERT INTO categories(slug,name) VALUES (?,'Favorites test')",
            ['favorites-' + stamp]
        ))[0].insertId;
        const password = 'TemporaryFavoritesTest123';
        const hash = await bcrypt.hash(password, 4);
        const users = [];
        for (let index = 0; index < 2; index++) {
            const email = 'favorites-' + stamp + '-' + index + '@example.invalid';
            const [result] = await db.execute(
                "INSERT INTO users(name,email,password_hash) VALUES ('Favorites test',?,?)",
                [email, hash]
            );
            users.push({ id: result.insertId, email, cookie: '', token: '' });
        }
        const listings = [];
        const inactive = [];
        for (const status of [...Array(25).fill('active'), 'draft', 'sold', 'archived']) {
            const [result] = await db.execute(
                `INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status)
                 VALUES (?,?,?,'Favorites test','Fixture',10,'EUR',?)`,
                [users[0].id, categoryId, countryId, status]
            );
            (status === 'active' ? listings : inactive).push(result.insertId);
        }
        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '../views'));
        app.use(express.static(path.join(__dirname, '../public')));
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));
        app.use(session({ secret: 'temporary-favorites-test-secret', resave: false, saveUninitialized: false }));
        app.use(require('../middleware/pageContext'));
        for (const name of ['home', 'auth', 'profile', 'listing', 'search', 'city', 'favorite']) {
            app.use(require('../routes/' + name + '.routes'));
        }
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        const base = 'http://127.0.0.1:' + server.address().port;
        let checks = 0;
        async function request(user, route, method = 'GET', status = 200, options = {}) {
            const response = await fetch(base + route, {
                method,
                redirect: 'manual',
                headers: {
                    cookie: user.cookie,
                    'X-CSRF-Token': options.token ?? user.token,
                    'content-type': 'application/json'
                },
                ...(options.body ? { body: JSON.stringify(options.body) } : {})
            });
            const text = await response.text();
            assert.equal(response.status, status, method + ' ' + route + '\n' + text);
            const cookie = response.headers.get('set-cookie');
            if (cookie) user.cookie = cookie.split(';')[0];
            checks++;
            return { text, response };
        }
        const ids = html => [...html.matchAll(/data-favorite-id="(\d+)"/g)].map(match => Number(match[1]));
        const guest = { cookie: '', token: '' };
        const endpoint = '/api/favorites/' + listings[0];
        await request(guest, endpoint, 'PUT', 403);
        guest.token = (await request(guest, '/login')).text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        await request(guest, endpoint, 'PUT', 401);
        const redirect = await request(guest, '/favorites', 'GET', 302);
        assert.equal(redirect.response.headers.get('location'), '/login');
        for (const user of users) {
            const { text: loginPage } = await request(user, '/login');
            user.token = loginPage.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
            await request(user, '/login', 'POST', 302, { body: { email: user.email, password } });
            const { text } = await request(user, '/');
            user.token = text.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        }
        const [first, second] = users;
        for (const token of ['', 'wrong', 'x'.repeat(64), 'é'.repeat(64), second.token]) {
            await request(first, endpoint, 'PUT', 403, { token });
        }
        await request(first, '/api/favorites/0', 'PUT', 400);
        await request(first, '/api/favorites/1.5', 'PUT', 400);
        await request(first, endpoint, 'PUT', 200, { body: { user_id: second.id } });
        await request(first, endpoint, 'PUT');
        const [[count]] = await db.execute(
            'SELECT COUNT(*) AS total FROM favorites WHERE user_id = ? AND listing_id = ?',
            [first.id, listings[0]]
        );
        assert.equal(count.total, 1);
        assert.equal((await db.execute('SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?', [second.id]))[0][0].total, 0);
        const detail = await request(first, '/listing/' + listings[0] + '/favorites-test');
        assert.ok(ids(detail.text).includes(listings[0]));
        assert.ok(detail.text.includes('aria-pressed="true"'));
        const main = await request(first, '/');
        assert.ok(main.text.includes('href="/favorites"'));
        assert.ok(main.text.includes('aria-pressed="true"'));
        const categoryPage = await request(first, '/category/favorites-' + stamp);
        assert.equal(ids(categoryPage.text).length, 20);
        assert.ok((await request(first, '/search')).text.includes('favorite-button'));
        assert.ok((await request(first, '/profile')).text.includes('href="/favorites"'));
        assert.ok(!ids((await request(second, '/favorites')).text).includes(listings[0]));
        await request(second, endpoint, 'PUT');
        await request(first, endpoint, 'DELETE');
        await request(first, endpoint, 'DELETE');
        assert.equal((await db.execute('SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?', [second.id]))[0][0].total, 1);
        for (const id of inactive) await request(first, '/api/favorites/' + id, 'PUT', 404);
        await request(first, '/api/favorites/4294967295', 'PUT', 404);
        for (const id of listings) await request(first, '/api/favorites/' + id, 'PUT');
        const saved = await request(first, '/favorites');
        const next = await request(first, '/favorites?page=2');
        assert.equal(ids(saved.text).length, 20);
        assert.equal(ids(next.text).length, 5);
        assert.equal(ids(saved.text).filter(id => ids(next.text).includes(id)).length, 0);
        assert.ok(saved.text.includes('id="searchTotal">25</span>'));
        await db.execute("UPDATE listings SET status = 'draft' WHERE id = ?", [listings[0]]);
        const hidden = await request(first, '/favorites');
        assert.ok(!ids(hidden.text).includes(listings[0]));
        assert.ok(hidden.text.includes('Недоступные объявления скрыты'));
        await request(first, endpoint, 'PUT', 404);
        await request(first, endpoint, 'DELETE');
        const sorted = await request(first, '/favorites?sort=price_asc&currency=EUR');
        assert.ok(!ids(sorted.text).includes(listings[0]));
        console.log('Favorites HTTP checks passed:', checks);
        console.log('Migration, uniqueness, auth, CSRF, user isolation, inactive listings, pagination and rendered buttons: OK');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) {
            if (transactionStarted) await db.rollback();
            await db.end();
        }
    }
}

verifyTestEnvironment().then(run).catch(error => {
    console.error(error.code || error.name, error.message);
    process.exitCode = 1;
});
