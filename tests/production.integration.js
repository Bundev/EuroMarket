const verifyTestEnvironment = require('./test-environment');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { execFileSync, fork, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { checkServerIdentity } = require('node:tls');
const crypto = require('node:crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const host = '127.0.0.1';
const root = path.resolve(__dirname, '..');
const settings = {
    ...process.env, DB_NAME: 'euromarket_test', SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    BIND_HOST: host, NODE_ENV: 'production', AUTH_RATE_STORE: 'mariadb',
    TRUSTED_PROXIES: host + '/32', CSP_MODE: 'report-only', DEBUG: '', NODE_DEBUG: '',
    PUBLIC_ORIGIN: 'https://market.example.invalid'
};

async function listen(server) {
    server.listen(0, host);
    await once(server, 'listening');
    return server.address().port;
}

function close(server) {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
}

async function launch(cwd, overrides = {}) {
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    const child = fork(path.join(root, 'index.js'), [], {
        cwd, env: { ...settings, PORT: String(port), ...overrides }, silent: true
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout starting application')), 12000);
            child.once('exit', code => { clearTimeout(timeout); reject(new Error('Startup exit ' + code)); });
            child.stdout.on('data', chunk => {
                if (String(chunk).includes(String(port))) { clearTimeout(timeout); resolve(); }
            });
        });
    } catch (error) { child.kill(); throw error; }
    return { port, child, stderr: () => stderr };
}

async function stop({ child }) {
    const exited = once(child, 'exit');
    child.send('shutdown');
    assert.equal((await exited)[0], 0);
}

function request(port, route, { ca, method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const client = ca ? https : http;
        const req = client.request({ hostname: host, port, path: route, method, headers, ca,
            ...(ca ? { checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate) } : {})
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('HTTP timeout')));
        req.end(body);
    });
}

async function run() {
    const db = mysql.createPool({
        host: settings.DB_HOST, port: Number(settings.DB_PORT || 3306), user: settings.DB_USER,
        password: settings.DB_PASSWORD, database: 'euromarket_test'
    });
    const uri = 'production-' + crypto.randomUUID() + '@example.invalid';
    const sessions = new Set();
    const rootDir = path.join(root, '.storage');
    let fixture, backend, proxy, dev, errors;
    try {
        assert.equal((await db.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        await fs.mkdir(rootDir, { recursive: true });
        fixture = await fs.mkdtemp(path.join(rootDir, 'production-test-'));
        for (const [key, value] of Object.entries({
            AUTH_RATE_STORE: 'memory', SESSION_SECRET: 'change-me', TRUSTED_PROXIES: '0.0.0.0/0',
            CSP_MODE: 'off', DB_PASSWORD: '', BIND_HOST: 'bad', DEBUG: '*', PUBLIC_ORIGIN: 'http://market.example.invalid'
        })) {
            const bad = spawnSync(process.execPath, [path.join(root, 'index.js')], { cwd: fixture, env: { ...settings, [key]: value }, timeout: 5000 });
            assert.equal(bad.status, 1, key);
            assert.doesNotMatch(String(bad.stderr), /node_modules|\bat .*:\d+/);
        }
        const openssl = process.env.TEST_OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
        const certPath = path.join(fixture, 'cert.pem'), keyPath = path.join(fixture, 'key.pem');
        execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
        const cert = await fs.readFile(certPath);
        const imageName = crypto.randomUUID() + '.webp';
        const imageDir = path.join(fixture, 'listing-images');
        await fs.mkdir(imageDir);
        await require('sharp')({ create: { width: 10, height: 10, channels: 3, background: 'blue' } })
            .webp().toFile(path.join(imageDir, imageName));
        backend = await launch(fixture, { LISTING_IMAGE_STORAGE_ROOT: fixture });
        proxy = https.createServer({ key: await fs.readFile(keyPath), cert }, (req, res) => {
            const upstream = http.request({
                hostname: host, port: backend.port, path: req.url, method: req.method,
                headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10' }
            }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
            upstream.on('error', () => res.writeHead(502).end());
            req.pipe(upstream);
        });
        const port = await listen(proxy);
        const direct = await request(backend.port, '/login');
        assert.equal(direct.status, 400);
        assert.ok(!direct.headers['set-cookie'] && !direct.headers['strict-transport-security']);

        let cookie = '';
        const secureRequest = async (route, options = {}) => {
            const result = await request(port, route, { ...options, ca: cert, headers: { cookie, ...options.headers } });
            if (result.headers['set-cookie']) {
                const signed = result.headers['set-cookie'][0];
                assert.match(signed, /; HttpOnly/i);
                assert.match(signed, /; Secure/i);
                assert.match(signed, /; SameSite=Lax/i);
                assert.ok(!/; Domain=/i.test(signed));
                cookie = signed.split(';')[0];
                sessions.add(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).slice(2).split('.')[0]);
            }
            return result;
        };
        const login = await secureRequest('/login', { headers: { 'x-forwarded-proto': 'http' } });
        assert.equal(login.status, 200);
        assert.equal(login.headers['x-frame-options'], 'DENY');
        assert.equal(login.headers['x-content-type-options'], 'nosniff');
        assert.equal(login.headers['strict-transport-security'], 'max-age=31536000');
        assert.match(login.headers['content-security-policy-report-only'], /script-src-attr 'none'/);
        assert.ok(!login.headers['x-powered-by'] && !login.headers['content-security-policy']);
        const robots = await secureRequest('/robots.txt', { headers: { host: 'untrusted.example.invalid' } });
        assert.match(robots.body.toString(), /Sitemap: https:\/\/market.example.invalid\/sitemap.xml/);
        assert.doesNotMatch(robots.body.toString(), /untrusted.example/);
        const tokenFrom = result => result.body.toString().match(/name="_csrf" value="([a-f0-9]{64})"/)[1];
        const token = tokenFrom(login);
        const password = crypto.randomBytes(20).toString('hex');
        const form = (values, csrf) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...values, ...(csrf ? { _csrf: csrf } : {}) }).toString() });
        assert.equal((await secureRequest('/register', form({ email: uri, name: 'Fixture', password }))).status, 403);
        assert.equal((await secureRequest('/register', form({ email: uri, name: 'Fixture', password }, token))).status, 303);
        assert.equal((await secureRequest('/login', form({ email: uri, password }, token))).status, 302);
        const profile = await secureRequest('/profile');
        assert.match(profile.body.toString(), /Мой профиль/);
        assert.notEqual(tokenFrom(profile), token);
        assert.equal((await secureRequest('/logout', form({}, token))).status, 403);
        assert.equal((await secureRequest('/logout', form({}, tokenFrom(profile)))).status, 302);
        assert.equal((await secureRequest('/profile')).status, 302);
        for (const asset of ['/css/main.css', '/js/listing-create-photos.js', '/js/toasts.js']) {
            const result = await secureRequest(asset);
            assert.equal(result.status, 200);
            assert.equal(result.headers['x-content-type-options'], 'nosniff');
        }
        const image = await secureRequest('/uploads/listings/' + imageName);
        assert.equal(image.status, 404);
        assert.equal(image.headers['x-content-type-options'], 'nosniff');
        for (const missing of ['/page-missing', '/api/page-missing', '/.env', '/uploads/listings/untrusted.html']) {
            const result = await secureRequest(missing);
            assert.equal(result.status, 404);
            assert.doesNotMatch(result.body.toString(), /node_modules|SELECT |password_hash/);
        }

        // Test the same boundary with an error containing synthetic sensitive fields.
        const failing = express();
        failing.set('trust proxy', false);
        failing.use(require('../middleware/httpSecurity')({ production: false, csp: 'enforce' }));
        failing.get('/api/error', () => {
            const error = new Error('SYNTHETIC_SECRET SELECT private SQL');
            error.code = 'ER_PARSE_ERROR';
            throw error;
        });
        failing.use(require('../middleware/httpErrors').handleError);
        errors = http.createServer(failing);
        const result = await request(await listen(errors), '/api/error');
        assert.equal(result.status, 500);
        assert.ok(result.headers['x-error-id']);
        assert.deepEqual(JSON.parse(result.body), { error: 'Внутренняя ошибка сервера.' });
        await close(errors); errors = null;

        dev = await launch(fixture, { NODE_ENV: 'development', AUTH_RATE_STORE: 'memory', TRUSTED_PROXIES: '', CSP_MODE: 'enforce' });
        const local = await request(dev.port, '/login', { headers: { 'x-forwarded-proto': 'https' } });
        assert.equal(local.status, 200);
        assert.doesNotMatch(local.headers['set-cookie'][0], /; Secure/i);
        sessions.add(decodeURIComponent(local.headers['set-cookie'][0].split(';')[0].split('=')[1]).slice(2).split('.')[0]);
        assert.ok(!local.headers['strict-transport-security']);
        assert.match(local.headers['content-security-policy'], /frame-ancestors 'none'/);
        assert.equal((await request(dev.port, '/search', { headers: { cookie: local.headers['set-cookie'][0].split(';')[0] } })).status, 200);
        assert.doesNotMatch(backend.stderr() + dev.stderr(), /SELECT |password_hash|SYNTHETIC_SECRET/);
        await stop(dev); dev = null;
        await close(proxy); proxy = null;
        await stop(backend); backend = null;
        console.log('Production checks passed: configuration, real TLS proxy, cookies, auth/CSRF, headers, HTTP errors, CSP modes and graceful shutdown.');
    } finally {
        if (errors) await close(errors);
        if (proxy) await close(proxy);
        if (dev) dev.child.kill();
        if (backend) backend.child.kill();
        for (const id of sessions) await db.execute('DELETE FROM sessions WHERE session_id=?', [id]);
        // The HMAC secret is unique to this test. Remove only this run's buckets.
        const source = '192.0.2.10';
        const buckets = [['source', source], ['registration-source', source], ['registration-email', uri],
            ['login-email', uri], ['login-pair', source, uri], ['bcrypt-gate']];
        for (const parts of buckets) {
            const key = crypto.createHmac('sha256', settings.SESSION_SECRET).update(JSON.stringify(parts)).digest('hex');
            await db.execute('DELETE FROM auth_rate_limits WHERE key_hash=?', [key]);
        }
        await db.execute('DELETE FROM users WHERE email=?', [uri]);
        await db.end();
        if (fixture && path.dirname(path.resolve(fixture)) === rootDir && path.basename(fixture).startsWith('production-test-')) {
            await fs.rm(fixture, { recursive: true, force: true });
        }
    }
}

verifyTestEnvironment().then(run).catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
