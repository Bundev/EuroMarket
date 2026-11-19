require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql2/promise');
const express = require('express');
const session = require('express-session');
const sharp = require('sharp');

async function run() {
    const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: 'euromarket_test', connectionLimit: 5 });
    let server, user, admin, category, country, createdCountry = false, fault;
    const jobs = new Set();
    const outputs = new Set();
    const checks = [];
    const storageParent = path.resolve(__dirname, '../.storage');
    const storageRoot = path.join(storageParent, 'image-tests-' + crypto.randomUUID());
    const previousStorage = process.env.LISTING_IMAGE_STORAGE_ROOT;
    process.env.LISTING_IMAGE_STORAGE_ROOT = storageRoot;
    const privateRoot = path.join(storageRoot, 'listing-images');
    const uploadRoot = path.join(storageRoot, 'listing-uploads');
    try {
        assert.equal((await pool.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        // Inject ONLY the test pool; all model and transaction connections use it.
        const database = {
            execute: (...args) => pool.execute(...args), query: (...args) => pool.query(...args),
            async getConnection() {
                const connection = await pool.getConnection();
                return {
                    beginTransaction: () => connection.beginTransaction(),
                    rollback: () => connection.rollback(), release: () => connection.release(), destroy: () => connection.destroy(),
                    execute: (...args) => connection.execute(...args),
                    query: async (...args) => {
                        if (fault === 'sql' && /INSERT INTO listing_images/.test(args[0])) {
                            fault = null;
                            return connection.query('INSERT INTO euromarket_test.__image_test_missing_table VALUES (1)');
                        }
                        return connection.query(...args);
                    },
                    async commit() {
                        if (fault === 'commit-before') { fault = null; throw Object.assign(new Error('Injected commit failure'), { code: 'TEST_COMMIT' }); }
                        await connection.commit();
                        if (fault === 'commit-after') { fault = null; throw Object.assign(new Error('Injected lost acknowledgement'), { code: 'TEST_COMMIT_ACK' }); }
                    }
                };
            }
        };
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: database };
        const images = require('../services/listingImages');
        const stamp = crypto.randomUUID();
        user = (await pool.execute("INSERT INTO users(name,email,password_hash) VALUES ('Image test',?,'test-only-unusable-hash')", ['images-' + stamp + '@example.invalid']))[0].insertId;
        admin = (await pool.execute("INSERT INTO users(name,email,password_hash,role) VALUES ('Image moderator',?,'test-only','admin')", ['image-admin-' + stamp + '@example.invalid']))[0].insertId;
        category = (await pool.execute("INSERT INTO categories(slug,name) VALUES (?,'Image security test')", ['images-' + stamp]))[0].insertId;
        country = (await pool.execute("SELECT id FROM countries WHERE code='DE'"))[0][0]?.id;
        if (!country) { country = (await pool.execute("INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"))[0].insertId; createdCountry = true; }

        const app = express();
        app.set('views', path.resolve(__dirname, '../views')); app.set('view engine', 'ejs');
        app.use(require('../middleware/publicAssets'));
        app.use(express.urlencoded({ extended: false })); app.use(express.json());
        app.use(session({ secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false }));
        app.use('/uploads/listings', images.serve);
        // Test-only login endpoint; never loaded by the application.
        app.get('/test-login', (req, res) => { req.session.user = { id: user }; res.send('ok'); });
        app.get('/test-moderator', (req, res) => { req.session.user = { id: admin }; res.send('ok'); });
        app.use(require('../middleware/pageContext'));
        app.use((req, res, next) => {
            res.on('finish', () => {
                if (req.imageUpload) { jobs.add(req.imageUpload); req.imageUpload.outputs.forEach(name => outputs.add(name)); }
            }); next();
        });
        for (const route of ['listing', 'search', 'favorite', 'profile', 'admin']) app.use(require('../routes/' + route + '.routes'));
        server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
        const base = 'http://127.0.0.1:' + server.address().port;
        const login = await fetch(base + '/test-login');
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const createPage = await fetch(base + '/listings/create', { headers: { cookie } });
        const html = await createPage.text();
        const token = html.match(/name="favorites-csrf-token" content="([a-f0-9]+)"/)[1];
        assert.match(html, /name="_csrf"/);
        const generated = {};
        for (const format of ['jpeg', 'png', 'webp']) generated[format] = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#678abc' } }).toFormat(format).toBuffer();
        const photo = (buffer = generated.jpeg, name = 'photo.jpg', type = 'image/jpeg') => ({ buffer, name, type });
        async function send(url, files, { status = 302, fields = {}, csrf = token } = {}) {
            const form = new FormData();
            if (url === '/listings') for (const [key, value] of Object.entries({ title: 'Image security ' + stamp, description: 'Fixture', category_id: category, country_id: country, price: '12', ...fields })) form.append(key, String(value));
            else for (const [key, value] of Object.entries(fields)) form.append(key, String(value));

            for (const file of files) form.append('images', new Blob([file.buffer], { type: file.type }), file.name);
            const response = await fetch(base + url, { method: 'POST', headers: { cookie, ...(csrf === null ? {} : { 'X-CSRF-Token': csrf }) }, body: form, redirect: 'manual' });
            const text = await response.text();
            assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), url + ': HTTP ' + response.status + ' ' + text);
            return response;
        }
        const rowCount = async () => Number((await pool.execute('SELECT COUNT(*) AS total FROM listings WHERE user_id=?', [user]))[0][0].total);
        const dirs = async () => { try { return await fs.readdir(uploadRoot); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
        const initialDirs = await dirs();
        async function cleanTemps() {
            for (let i = 0; i < 100; i++) {
                if (JSON.stringify((await dirs()).sort()) === JSON.stringify(initialDirs.slice().sort())) return;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.fail('Temporary files leaked');
        }
        async function reject(label, files, options = {}) {
            const before = await rowCount();
            await send('/listings', files, { status: 400, ...options });
            assert.equal(await rowCount(), before); await cleanTemps();
            const [rows] = await pool.execute('SELECT image_path FROM listing_images WHERE listing_id IN (SELECT id FROM listings WHERE user_id=?)', [user]);
            const references = new Set(rows.map(row => path.basename(row.image_path)));
            for (const name of outputs) {
                const exists = await fs.access(path.join(privateRoot, name)).then(() => true, () => false);
                assert.equal(exists, references.has(name), 'Disk/DB mismatch: ' + name);
            }
            checks.push(label);
        }
        for (const [format, buffer] of Object.entries(generated)) {
            const response = await send('/listings', [photo(buffer, 'client.' + (format === 'jpeg' ? 'jpg' : format), 'image/' + format)]);
            const id = Number(response.headers.get('location').split('=')[1]);
            const [rows] = await pool.execute('SELECT image_path FROM listing_images WHERE listing_id=?', [id]);
            assert.match(rows[0].image_path, /^\/uploads\/listings\/[a-f0-9-]{36}\.webp$/);
            assert.equal((await fetch(base + rows[0].image_path)).status, 404);
            const served = await fetch(base + rows[0].image_path, { headers: { cookie } });
            assert.equal(served.status, 200); assert.match(served.headers.get('content-type'), /^image\/webp/);
            assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
            const metadata = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
            assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 80); assert.equal(metadata.exif, undefined);
            checks.push('valid ' + format);
        }
        const fake = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.from('<html><script>alert(1)</script></html>')]);
        await reject('fake JPEG signature + HTML', [photo(fake)]);
        await reject('HTML extension even with valid JPEG', [photo(generated.jpeg, 'photo.html')]);
        await reject('HTML disguised as image', [photo(Buffer.from('<html>test</html>'))]);
        await reject('SVG disguised as PNG', [photo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), 'photo.png', 'image/png')]);
        await reject('corrupt/truncated PNG', [photo(generated.png.subarray(0, 40), 'photo.png', 'image/png')]);
        await reject('executable disguised as JPEG', [photo(Buffer.from('MZ' + 'x'.repeat(100)))]);
        const large = await sharp({ create: { width: 6000, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
        await reject('pixel limit', [photo(large, 'large.png', 'image/png')]);
        const wide = await sharp({ create: { width: 9000, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
        await reject('dimension limit', [photo(wide, 'wide.png', 'image/png')]);
        const animated = await sharp(Buffer.concat([Buffer.alloc(300, 60), Buffer.alloc(300, 200)]), { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
        assert.equal((await sharp(animated).metadata()).pages, 2);
        await reject('animated WebP', [photo(animated, 'animated.webp', 'image/webp')]);
        await reject('11 files', Array.from({ length: 11 }, () => photo()));
        await reject('5 MiB size limit', [photo(Buffer.alloc(5 * 1024 * 1024 + 1))], { status: 413 });
        await reject('multipart field count', [photo()], { fields: Object.fromEntries(Array.from({ length: 13 }, (_, i) => ['extra' + i, 'x'])) });
        await reject('multipart field size', [photo()], { fields: { description: 'x'.repeat(65537) } });
        await reject('validation cleanup', [photo()], { fields: { title: '' } });
        await reject('missing CSRF cleanup', [photo()], { csrf: null, status: 403 });
        await reject('forged CSRF cleanup', [photo()], { csrf: '0'.repeat(64), status: 403 });
        await reject('later file invalid cleans earlier output', [photo(), photo(fake)]);
        const tagged = await sharp(generated.jpeg).withExif({ IFD0: { Artist: 'private audit metadata' } }).jpeg().toBuffer();
        const taggedResponse = await send('/listings', [photo(Buffer.concat([tagged, Buffer.from('<script>trailing-audit-payload</script>')]))]);
        const taggedId = Number(taggedResponse.headers.get('location').split('=')[1]);
        const taggedPath = (await pool.execute('SELECT image_path FROM listing_images WHERE listing_id=?', [taggedId]))[0][0].image_path;
        const taggedOutput = Buffer.from(await (await fetch(base + taggedPath, { headers: { cookie } })).arrayBuffer());
        assert.equal((await sharp(taggedOutput).metadata()).exif, undefined);
        assert.ok(!taggedOutput.includes(Buffer.from('trailing-audit-payload'))); checks.push('metadata and appended executable content removed');
        fault = 'sql'; await reject('SQL insert failure rolls back listing + files', [photo()], { status: 500 });
        const originalPublish = images.publish;
        try {
            images.publish = async req => {
                const name = req.imageUpload.outputs[0];
                await fs.rename(path.join(req.imageUpload.directory, name), path.join(privateRoot, name));
                throw Object.assign(new Error('Injected filesystem error'), { code: 'EIO' });
            };
            await reject('partial filesystem publish failure cleans both locations', [photo(), photo()], { status: 500 });
        } finally { images.publish = originalPublish; }
        fault = 'commit-before'; await reject('COMMIT failure removes published file', [photo()], { status: 500 });
        fault = 'commit-after';
        const before = await rowCount();
        await send('/listings', [photo()], { status: 500 });
        assert.equal(await rowCount(), before + 1);
        const [committed] = await pool.execute('SELECT image_path FROM listing_images WHERE listing_id=(SELECT MAX(id) FROM listings WHERE user_id=?)', [user]);
        assert.equal((await fetch(base + committed[0].image_path, { headers: { cookie } })).status, 200); await cleanTemps();
        checks.push('lost COMMIT acknowledgement preserves committed file');
        const abandoned = { imageUpload: await images.createJob(), files: [] };
        jobs.add(abandoned.imageUpload);
        const abandonedInput = path.join(abandoned.imageUpload.directory, 'fixture.upload');
        await fs.writeFile(abandonedInput, generated.png);
        abandoned.files.push({ path: abandonedInput });
        await images.prepare(abandoned); await images.publish(abandoned);
        abandoned.imageUpload.outputs.forEach(name => outputs.add(name));
        const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
        await fs.utimes(abandoned.imageUpload.directory, oldTime, oldTime);
        const referencedJob = await images.createJob(); jobs.add(referencedJob);
        const referencedName = path.basename(committed[0].image_path);
        await fs.writeFile(path.join(referencedJob.directory, 'manifest.json'), JSON.stringify([referencedName]));
        await fs.utimes(referencedJob.directory, oldTime, oldTime);
        await images.reconcile();
        for (const name of abandoned.imageUpload.outputs) await assert.rejects(fs.access(path.join(privateRoot, name)));
        assert.equal((await fetch(base + committed[0].image_path, { headers: { cookie } })).status, 200);
        await cleanTemps(); checks.push('crash recovery removes orphan and preserves committed image');

        const listing = (await pool.execute('SELECT MIN(id) AS id FROM listings WHERE user_id=?', [user]))[0][0].id;
        const publish = await fetch(base + '/listings/' + listing + '/publish', { method: 'POST', headers: { cookie, 'X-CSRF-Token': token }, redirect: 'manual' });
        assert.equal(publish.status, 302);
        const [[pending]] = await pool.execute('SELECT review_version FROM listings WHERE id=?', [listing]);
        const adminCookie = (await fetch(base + '/test-moderator')).headers.get('set-cookie').split(';')[0];
        const queue = await fetch(base + '/admin/moderation', { headers: { cookie:adminCookie } });
        assert.equal(queue.status, 200);
        const adminToken = (await queue.text()).match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        const approve = version => fetch(base + '/admin/moderation/' + listing, {
            method:'POST', redirect:'manual', headers:{ cookie:adminCookie, 'X-CSRF-Token':adminToken },
            body:new URLSearchParams({ mode:'approve', version, request_key:crypto.randomUUID() })
        });
        const initialImage = (await pool.execute('SELECT image_path FROM listing_images WHERE listing_id=?', [listing]))[0][0].image_path;
        assert.equal((await fetch(base + initialImage)).status,404);
        assert.equal((await fetch(base + initialImage,{ headers:{ cookie:adminCookie } })).status,200);
        assert.equal((await approve(pending.review_version)).status,303);
        const publishedImage = await fetch(base + initialImage);
        assert.equal(publishedImage.status,200);
        assert.match(publishedImage.headers.get('cache-control'),/no-store/);
        const details = await fetch(base + '/listings/' + listing, { headers: { cookie } }); assert.equal(details.status, 200);
        const saved = await fetch(base + '/api/favorites/' + listing, { method: 'PUT', headers: { cookie, 'X-CSRF-Token': token } }); assert.equal(saved.status, 200);
        for (const url of ['/search?search=' + encodeURIComponent(stamp), '/favorites']) {
            const response = await fetch(base + url, { headers: { cookie } }); assert.equal(response.status, 200); assert.match(await response.text(), /Image security/);
        }
        checks.push('listing publish/show, search, favorites');
        const full = await send('/listings', Array.from({ length: 10 }, () => photo()));
        const fullId = Number(full.headers.get('location').split('=')[1]);
        assert.equal(Number((await pool.execute('SELECT COUNT(*) AS total FROM listing_images WHERE listing_id=?', [fullId]))[0][0].total), 10);
        await cleanTemps(); checks.push('create listing with 10 images');
        const addBefore = Number((await pool.execute('SELECT COUNT(*) AS total FROM listing_images WHERE listing_id=?', [listing]))[0][0].total);
        fault = 'sql'; await send('/listings/' + listing + '/images', [photo()], { status: 500 });
        assert.equal(Number((await pool.execute('SELECT COUNT(*) AS total FROM listing_images WHERE listing_id=?', [listing]))[0][0].total), addBefore);
        await cleanTemps(); checks.push('SQL error adding images preserves existing images');
        await send('/listings/4294967295/images', [photo()], { status: 404 }); await cleanTemps(); checks.push('unavailable listing upload cleanup');
        // Existing count is one; concurrent requests cannot both take nine places.
        const results = await Promise.all([send('/listings/' + listing + '/images', Array.from({ length: 9 }, () => photo()), { status: [302, 400] }), send('/listings/' + listing + '/images', Array.from({ length: 9 }, () => photo()), { status: [302, 400] })]);
        // Scheduling may reverse which request succeeds; verify outcomes and DB directly.
        assert.equal(Number((await pool.execute('SELECT COUNT(*) AS total FROM listing_images WHERE listing_id=?', [listing]))[0][0].total), 10);
        assert.deepEqual(results.map(result => result.status).sort(), [302, 400]);
        await cleanTemps(); checks.push('concurrent uploads capped at 10');
        const [[photoReview]] = await pool.execute('SELECT status,review_version FROM listings WHERE id=?', [listing]);
        assert.equal(photoReview.status,'pending_review');
        assert.ok(photoReview.review_version > pending.review_version);
        assert.equal((await fetch(base + initialImage)).status,404);
        assert.equal((await approve(pending.review_version)).status,409);
        const missing = (await pool.execute('INSERT INTO listing_images(listing_id,image_path,sort_order) VALUES (?,?,1000)',
            [listing, '/uploads/listings/' + crypto.randomUUID() + '.webp']))[0].insertId;
        assert.equal((await approve(photoReview.review_version)).status,409);
        await pool.execute('DELETE FROM listing_images WHERE id=?', [missing]);
        checks.push('photo changes invalidate review and approval rejects missing files');
        const image = (await pool.execute('SELECT id,image_path FROM listing_images WHERE listing_id=? LIMIT 1', [listing]))[0][0];
        const forbiddenDeletion = await fetch(base + '/listings/' + listing + '/images/' + image.id + '/delete', { method: 'POST', headers: { cookie }, redirect: 'manual' });
        assert.equal(forbiddenDeletion.status, 403);
        assert.equal((await fetch(base + image.image_path, { headers: { cookie } })).status, 200); checks.push('delete requires CSRF');
        const deletion = await fetch(base + '/listings/' + listing + '/images/' + image.id + '/delete', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token }), redirect: 'manual' });
        assert.equal(deletion.status, 302); assert.equal((await fetch(base + image.image_path)).status, 404); checks.push('delete stored image');
        const legacyDir = path.resolve(__dirname, '../public/uploads/listings');
        const old = (await fs.readdir(legacyDir)).find(name => /\.(png|jpg|jpeg|webp)$/i.test(name));
        if (old) {
            const original = await fs.readFile(path.join(legacyDir, old));
            const [legacy] = await pool.execute("INSERT INTO listing_images (listing_id,image_path,sort_order) VALUES (?, ?, 100)", [listing,'/uploads/listings/' + old]);
            const response = await fetch(base + '/uploads/listings/' + old, { headers: { cookie } }); assert.equal(response.status, 200);
            await pool.execute('DELETE FROM listing_images WHERE id=?', [legacy.insertId]);
            assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, 'webp');
            assert.deepEqual(await fs.readFile(path.join(legacyDir, old)), original); checks.push('legacy image safe serving without file changes');
        }
        for (const suffix of ['probe.html', 'probe.svg', '../index.js', '%2e%2e%2findex.js']) {
            const response = await fetch(base + '/uploads/listings/' + suffix); assert.equal(response.status, 404);
        }
        checks.push('unsafe extensions and traversal blocked');
        for (const url of ['/uploads%2flistings/probe.html', '/uploads%5clistings%5cprobe.html', '/css/..%2fuploads/listings/probe.html', '/.storage/listing-images/probe.webp']) {
            assert.equal((await fetch(base + url)).status, 404);
        }
        assert.equal((await fetch(base + '/css/main.css')).status, 200);
        checks.push('static assets work; encoded upload bypass blocked');
        // An interrupted multipart stream must close writers and remove its private directory.
        await new Promise(resolve => {
            const request = http.request(base + '/listings', { method: 'POST', headers: { cookie, 'X-CSRF-Token': token, 'Content-Type': 'multipart/form-data; boundary=audit', 'Content-Length': 100000 } });
            request.on('error', () => resolve());
            request.write('--audit\r\nContent-Disposition: form-data; name="images"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
            request.write(generated.jpeg); setTimeout(() => { request.destroy(); resolve(); }, 100);
        });
        await cleanTemps(); checks.push('aborted multipart cleanup');
        console.log('Image security checks passed:', checks.length);
        for (const check of checks) console.log('OK:', check);
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (user) {
            await pool.execute('DELETE FROM notifications WHERE user_id=?', [user]);
            await pool.execute('DELETE FROM listings WHERE user_id=?', [user]);
            await pool.execute('DELETE FROM users WHERE id=?', [user]);
        }
        if (category) await pool.execute('DELETE FROM categories WHERE id=?', [category]);
        if (admin) {
            await pool.execute('DELETE FROM admin_logs WHERE admin_id=?', [admin]);
            await pool.execute('DELETE FROM users WHERE id=?', [admin]);
        }
        if (createdCountry) await pool.execute('DELETE FROM countries WHERE id=?', [country]);
        const images = require('../services/listingImages');
        for (const job of jobs) await images.dispose({ imageUpload: job }, false);
        for (const name of outputs) await fs.unlink(path.join(privateRoot, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        assert.equal(path.dirname(storageRoot), storageParent);
        assert.ok(path.basename(storageRoot).startsWith('image-tests-'));
        await fs.rm(storageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        if (previousStorage === undefined) delete process.env.LISTING_IMAGE_STORAGE_ROOT;
        else process.env.LISTING_IMAGE_STORAGE_ROOT = previousStorage;
        await pool.end();
    }
}
run().catch(error => { console.error('Image checks failed:', error.code || error.name, error.message); process.exitCode = 1; });
