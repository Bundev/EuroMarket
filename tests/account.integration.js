const verifyTestEnvironment = require('./test-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const mysql = require('mysql2/promise');
const express = require('express');
const session = require('express-session');

async function run() {
    const db = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: 'euromarket_test', connectionLimit: 6 });
    const users = [];
    let server, category, country, createdCountry, createdFeedCountry, subscriberFixture, savedChild, savedCity, attributeRoot, attributeOther;
    let serviceRoot, serviceBranch;
    try {
        assert.equal((await db.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        const applyMigrations = require('./apply-migrations');
        const migrations = ['011_deal_notifications.sql', '012_deal_events.sql', '013_deal_disputes.sql', '014_seller_follows.sql', '015_saved_searches.sql', '016_recently_viewed.sql', '017_listing_price_history.sql', '018_price_negotiations.sql', '019_fix_price_history_currency_collation.sql', '020_seller_trust.sql', '021_listing_attributes.sql', '022_saved_search_attributes.sql', '023_listing_lifecycle.sql'];
        await applyMigrations(db, migrations);
        await applyMigrations(db, migrations);
        let rejectedEvent;
        const getConnection = db.getConnection.bind(db);
        db.getConnection = async () => {
            const connection = await getConnection();
            if (rejectedEvent) {
                const execute = connection.execute.bind(connection);
                connection.execute = async (sql, params) => {
                    const key = params?.[1];
                    if (rejectedEvent && sql.includes('INSERT INTO notifications') && typeof key === 'string' &&
                        (key.endsWith(rejectedEvent) || (rejectedEvent === 'dispute' && key.startsWith('dispute:')))) {
                        rejectedEvent = undefined;
                        throw new Error('Simulated notification write failure');
                    }
                    if ((rejectedEvent === 'publication-audit' && sql.includes('INSERT INTO admin_logs') &&
                         params?.[3]?.startsWith('listing_review_approve')) ||
                        (rejectedEvent === 'publication-checkpoint' && sql.includes('UPDATE seller_publication_jobs'))) {
                        rejectedEvent = undefined;
                        throw new Error('Simulated publication write failure');
                    }
                    return execute(sql, params);
                };
            }
            return connection;
        };
        require.cache[require.resolve('../config/db')] = { loaded: true, exports: db };
        const key = crypto.randomUUID();
        country = (await db.query("SELECT id FROM countries WHERE code='DE'"))[0][0]?.id;
        if (!country) {
            country = (await db.query("INSERT INTO countries(code,name,currency,language) VALUES ('DE','Germany','EUR','de')"))[0].insertId;
            createdCountry = true;
        }
        category = (await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Account test')", [key]))[0].insertId;
        for (const role of ['user','user','user','admin','user']) {
            const index = users.length;
            const [row] = await db.execute("INSERT INTO users(name,email,password_hash,role) VALUES (?,?, 'test-only',?)",
                ['Account ' + index, key + '-' + index + '@example.invalid', role]);
            users.push({ id: row.insertId });
        }
        const [seller,buyer,other,admin,serviceBuyer] = users;
        async function listing(title, status) {
            return (await db.execute("INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status) VALUES (?,?,?,?,'Test',25,'EUR',?)",
                [seller.id, category, country, title, status]))[0].insertId;
        }
        const item = await listing('Unique account purchase', 'active');
        const photoPath = '/uploads/listings/test-preview-' + key + '.webp';
        await db.execute('INSERT INTO listing_images(listing_id,image_path,sort_order) VALUES (?,?,0)', [item, photoPath]);
        const spare = await listing('Cancellation', 'active');
        await listing('Historical sold', 'sold');
        await listing('Archived test', 'archived');
        for (let i = 0; i < 21; i++) await listing('Page sample ' + String(i).padStart(2,'0'), 'draft');
        const app = express();
        const seoOrigin = 'https://seo.example.invalid';
        app.set('view engine', 'ejs');
        app.set('views', path.resolve(__dirname, '../views'));
        app.use(express.urlencoded({ extended: false }));
        app.use(express.json());
        app.use(require('../middleware/httpSecurity')({ production: false, csp: 'enforce' }));
        app.use(require('../services/seo').init(seoOrigin));
        app.use(require('../routes/seo.routes'));
        app.use(require('../middleware/toasts'));
        app.use(session({ secret: crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false }));
        app.get('/test-session/:id', (req,res) => {
            assert.ok(users.some(user => user.id === Number(req.params.id)));
            req.session.user = { id: Number(req.params.id) };
            res.sendStatus(204);
        });
        app.use(require('../middleware/pageContext'));
        for (const route of ['home','search','savedSearch','auth','profile','follow','listing','recentlyViewed','marketplaceTools','negotiation','deal','dispute','review','message','favorite','notification','admin']) {
            app.use(require('../routes/' + route + '.routes'));
        }
        server = await new Promise(resolve => { const local = app.listen(0,'127.0.0.1',() => resolve(local)); });
        const base = 'http://127.0.0.1:' + server.address().port;
        for (const user of users) {
            const signed = await fetch(base + '/test-session/' + user.id);
            user.cookie = signed.headers.get('set-cookie').split(';')[0];
            const page = await fetch(base + '/profile', { headers: { cookie: user.cookie } });
            user.token = (await page.text()).match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        }
        async function request(user, url, status, fields, token = user.token) {
            const response = await fetch(base + url, { redirect: 'manual', method: fields ? 'POST' : 'GET',
                headers: { cookie: user.cookie || '', 'X-CSRF-Token': token || '' }, body: fields ? new URLSearchParams(fields) : undefined });
            if (status !== undefined) assert.equal(response.status, status, url);
            return { status: response.status, headers: response.headers, html: await response.text() };
        }
        const historyPath = '/recently-viewed';
        const recordView = (user, id, status = 204, token) => request(user, '/api/recently-viewed/' + id, status, {}, token);
        const historyIds = async user => (await db.execute('SELECT listing_id FROM recently_viewed WHERE user_id=? ORDER BY id DESC',
            [user.id]))[0].map(row => row.listing_id);
        for (const url of ['/profile','/my-listings','/my-purchases']) await request({},url,302);
        await request(seller,'/profile',403,{ name:'Wrong' },'');
        await request(seller,'/profile',303,{ name:'New profile name', user_id:buyer.id });
        const profile = (await request(seller,'/profile',200)).html;
        const publicProfile = '/users/' + seller.id;
        assert.match(profile,/New profile name/);
        assert.ok(profile.includes('href="' + publicProfile + '">Открыть мой публичный профиль</a>'));
        assert.doesNotMatch(profile,/Unique account purchase/);
        const unratedProfile = (await request({}, '/users/' + buyer.id, 200)).html;
        assert.match(unratedProfile, /Нет оценок \(0\)/);
        assert.match(unratedProfile, /У продавца пока нет активных объявлений/);
        assert.equal((unratedProfile.match(/--seller-star-fill: 0%/g) || []).length, 5);
        for (const id of ['invalid', '4294967296', '4294967295']) await request({}, '/users/' + id, 404);
        const first = (await request(seller,'/my-listings?status=draft&q=Page+sample&sort=oldest',200)).html;
        const second = (await request(seller,'/my-listings?status=draft&q=Page+sample&sort=oldest&page=2',200)).html;
        assert.equal((first.match(/>\s+Page sample \d+\s+<\/a>/g)||[]).length,20);
        assert.match(second,/Page sample 20/);
        assert.doesNotMatch(second,/Page sample 19/);
        assert.match((await request(seller,'/my-listings?status=archived',200)).html,/Archived test/);
        const cardMetrics = html => Array.from(html.matchAll(/<dd class="seller-metric-value">(\d+)<\/dd>/g),
            match => Number(match[1]));
        assert.deepEqual(cardMetrics((await request(seller, '/my-listings?status=archived&q=Archived+test', 200)).html), [0, 0, 0]);
        assert.doesNotMatch((await request(buyer,'/my-listings',200)).html,/Unique account purchase/);
        assert.doesNotMatch((await request(seller,'/my-purchases',200)).html,/Historical sold/);

        const start = (user, id, status, token, key = crypto.randomUUID()) => request(user, '/listings/' + id + '/purchase', status,
            { buyer_id: other.id, seller_id: other.id, purchase_request_key: key }, token);
        const move = (user, id, action, status, token) => request(user, '/deals/' + id, status, { action }, token);
        const dealDetail = async (user, id) => (await request(user, '/deals/' + id, 200)).html;
        const events = html => [...html.matchAll(/data-deal-event="([^"]+)"/g)].map(match => match[1]);
        const rows = async id => (await db.execute('SELECT * FROM deals WHERE listing_id=? ORDER BY id',[id]))[0];
        const notices = async (dealId, event) => (await db.execute(
            "SELECT id,user_id,text,link FROM notifications WHERE type='deal' AND event_key=? ORDER BY user_id",
            [`deal:${dealId}:${event}`]))[0];
        const poll = async user => JSON.parse((await request(user, '/api/messages/unread', 200)).html);
        const requestKey = (await request(buyer, '/listing/' + item + '/unique-account-purchase', 200)).html
            .match(/name="purchase_request_key" value="([a-f0-9-]+)"/)[1];
        await start(buyer,item,403,'bad');
        await request(admin, '/listings/' + item + '/purchase', 400, {});
        await start(admin, item, 400, undefined, 'invalid');
        await start(seller,item,404);
        const before = await poll(seller);
        rejectedEvent = ':requested';
        await start(buyer, item, 500, undefined, requestKey);
        assert.equal(rejectedEvent, undefined);
        assert.deepEqual(await rows(item), []);
        assert.deepEqual(await poll(seller), before);
        const duplicate = await Promise.all([start(buyer,item,undefined,undefined,requestKey),start(buyer,item,undefined,undefined,requestKey)]);
        assert.deepEqual(duplicate.map(v=>v.status).sort(),[303,409]);
        const [a] = await rows(item);
        assert.equal(a.buyer_id,buyer.id);
        assert.equal(a.seller_id,seller.id);
        const [requested] = await notices(a.id, 'requested');
        assert.equal((await notices(a.id, 'requested')).length, 1);
        assert.equal(requested.user_id, seller.id);
        assert.match(requested.text, /Новый запрос на покупку «Unique account purchase» · 25\.00 EUR/);
        assert.equal(requested.link, '/deals/' + a.id);
        assert.equal(duplicate.find(response => response.status === 303).headers.get('location'), requested.link);
        assert.equal((await poll(seller)).notifications, before.notifications + 1);
        assert.equal((await poll(seller)).unread, before.unread);
        const buyerResponse = await request(buyer, requested.link + '?action=cancel', 200);
        const buyerView = buyerResponse.html;
        assert.match(buyerView, /Запрос на покупку отправлен продавцу/);
        assert.match(buyerResponse.headers.get('cache-control'), /no-store/);
        assert.match(buyerResponse.headers.get('x-robots-tag'), /noindex/);
        assert.match(buyerView, /Отменить сделку/);
        assert.doesNotMatch(buyerView, /Принять запрос|Открыть переписку/);
        assert.match(buyerView, /Unique account purchase/);
        assert.match(buyerView, /25\.00 EUR/);
        assert.match(buyerView, /New profile name/);
        assert.match(buyerView, /Account 1/);
        assert.ok(buyerView.includes(photoPath));
        assert.deepEqual(events(buyerView), ['requested']);
        assert.doesNotMatch((await request(buyer, requested.link, 200)).html, /Запрос на покупку отправлен продавцу/);
        const chat = await request(buyer, '/messages/start', 303, { listing_id: item });
        const chatPath = chat.headers.get('location');
        assert.match(chatPath, /^\/messages\/[0-9]+$/);
        const sellerView = (await request(seller, requested.link + '?side=buyer', 200)).html;
        assert.ok(sellerView.includes('href="' + chatPath + '"'));
        assert.ok((await dealDetail(buyer, a.id)).includes('href="' + chatPath + '"'));
        await request(seller, chatPath, 200);
        assert.match(sellerView, /Принять запрос/);
        assert.match(sellerView, /К продажам/);
        const adminView = await dealDetail(admin, a.id);
        assert.match(adminView, /Панель администратора/);
        assert.doesNotMatch(adminView, /Принять запрос|Отменить сделку|Открыть переписку/);
        await move(admin, a.id, 'accept', 404);
        assert.equal((await request(buyer, '/my-purchases/' + a.id, 302)).headers.get('location'), requested.link);
        assert.ok((await request(seller, '/my-purchases?side=seller', 200)).html.includes('href="' + requested.link + '"'));
        assert.equal((await request(seller, '/notifications/' + requested.id + '/open', 302)).headers.get('location'), requested.link);
        await db.execute('UPDATE notifications SET link=? WHERE id=?', ['/my-purchases/' + a.id, requested.id]);
        assert.equal((await request(seller, '/notifications/' + requested.id + '/open', 302)).headers.get('location'), requested.link);
        await request(other, '/notifications/' + requested.id + '/open', 404);
        await request(other, requested.link, 404);
        await request({}, requested.link, 302);
        await start(other,item,303);
        const [, competing] = await rows(item);
        assert.match((await request(seller, '/my-purchases?side=seller', 200)).html, /data-pending-sales>\s*2</);
        rejectedEvent = ':accepted';
        await move(seller, a.id, 'accept', 500);
        assert.equal(rejectedEvent, undefined);
        assert.deepEqual((await rows(item)).map(row => row.status), ['requested', 'requested']);
        assert.deepEqual(events(await dealDetail(buyer, a.id)), ['requested']);
        assert.deepEqual(await notices(a.id, 'accepted'), []);
        assert.deepEqual(await notices(competing.id, 'declined'), []);
        const acceptance = await Promise.all([move(seller,a.id,'accept'),move(seller,competing.id,'accept')]);
        assert.deepEqual(acceptance.map(v=>v.status).sort(),[303,409]);
        const accepted = (await rows(item)).find(row=>row.status==='accepted');
        const winner = users.find(user=>user.id===accepted.buyer_id);
        const stranger = winner === buyer ? other : buyer;
        const declined = (await rows(item)).find(row => row.status === 'declined');
        assert.deepEqual(events(await dealDetail(winner, accepted.id)), ['requested', 'accepted']);
        assert.deepEqual(events(await dealDetail(stranger, declined.id)), ['requested', 'declined']);
        assert.deepEqual((await notices(accepted.id, 'accepted')).map(row => row.user_id), [winner.id]);
        assert.deepEqual((await notices(declined.id, 'declined')).map(row => row.user_id), [stranger.id]);
        assert.doesNotMatch((await request(seller, '/my-purchases?side=seller', 200)).html, /data-pending-sales/);
        const saveReview = (user, dealId, status, fields = {}, token) => request(user, '/my-purchases/' + dealId + '/review',
            status, { mode: 'create', rating: '5', ...fields }, token);
        const evidence = await require('sharp')({ create: {
            width: 80, height: 60, channels: 3, background: '#668899'
        }}).png().toBuffer();
        const disputePath = '/deals/' + accepted.id + '/disputes';
        async function sendDispute(user, status, { key = crypto.randomUUID(), files = [], token = user.token } = {}) {
            const form = new FormData();
            form.set('request_key', key);
            form.set('reason', 'not_delivered');
            form.set('body', 'Подробности <b>только для участников</b>');
            for (const file of files) form.append('photos', new Blob([file], { type: 'image/png' }), 'evidence.png');
            const response = await fetch(base + disputePath, { method: 'POST', headers: {
                cookie: user.cookie, accept: 'application/json', 'X-CSRF-Token': token
            }, body: form });
            assert.equal(response.status, status, disputePath);
            return response.json();
        }
        const openingKey = crypto.randomUUID();
        await sendDispute(winner, 403, { files: [evidence], token: '' });
        await sendDispute(stranger, 404, { files: [evidence] });
        await sendDispute(winner, 400, { files: [Buffer.from('invalid image bytes')] });
        await sendDispute(winner, 400, { files: Array(6).fill(evidence) });
        await sendDispute(winner, 413, { files: [Buffer.alloc(2 * 1024 * 1024 + 1)] });
        rejectedEvent = 'dispute';
        await sendDispute(winner, 500, { key: openingKey, files: [evidence] });
        assert.equal(rejectedEvent, undefined);
        const [[rolledBackDispute]] = await db.execute('SELECT COUNT(*) AS total FROM deal_disputes WHERE deal_id=?', [accepted.id]);
        assert.equal(Number(rolledBackDispute.total), 0);
        const duplicateDispute = await Promise.all([
            sendDispute(winner, 201, { key: openingKey, files: [evidence] }),
            sendDispute(winner, 201, { key: openingKey, files: [evidence] })
        ]);
        const activeDispute = duplicateDispute[0].redirect;
        assert.equal(duplicateDispute[1].redirect, activeDispute);
        const activeDisputeId = Number(activeDispute.split('/').at(-1));
        await sendDispute(seller, 409);
        await request(stranger, activeDispute, 404);
        await request({}, activeDispute, 302);
        await request(stranger, activeDispute + '/images/1', 404);
        await request({}, activeDispute + '/images/1', 302);
        for (const viewer of [winner, seller, admin]) {
            const response = await fetch(base + activeDispute + '/images/1', { headers: { cookie: viewer.cookie } });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'image/webp');
            assert.match(response.headers.get('cache-control'), /no-store/);
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
            const image = await require('sharp')(Buffer.from(await response.arrayBuffer())).metadata();
            assert.equal(image.format, 'webp');
        }
        const privateDisputePage = (await request(seller, activeDispute, 200)).html;
        assert.match(privateDisputePage, /&lt;b&gt;только для участников/);
        assert.doesNotMatch(privateDisputePage, /Действие администратора/);
        const frozen = await dealDetail(winner, accepted.id);
        assert.doesNotMatch(frozen, /name="action" value="(?:confirm|cancel)"/);
        assert.ok(frozen.includes(activeDispute));
        await move(winner, accepted.id, 'confirm', 409);
        await move(seller, accepted.id, 'cancel', 409);
        await request(seller, '/admin/disputes', 403);
        const queue = (await request(admin, '/admin/disputes?status=open&reason=not_delivered&deal=' + accepted.id, 200)).html;
        assert.ok(queue.includes('href="' + activeDispute + '"'));
        assert.match(queue, /data-admin-count="disputes"[^>]*>[1-9]\d*</);
        const disputeNotices = async id => (await db.execute(
            "SELECT id,user_id FROM notifications WHERE link=? AND event_key LIKE 'dispute:%' ORDER BY id", ['/disputes/' + id]))[0];
        const openingNotices = await disputeNotices(activeDisputeId);
        assert.deepEqual(openingNotices.map(row => row.user_id).sort(), [winner.id, seller.id].sort());
        const otherNotice = openingNotices.find(row => row.user_id === seller.id);
        assert.equal((await request(seller, '/notifications/' + otherNotice.id + '/open', 302)).headers.get('location'), activeDispute);
        await request(stranger, '/notifications/' + otherNotice.id + '/open', 404);
        const disputeDecisionPath = '/admin/disputes/' + activeDisputeId;
        const info = { request_key: crypto.randomUUID(), action: 'request_info', version: 1, body: 'Уточните дату встречи.' };
        await request(seller, disputeDecisionPath, 403, info);
        await request(admin, disputeDecisionPath, 403, info, '');
        await request(admin, disputeDecisionPath, 303, info);
        await request(admin, disputeDecisionPath, 303, info);
        const reply = { request_key: crypto.randomUUID(), body: 'Встреча была в понедельник.' };
        await request(stranger, activeDispute + '/reply', 404, reply);
        await request(winner, activeDispute + '/reply', 403, reply, '');
        await request(winner, activeDispute + '/reply', 303, reply);
        await request(winner, activeDispute + '/reply', 303, reply);
        const decision = { request_key: crypto.randomUUID(), action: 'resolve', version: 3, body: 'Обращение рассмотрено.' };
        await request(admin, disputeDecisionPath, 409, { ...decision, version: 2 });
        rejectedEvent = 'dispute';
        await request(admin, disputeDecisionPath, 500, decision);
        assert.equal(rejectedEvent, undefined);
        assert.equal((await disputeNotices(activeDisputeId)).length, 4);
        await request(admin, disputeDecisionPath, 303, decision);
        const closedDispute = (await request(winner, activeDispute, 200)).html;
        assert.match(closedDispute, /Закрыт с решением/);
        assert.equal((closedDispute.match(/Встреча была в понедельник\./g) || []).length, 1);
        assert.match(closedDispute, /Обращение рассмотрено/);
        await request(winner, activeDispute + '/reply', 409, { ...reply, request_key: crypto.randomUUID() });
        assert.equal((await disputeNotices(activeDisputeId)).length, 6);
        const [disputeAudit] = await db.execute(
            "SELECT action FROM admin_logs WHERE target_id=? AND action IN ('dispute_request_info','dispute_resolve') ORDER BY id", [activeDisputeId]);
        assert.deepEqual(disputeAudit.map(row => row.action), ['dispute_request_info', 'dispute_resolve']);
        assert.equal((await sendDispute(winner, 201, { key: openingKey })).redirect, activeDispute);
        const secondDispute = (await sendDispute(seller, 201)).redirect;
        assert.notEqual(secondDispute, activeDispute);
        const secondId = Number(secondDispute.split('/').at(-1));
        await request(admin, '/admin/disputes/' + secondId, 303,
            { request_key: crypto.randomUUID(), action: 'reject', version: 1, body: 'Причина отклонения.' });
        assert.match((await request(winner, secondDispute, 200)).html, /Спор отклонён/);
        assert.equal((await disputeNotices(secondId)).length, 4);
        assert.match(await dealDetail(winner, accepted.id), /name="action" value="confirm"/);

        await saveReview(winner, accepted.id, 409);
        await move(stranger,accepted.id,'confirm',404);
        await move(winner,accepted.id,'confirm',403,'');
        await request(seller,'/listings/' + item + '/sold',409,{});
        await request(admin,'/admin/listings/' + item,303,{ mode:'block', reason:'Test', request_key:crypto.randomUUID() });
        const blocked = await dealDetail(winner, accepted.id);
        assert.doesNotMatch(blocked, /Подтвердить получение|Unique account purchase/);
        assert.ok(!blocked.includes(photoPath));
        await move(winner,accepted.id,'confirm',409);
        await request(admin,'/admin/listings/' + item,303,{ mode:'unblock', reason:'Test', request_key:crypto.randomUUID() });
        await db.execute('UPDATE listings SET price=40 WHERE id=?',[item]);
        await move(winner,accepted.id,'confirm',303);
        assert.deepEqual((await notices(accepted.id, 'buyer_confirmed')).map(row => row.user_id), [seller.id]);
        assert.match((await request(winner,'/my-purchases',200)).html,/data-deal-status="accepted"/);
        assert.doesNotMatch((await request(winner,'/my-purchases',200)).html,/data-deal-status="completed"/);
        await move(seller,accepted.id,'cancel',409);
        const [[beforeCompletion]] = await db.execute('SELECT status FROM listings WHERE id=?', [item]);
        rejectedEvent = ':completed';
        await move(seller, accepted.id, 'confirm', 500);
        assert.equal(rejectedEvent, undefined);
        const rolledBack = (await rows(item)).find(row => row.id === accepted.id);
        assert.equal(rolledBack.status, 'accepted');
        assert.equal(rolledBack.seller_confirmed_at, null);
        assert.deepEqual(await notices(accepted.id, 'seller_confirmed'), []);
        assert.deepEqual(await notices(accepted.id, 'completed'), []);
        assert.equal((await db.execute('SELECT status FROM listings WHERE id=?', [item]))[0][0].status, beforeCompletion.status);
        const confirmations = await Promise.all([move(seller,accepted.id,'confirm'),move(seller,accepted.id,'confirm')]);
        assert.deepEqual(confirmations.map(v=>v.status).sort(),[303,409]);
        const completed = (await rows(item)).find(row=>row.id===accepted.id);
        assert.equal(completed.status,'completed');
        assert.equal(completed.price,'25.00');
        assert.equal(completed.currency,'EUR');
        assert.ok(completed.buyer_confirmed_at && completed.seller_confirmed_at && completed.completed_at);
        assert.deepEqual(events(await dealDetail(seller, accepted.id)),
            ['requested', 'accepted', 'buyer_confirmed', 'seller_confirmed', 'completed']);
        const completedView = await dealDetail(winner, accepted.id);
        assert.match(completedView, /25\.00 EUR/);
        assert.ok(completedView.includes(photoPath));
        assert.deepEqual((await notices(accepted.id, 'seller_confirmed')).map(row => row.user_id), [winner.id]);
        assert.deepEqual((await notices(accepted.id, 'completed')).map(row => row.user_id), [seller.id, winner.id]);
        assert.equal((await db.execute('SELECT status FROM listings WHERE id=?',[item]))[0][0].status,'sold');
        assert.match((await request(seller,'/my-purchases?side=seller',200)).html,/data-deal-status="completed"/);
        assert.doesNotMatch((await request(stranger,'/my-purchases',200)).html,/data-deal-status="completed"/);
        await request(winner,'/listings/' + item,200);
        await request(stranger,'/listings/' + item,404);
        const sellerReviews = '/users/' + seller.id + '/reviews';
        const unrated = (await request({},'/listing/' + spare + '/cancellation',200)).html;
        assert.match(unrated,/Нет оценок \(0\)/);
        assert.equal((unrated.match(/--seller-star-fill: 0%/g) || []).length, 5);
        assert.ok(unrated.includes('href="' + sellerReviews + '">Отзывы продавца</a>'));
        assert.match((await request(winner,'/my-purchases',200)).html,/Оставить отзыв/);
        assert.doesNotMatch((await request(seller,'/my-purchases?side=seller',200)).html,/Оставить отзыв/);
        await saveReview(seller, accepted.id, 404);
        await saveReview(stranger, accepted.id, 404);
        await saveReview(winner, accepted.id, 403, {}, '');
        await saveReview(winner, accepted.id, 403, {}, 'bad');
        await saveReview(winner, accepted.id, 400, { rating: '6' });
        await saveReview(winner, accepted.id, 400, { comment: 'a'.repeat(1501) });
        const marker = '<em>Тест экранирования</em>';
        const reviewAdminUrl = '/admin/reviews/' + accepted.id;
        const decideReview = (dealId, version, mode, status = 303, reason = '', token = admin.token, key = crypto.randomUUID()) =>
            request(admin, '/admin/reviews/' + dealId, status, { mode, version, reason, request_key: key }, token);
        const adminBadge = (html, name) => Number(html.match(new RegExp('data-admin-count="' + name + '"[^>]*>(\\d+)'))?.[1]);
        const adminBefore = (await request(admin, '/admin/reviews', 200)).html;
        const countsBefore = await require('../models/admin.model').counters();
        for (const name of ['dashboard','users','listings','moderation','reports','disputes','reviews','logs']) {
            assert.equal(adminBadge(adminBefore, name), countsBefore[name]);
        }
        if (!countsBefore.reviews) assert.match(adminBefore, /Нет отзывов, ожидающих проверки/);
        const attempts = await Promise.all([
            saveReview(winner, accepted.id, undefined, { comment: marker }),
            saveReview(winner, accepted.id, undefined, { comment: marker })
        ]);
        assert.deepEqual(attempts.map(result => result.status).sort(), [303,409]);
        assert.doesNotMatch((await request({}, sellerReviews, 200)).html, /Тест экранирования/);
        const pendingReviews = (await request(admin, '/admin/reviews', 200)).html;
        assert.equal(adminBadge(pendingReviews, 'reviews'), countsBefore.reviews + 1);
        assert.match(pendingReviews, /&lt;em&gt;Тест экранирования&lt;\/em&gt;/);
        const reviewContent = pendingReviews.slice(pendingReviews.indexOf('<h1'));
        assert.ok(!/Открытые жалобы|Жалобы на продавцов|\/admin\/reports\/reviews/.test(reviewContent), 'Review content contains a complaint control');
        await request(stranger, reviewAdminUrl, 403);
        await decideReview(accepted.id, 0, 'reject', 400);
        await decideReview(accepted.id, 0, 'approve', 403, '', '');
        const firstApprovalKey = crypto.randomUUID();
        const concurrentReviewDecisions = await Promise.all([
            request(admin, reviewAdminUrl, undefined, { mode:'approve', version:0, request_key:firstApprovalKey }),
            request(admin, reviewAdminUrl, undefined, { mode:'approve', version:0, request_key:crypto.randomUUID() })
        ]);
        assert.deepEqual(concurrentReviewDecisions.map(result => result.status).sort(), [303,409]);
        assert.equal(adminBadge((await request(admin, '/admin/reviews', 200)).html, 'reviews'), countsBefore.reviews);
        const [[notice]] = await db.execute("SELECT id,link FROM notifications WHERE user_id=? AND event_key=? AND type='review'",
            [seller.id, 'review:' + accepted.id]);
        assert.equal(notice.link, sellerReviews);
        await request(seller, '/notifications/' + notice.id + '/open', 302);
        await request(stranger, '/notifications/' + notice.id + '/open', 404);
        const publishedReview = (await request({},sellerReviews,200)).html;
        assert.match(publishedReview,/&lt;em&gt;/);
        assert.doesNotMatch(publishedReview,/<em>Тест экранирования<\/em>/);
        assert.match(publishedReview,/5 \/ 5 · отзывов: 1/);
        await saveReview(winner, accepted.id, 303, { mode:'edit', rating:'4', comment:marker });
        assert.doesNotMatch((await request({},sellerReviews,200)).html,/Тест экранирования/);
        await decideReview(accepted.id, 0, 'approve', 409);
        await decideReview(accepted.id, 2, 'approve');
        assert.match((await request({},sellerReviews,200)).html,/4 \/ 5 · отзывов: 1/);
        await db.execute('UPDATE reviews SET created_at=DATE_SUB(NOW(), INTERVAL 8 DAY) WHERE deal_id=?', [accepted.id]);
        await saveReview(winner, accepted.id, 409, { mode:'edit', rating:'1' });
        assert.equal((await db.execute("SELECT COUNT(*) AS total FROM notifications WHERE event_key=? AND user_id=?",
            ['review:' + accepted.id,seller.id]))[0][0].total,1);

        // Additional completed fixture validates averaging and the seller card on a public listing.
        const secondListing = await listing('Second reviewed sale', 'sold');
        const [secondDeal] = await db.execute(`INSERT INTO deals(listing_id,buyer_id,seller_id,price,currency,status,
            buyer_confirmed_at,seller_confirmed_at,completed_at) VALUES (?,?,?,25,'EUR','completed',NOW(),NOW(),NOW())`,
            [secondListing, stranger.id, seller.id]);
        await saveReview(stranger, secondDeal.insertId, 303, { rating:'1' });
        await decideReview(secondDeal.insertId, 0, 'approve');
        assert.match((await request({},sellerReviews,200)).html,/2,5 \/ 5 · отзывов: 2/);
        assert.match((await request({},'/listing/' + spare + '/cancellation',200)).html,/2,5 \/ 5 · отзывов: 2/);
        const rated = (await request({},'/listing/' + spare + '/cancellation',200)).html;
        assert.ok(rated.includes('href="' + publicProfile + '">New profile name</a>'));
        assert.equal((rated.match(/--seller-star-fill: 100%/g) || []).length, 2);
        assert.equal((rated.match(/--seller-star-fill: 50%/g) || []).length, 1);
        assert.equal((rated.match(/--seller-star-fill: 0%/g) || []).length, 2);
        const ratedProfile = (await request({}, publicProfile, 200)).html;
        assert.match(ratedProfile, /2,5 \/ 5 · отзывов: 2/);
        assert.equal((ratedProfile.match(/--seller-star-fill: 50%/g) || []).length, 1);
        assert.ok(ratedProfile.includes('href="' + sellerReviews + '">Все отзывы</a>'));
        const reportUrl = '/reviews/' + accepted.id + '/report';
        const adminUrl = '/admin/reviews/' + accepted.id;
        await request(winner, reportUrl, 403, { reason:'Self report' });
        await request(seller, reportUrl, 403, { reason:'CSRF' }, '');
        await request(seller, reportUrl, 303, { reason:'Requires moderator review' });
        await request(seller, reportUrl, 409, { reason:'Duplicate' });
        await request(stranger, '/admin/reviews', 403);
        await request(stranger, adminUrl, 403, { mode:'reject', version:3, reason:'Test', request_key:crypto.randomUUID() });
        assert.match((await request(admin,'/admin/reports/reviews',200)).html, new RegExp('Жалобы на отзыв №' + accepted.id));
        const complaintsPage = '/admin/reports/reviews/' + accepted.id;
        assert.equal((await request(admin, adminUrl + '/reports', 302)).headers.get('location'), complaintsPage);
        assert.match((await request(admin, complaintsPage, 200)).html,/Requires moderator review/);
        const rejectionKey = crypto.randomUUID();
        await decideReview(accepted.id, 3, 'reject', 303, 'Test', admin.token, rejectionKey);
        await decideReview(accepted.id, 3, 'reject', 303, 'Test', admin.token, rejectionKey);
        assert.match((await request(admin,'/admin/reviews?filter=rejected',200)).html,/Причина отклонения:<\/strong> Test/);
        const afterHide = (await request({},sellerReviews,200)).html;
        assert.match(afterHide,/1 \/ 5 · отзывов: 1/);
        assert.match((await request({}, publicProfile, 200)).html, /1 \/ 5 · отзывов: 1/);
        assert.doesNotMatch(afterHide,/&lt;em&gt;/);
        assert.match((await request(winner,'/my-purchases',200)).html,/Отзыв отклонён/);
        assert.match((await request(admin,complaintsPage,200)).html,/Закрыта/);
        assert.equal((await db.execute("SELECT COUNT(*) AS total FROM admin_logs WHERE action='review_reject_v3' AND admin_id=? AND target_id=?",
            [admin.id, accepted.id]))[0][0].total,1);
        await decideReview(accepted.id, 4, 'approve');
        assert.match((await request({},sellerReviews,200)).html,/2,5 \/ 5 · отзывов: 2/);
        await request(stranger, reportUrl, 303, { reason:'Another complaint' });
        await request(admin, complaintsPage, 303, { mode:'dismiss', version:5, reason:'Test', request_key:crypto.randomUUID() });
        assert.match((await request({},sellerReviews,200)).html,/2,5 \/ 5 · отзывов: 2/);
        await start(other,item,404);
        const spareKey = crypto.randomUUID();
        await start(buyer,spare,303,undefined,spareKey);
        await move(seller,(await rows(spare))[0].id,'decline',303);
        assert.deepEqual((await notices((await rows(spare))[0].id, 'declined')).map(row => row.user_id), [buyer.id]);
        await start(buyer,spare,409,undefined,spareKey);
        assert.equal((await rows(spare)).length, 1);
        await start(buyer,spare,303);
        await move(buyer,(await rows(spare))[1].id,'cancel',303);
        assert.deepEqual((await notices((await rows(spare))[1].id, 'cancelled')).map(row => row.user_id), [seller.id]);
        await saveReview(buyer,(await rows(spare))[1].id,409);
        await start(buyer,spare,303);
        await move(seller,(await rows(spare))[2].id,'accept',303);
        await move(seller,(await rows(spare))[2].id,'cancel',303);
        assert.deepEqual((await notices((await rows(spare))[2].id, 'cancelled')).map(row => row.user_id), [buyer.id]);
        assert.deepEqual(events(await dealDetail(buyer, (await rows(spare))[2].id)), ['requested', 'accepted', 'cancelled']);
        const legacyListing = await listing('Legacy deal', 'sold');
        const [legacyDeal] = await db.execute(
            "INSERT INTO deals(listing_id,buyer_id,seller_id,price,currency,status) VALUES (?,?,?,25,'EUR','cancelled')",
            [legacyListing, buyer.id, seller.id]);
        const legacyView = await dealDetail(buyer, legacyDeal.insertId);
        assert.match(legacyView, /Отменена/);
        assert.deepEqual(events(legacyView), ['requested']);
        await start(other,spare,303);
        await request(seller,'/listings/' + spare + '/sold',302,{});
        assert.equal((await rows(spare)).at(-1).status,'declined');
        assert.deepEqual((await notices((await rows(spare)).at(-1).id, 'declined')).map(row => row.user_id), [other.id]);
        for (let i = 0; i < 20; i++) {
            const listingId = await listing('Review pagination', 'sold');
            const [deal] = await db.execute(`INSERT INTO deals(listing_id,buyer_id,seller_id,price,currency,status,
                buyer_confirmed_at,seller_confirmed_at,completed_at) VALUES (?,?,?,25,'EUR','completed',NOW(),NOW(),NOW())`,
                [listingId,buyer.id,seller.id]);
            await db.execute("INSERT INTO reviews (deal_id,rating,comment,moderation_status) VALUES (?,5,?,'approved')", [deal.insertId, 'Pagination review ' + i]);
        }
        const reviewPageOne = (await request({},sellerReviews,200)).html;
        const reviewPageTwo = (await request({},sellerReviews + '?page=2',200)).html;
        assert.equal((reviewPageOne.match(/<article class="card card-body mb-3">/g) || []).length, 20);
        assert.equal((reviewPageTwo.match(/<article class="card card-body mb-3">/g) || []).length, 2);
        assert.match(reviewPageTwo,/Страница 2 из 2/);
        const approvedOne = (await request(admin,'/admin/reviews?filter=approved',200)).html;
        const approvedTwo = (await request(admin,'/admin/reviews?filter=approved&page=2',200)).html;
        assert.equal((approvedOne.match(/Детали отзыва/g) || []).length, 20);
        assert.match(approvedTwo,/Страница 2 из/);
        const seoTitle = 'Городской велосипед +380501234567 buyer@example.invalid';
        const seoId = await listing(seoTitle, 'active');
        const privateId = await listing('SEO private draft', 'draft');
        const blockedId = await listing('SEO blocked listing', 'active');
        await db.execute('UPDATE listings SET status=\'draft\', moderation_locked=1 WHERE id=?', [blockedId]);
        const blockedSellerListing = await listing('SEO blocked seller', 'active');
        await db.execute('UPDATE listings SET user_id=? WHERE id=?', [other.id, blockedSellerListing]);
        await db.execute("UPDATE users SET status='blocked' WHERE id=?", [other.id]);
        await request({}, '/users/' + other.id, 404);
        await request(admin, '/users/' + other.id, 404);
        for (let i = 0; i < 20; i++) await listing('SEO category page ' + i, 'active');
        const legacy = await request({}, '/listings/' + seoId, 301);
        const canonicalPath = legacy.headers.get('location');
        assert.equal(decodeURI(canonicalPath), '/listing/' + seoId + '/городской-велосипед');
        assert.equal((await request({}, '/listing/' + seoId + '/old-slug', 301)).headers.get('location'), canonicalPath);
        const detail = await request({}, canonicalPath + '?utm_source=demo', 200);
        const ld = JSON.parse(detail.html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
        assert.equal(ld['@graph'][0].offers.price, '25.00');
        assert.equal(ld['@graph'][0].offers.priceCurrency, 'EUR');
        assert.equal(ld['@graph'][0].offers.availability, 'https://schema.org/InStock');
        assert.equal(ld['@graph'][1]['@type'], 'BreadcrumbList');
        assert.equal(ld['@graph'][0].url, seoOrigin + canonicalPath);
        assert.doesNotMatch(JSON.stringify(ld), /380501234567|buyer@example/);
        assert.ok(detail.html.includes('rel="canonical" href="' + seoOrigin + canonicalPath + '"'));
        assert.match(detail.html,/property="og:title"/);
        assert.match(detail.html,/name="twitter:card"/);
        assert.match(detail.headers.get('content-security-policy'),/script-src-attr 'none'/);
        await start(buyer, seoId, 303);
        await move(seller, (await rows(seoId))[0].id, 'accept', 303);
        assert.match((await request({}, canonicalPath, 200)).html,/https:\/\/schema.org\/OutOfStock/);
        await request({}, '/listings/' + privateId,404);
        await request({}, '/listings/' + blockedId,404);
        await request({}, '/listings/' + blockedSellerListing,404);
        await request({}, '/listings/' + item,404);
        const privateView = await request(seller, '/listings/' + privateId,200);
        assert.match(privateView.headers.get('x-robots-tag'), /noindex/);
        assert.doesNotMatch(privateView.html,/rel="canonical"|application\/ld\+json/);
        const sitemap = await request({}, '/sitemap.xml',200);
        assert.match(sitemap.headers.get('content-type'),/application\/xml/);
        assert.ok(sitemap.html.includes('<loc>' + seoOrigin + canonicalPath + '</loc>'));
        for (const id of [item, privateId, blockedId, blockedSellerListing]) assert.ok(!sitemap.html.includes('/listing/' + id + '/'));
        assert.ok(sitemap.html.includes('<loc>' + seoOrigin + '/category/' + key + '</loc>'));
        const robots = await request({}, '/robots.txt',200);
        for (const route of ['/profile','/my-listings','/my-purchases','/admin','/messages','/favorites','/notifications',historyPath]) {
            assert.ok(robots.html.includes('Disallow: ' + route + '\n'));
        }
        assert.ok(robots.html.includes('Sitemap: ' + seoOrigin + '/sitemap.xml'));
        const categoryUrl = '/category/' + key;
        const categoryOne = await request({}, categoryUrl,200);
        const categoryTwo = await request({}, categoryUrl + '?page=2',200);
        assert.ok(categoryTwo.html.includes('rel="canonical" href="' + seoOrigin + categoryUrl + '?page=2"'));
        assert.ok(categoryOne.html.includes('href="' + categoryUrl + '?page=2"'));
        for (const url of ['/search?search=SEO', categoryUrl + '?country_id=' + country, categoryUrl + '?page=999', '/profile']) {
            const result = await request(seller,url,200);
            assert.match(result.headers.get('x-robots-tag'),/noindex/);
            assert.doesNotMatch(result.html,/rel="canonical"/);
        }
        const home = await request({}, '/', 200);
        const sellerSeo = await request({}, sellerReviews, 200);
        const sellerLanding = await request({}, publicProfile, 200);
        const pages = [home, categoryOne, categoryTwo, detail, sellerSeo, sellerLanding];
        assert.equal(new Set(pages.map(result => result.html.match(/<title>([^<]+)<\/title>/)[1])).size, pages.length);
        assert.equal(new Set(pages.map(result => result.html.match(/<meta name="description" content="([^"]+)"/)[1])).size, pages.length);
        const publicFirst = await request({}, publicProfile + '?utm_source=demo', 200);
        const publicSecond = await request({}, publicProfile + '?page=2', 200);
        assert.equal(publicFirst.headers.get('x-robots-tag'), 'index, follow');
        assert.match(publicFirst.headers.get('cache-control'), /private, no-store/);
        assert.match(publicFirst.headers.get('content-security-policy'), /script-src-attr 'none'/);
        assert.ok(publicFirst.html.includes('rel="canonical" href="' + seoOrigin + publicProfile + '"'));
        assert.ok(publicSecond.html.includes('rel="canonical" href="' + seoOrigin + publicProfile + '?page=2"'));
        assert.ok(publicFirst.html.includes('href="' + publicProfile + '?page=2"'));
        const cardIds = html => [...html.matchAll(/data-favorite-id="(\d+)"/g)].map(match => Number(match[1]));
        assert.equal(cardIds(publicFirst.html).length, 20);
        assert.equal(cardIds(publicSecond.html).length, 1);
        assert.equal(new Set([...cardIds(publicFirst.html), ...cardIds(publicSecond.html)]).size, 21);
        for (const hidden of [item, privateId, blockedId, blockedSellerListing]) {
            assert.ok(![...cardIds(publicFirst.html), ...cardIds(publicSecond.html)].includes(hidden));
        }
        const cheap = await listing('Sort only cheap', 'active');
        const expensive = await listing('Sort only expensive', 'active');
        await db.execute('UPDATE listings SET price=10.50 WHERE id=?', [cheap]);
        await db.execute('UPDATE listings SET price=1000 WHERE id=?', [expensive]);
        const cheapest = await request({}, publicProfile + '?sort=price_asc', 200);
        const dearest = await request({}, publicProfile + '?sort=price_desc', 200);
        assert.equal(cardIds(cheapest.html)[0], cheap);
        assert.equal(cardIds(dearest.html)[0], expensive);
        assert.equal(cardIds((await request({}, publicProfile, 200)).html)[0], expensive);
        assert.ok(cheapest.html.includes('href="' + publicProfile + '?sort=price_asc&amp;page=2"'));
        assert.match(cheapest.headers.get('x-robots-tag'), /noindex/);
        assert.doesNotMatch(cheapest.html, /rel="canonical"/);
        const outOfRange = await request({}, publicProfile + '?page=9999', 200);
        assert.match(outOfRange.html, /Страница 2 из 2/);
        assert.match(outOfRange.headers.get('x-robots-tag'), /noindex/);

        const privatePhone = '+4917612345601';
        await db.execute('UPDATE users SET phone=?, phone_public=1 WHERE id=?', [privatePhone, seller.id]);
        const publicPhoto = '/uploads/listings/profile-preview-' + key + '.webp';
        await db.execute('INSERT INTO listing_images(listing_id,image_path,sort_order) VALUES (?,?,0)', [expensive, publicPhoto]);
        const publicHtml = (await request(buyer, publicProfile, 200)).html;
        assert.ok(publicHtml.includes(publicPhoto));
        assert.ok(!publicHtml.includes(privatePhone));
        assert.ok(!publicHtml.includes(key + '-0@example.invalid'));
        assert.ok(!publicHtml.includes(buyer.cookie));
        assert.doesNotMatch(publicHtml, /password_hash|phone_public|show-phone|name="phone"/);
        const toggleFavorite = method => fetch(base + '/api/favorites/' + expensive, {
            method, headers: { cookie: buyer.cookie, 'X-CSRF-Token': buyer.token }
        });
        const heart = new RegExp('data-favorite-id="' + expensive + '"\\s+aria-pressed="true"');
        assert.equal((await toggleFavorite('PUT')).status, 200);
        assert.match((await request(buyer, publicProfile, 200)).html, heart);
        assert.doesNotMatch((await request({}, publicProfile, 200)).html, heart);
        assert.equal((await toggleFavorite('DELETE')).status, 200);
        assert.doesNotMatch((await request(buyer, publicProfile, 200)).html, heart);
        const followPath = '/api/following/' + seller.id;
        async function subscription(user, method, status, path = followPath) {
            const response = await fetch(base + path, { method, headers: {
                cookie: user.cookie || '', 'X-CSRF-Token': user.token || '', Accept: 'application/json',
                'Content-Type': 'application/json'
            }, body: JSON.stringify({ user_id: seller.id }) });
            assert.equal(response.status, status, path);
            return response.json();
        }
        const guestPage = await fetch(base + publicProfile);
        const guest = { cookie: guestPage.headers.get('set-cookie').split(';')[0] };
        const guestHtml = await guestPage.text();
        guest.token = guestHtml.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        assert.match(guestHtml, /Войти, чтобы подписаться/);
        assert.doesNotMatch(guestHtml, /data-follow-seller/);
        const listingGuest = (await request({}, canonicalPath, 200)).html;
        assert.match(listingGuest, /Войти, чтобы подписаться на продавца/);
        assert.doesNotMatch(listingGuest, /data-follow-seller=/);
        assert.doesNotMatch((await request(seller, canonicalPath, 200)).html, /data-follow-seller=/);
        const listingFollow = new RegExp('data-follow-seller="' + seller.id + '" aria-pressed="(true|false)"');
        const listingBeforeFollow = (await request(buyer, canonicalPath, 200)).html;
        assert.equal(listingBeforeFollow.match(listingFollow)?.[1], 'false');
        assert.match(listingBeforeFollow, /listing-price-row[\s\S]*listing-detail-favorite[\s\S]*seller-rating-row[\s\S]*data-follow-seller=[\s\S]*Запросить покупку[\s\S]*Написать продавцу[\s\S]*Показать телефон/);
        await request({}, '/listings/' + blockedSellerListing, 404);
        assert.doesNotMatch((await request(admin, '/listings/' + blockedSellerListing, 200)).html, /data-follow-seller=/);
        await subscription(guest, 'PUT', 401);
        await request({}, '/following', 302);
        const feedPath = '/following/feed';
        await request({}, feedPath, 302);
        assert.match((await request(buyer, feedPath, 200)).html, /Найдите интересных продавцов/);
        await subscription(buyer, 'PUT', 404, '/api/following/4294967295');
        await subscription({ ...buyer, token: '' }, 'PUT', 403);
        await subscription(seller, 'PUT', 400);
        await subscription(buyer, 'PUT', 404, '/api/following/' + other.id);
        const duplicates = await Promise.all([subscription(buyer, 'PUT', 200), subscription(buyer, 'PUT', 200)]);
        assert.deepEqual(duplicates, [{ total: 1, following: true }, { total: 1, following: true }]);
        let [[feedCountry]] = await db.execute("SELECT id,code,currency FROM countries WHERE code='UA' AND is_active=1");
        if (!feedCountry) {
            // Use a distinct test country if an inactive UA row already exists.
            const [alternate] = await db.execute("INSERT INTO countries (code,name,currency,language) VALUES ('XQ','Feed fixture country','UAH','uk')");
            createdFeedCountry = alternate.insertId;
            feedCountry = { id: createdFeedCountry, code: 'XQ', currency: 'UAH' };
        }
        const abroad = await listing('Foreign feed fixture', 'active');
        await db.execute('UPDATE listings SET country_id=?,currency=?,price=1 WHERE id=?', [feedCountry.id, feedCountry.currency, abroad]);
        const unfollowed = await listing('Unfollowed feed fixture', 'active');
        await db.execute('UPDATE listings SET user_id=? WHERE id=?', [admin.id, unfollowed]);
        const feedBaseline = (await poll(buyer)).notifications;
        const firstFeed = await request(buyer, feedPath + '?country=DE&sort=price_asc', 200);
        const secondFeed = await request(buyer, feedPath + '?sort=price_asc&page=2', 200);
        assert.match(firstFeed.headers.get('cache-control'), /private, no-store/);
        assert.match(firstFeed.headers.get('x-robots-tag'), /noindex/);
        assert.ok(firstFeed.html.includes('href="' + publicProfile + '">New profile name</a>'));
        assert.match(firstFeed.html, /name="sort" value="price_asc"/);
        const feedCards = [...cardIds(firstFeed.html), ...cardIds(secondFeed.html)];
        assert.equal(feedCards.length, 23);
        assert.equal(new Set(feedCards).size, 23);
        assert.equal(cardIds(firstFeed.html).length, 20);
        assert.equal(cardIds(firstFeed.html)[0], cheap);
        assert.match(firstFeed.html, /data-listing-view-button="grid"/);
        assert.ok(!feedCards.includes(abroad) && !feedCards.includes(unfollowed));
        for (const hiddenListing of [item, privateId, blockedId, blockedSellerListing]) assert.ok(!feedCards.includes(hiddenListing));
        const foreignFeed = await request(buyer, feedPath + '?country=' + feedCountry.code, 200);
        assert.deepEqual(cardIds(foreignFeed.html), [abroad]);
        const globalFeed = await request(buyer, feedPath + '?country=all&sort=price_desc', 200);
        assert.equal(cardIds(globalFeed.html)[0], expensive);
        assert.ok(cardIds((await request(buyer, feedPath + '?sort=price_desc&page=2', 200)).html).includes(abroad));
        assert.ok(cardIds((await request(buyer, feedPath, 200)).html).includes(abroad));
        assert.equal((await poll(buyer)).notifications, feedBaseline);
        assert.equal((await toggleFavorite('PUT')).status, 200);
        assert.match((await request(buyer, feedPath, 200)).html, heart);
        assert.equal((await toggleFavorite('DELETE')).status, 200);
        await request(buyer, feedPath + '?country=DE', 200);
        const listingAfterFollow = (await request(buyer, canonicalPath, 200)).html;
        assert.equal(listingAfterFollow.match(listingFollow)?.[1], 'true');
        assert.match(listingAfterFollow, />\s*Вы подписаны\s*<\/button>/);
        const buyerFollowing = await request(buyer, '/following', 200);
        assert.ok(buyerFollowing.html.includes('href="' + publicProfile + '">New profile name</a>'));
        assert.match(buyerFollowing.headers.get('x-robots-tag'), /noindex/);
        assert.match((await request({}, publicProfile, 200)).html, /data-follower-count aria-live="polite">1</);
        assert.deepEqual(await subscription(buyer, 'DELETE', 200), { total: 0, following: false });
        assert.deepEqual(await subscription(buyer, 'DELETE', 200), { total: 0, following: false });
        assert.match((await request(buyer, feedPath, 200)).html, /Найдите интересных продавцов/);
        assert.equal((await request(buyer, canonicalPath, 200)).html.match(listingFollow)?.[1], 'false');
        assert.doesNotMatch((await request(buyer, '/following', 200)).html, />New profile name<\/a>/);
        await subscription(buyer, 'PUT', 200);
        await subscription(admin, 'PUT', 200);
        await request(admin, '/following/settings', 403, { notify_followed_sellers: 'off' }, '');
        await request(admin, '/following/settings', 303, { notify_followed_sellers: 'off', user_id: buyer.id });
        assert.match((await request(admin, '/following', 200)).html, /value="off" selected/);
        async function publicationNotices(id) {
            return (await db.execute('SELECT id,user_id,text,link FROM notifications WHERE event_key=? ORDER BY user_id',
                ['seller-listing:' + id]))[0];
        }
        const jobs = require('../models/publicationJob.model');
        const jobFor = async id => (await db.execute('SELECT finished_at FROM seller_publication_jobs WHERE listing_id=?', [id]))[0][0];
        const candidate = await listing('Pre-moderation candidate', 'draft');
        const candidatePath = '/listings/' + candidate;
        const decisionPath = '/admin/moderation/' + candidate;
        const currentReview = async () => (await db.execute(
            'SELECT status,review_version,review_reason FROM listings WHERE id=?',[candidate]))[0][0];
        const form = (version, mode, reason = '') => ({ version, mode, reason, request_key:crypto.randomUUID() });
        const edit = title => ({ title, description:'Unaudited text', price:'35', category_id:category, country_id:country });
        await request(seller,candidatePath + '/publish',403,{},'');
        assert.equal((await currentReview()).status,'draft');
        await request(seller,candidatePath + '/publish',302,{});
        let version = (await currentReview()).review_version;
        assert.equal((await currentReview()).status,'pending_review');
        assert.equal(await jobFor(candidate), undefined);
        await request({},candidatePath,404);
        await request(buyer,candidatePath,404);
        await request(buyer,'/admin/moderation',403);
        await request(buyer,decisionPath,403,form(version,'approve'));
        await request(admin,decisionPath,403,form(version,'approve'),'');
        await request(admin,decisionPath,400,form(version,'reject'));
        assert.match((await request(admin, '/admin/moderation?country=' + country + '&category=' + category,200)).html,
            /Pre-moderation candidate/);
        assert.match((await request(admin,candidatePath,200)).html,/Одобрить/);
        await request(admin,decisionPath,303,form(version,'reject','Уточните модель'));
        assert.equal((await currentReview()).status,'rejected');
        assert.equal(await jobFor(candidate), undefined);
        assert.deepEqual(await publicationNotices(candidate), []);
        assert.doesNotMatch((await request({}, publicProfile, 200)).html, /Pre-moderation candidate/);
        assert.match((await request(seller, candidatePath,200)).html,/Уточните модель/);
        assert.match((await request(seller,'/my-listings?status=rejected',200)).html,/Отправить повторно/);
        await request(seller,candidatePath + '/edit',302,edit('Corrected candidate'));
        assert.equal((await currentReview()).status,'rejected');
        await request(seller,candidatePath + '/publish',302,{});
        version = (await currentReview()).review_version;
        await request(seller,candidatePath + '/edit',302,edit('Current version'));
        await request(admin,decisionPath,409,form(version,'approve'));
        version = (await currentReview()).review_version;
        const approve = form(version,'approve');
        rejectedEvent = 'publication-audit';
        await request(admin, decisionPath, 500, approve);
        assert.equal(rejectedEvent, undefined);
        assert.equal(await jobFor(candidate), undefined);
        assert.equal((await currentReview()).status, 'pending_review');
        // Concurrent retries of the same decision leave only one notification and audit entry.
        const approvals = await Promise.all([request(admin,decisionPath,undefined,approve), request(admin,decisionPath,undefined,approve)]);
        assert.ok(approvals.some(reply => reply.status === 303));
        assert.ok(approvals.every(reply => [303,409].includes(reply.status)));
        assert.equal((await currentReview()).status,'active');
        assert.equal((await jobFor(candidate)).finished_at, null);
        assert.deepEqual(await publicationNotices(candidate), []);
        await db.execute("UPDATE users SET status='active' WHERE id=?", [other.id]);
        await subscription(other, 'PUT', 200);
        const unreadBeforePublication = (await poll(buyer)).notifications;
        rejectedEvent = 'publication-checkpoint';
        await assert.rejects(jobs.processBatch(), /Simulated publication write failure/);
        assert.equal(rejectedEvent, undefined);
        assert.deepEqual(await publicationNotices(candidate), []);
        assert.equal((await jobFor(candidate)).finished_at, null);
        const concurrentWork = await Promise.all([jobs.processBatch(), jobs.processBatch()]);
        assert.equal(concurrentWork.filter(Boolean).length, 1);
        const sellerPublication = await publicationNotices(candidate);
        assert.deepEqual(sellerPublication.map(item => item.user_id), [buyer.id]);
        assert.match(sellerPublication[0].text, /Current version/);
        assert.equal(sellerPublication[0].link, '/listings/' + candidate);
        assert.equal((await poll(buyer)).notifications, unreadBeforePublication + 1);
        assert.equal((await request(buyer, '/notifications/' + sellerPublication[0].id + '/open', 302)).headers.get('location'),
            sellerPublication[0].link);
        await request(other, '/notifications/' + sellerPublication[0].id + '/open', 404);
        assert.match((await request({}, publicProfile, 200)).html, /Current version/);
        assert.equal((await db.execute("SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND event_key=?",
            [seller.id,'listing-review:' + candidate + ':' + version]))[0][0].total,1);
        assert.equal((await db.execute('SELECT COUNT(*) AS total FROM admin_logs WHERE action_key=?',[approve.request_key]))[0][0].total,1);
        assert.ok((await request({},'/sitemap.xml',200)).html.includes('/listing/' + candidate + '/'));
        const favorite = await fetch(base + '/api/favorites/' + candidate, {
            method:'PUT', headers:{ cookie:buyer.cookie, 'X-CSRF-Token':buyer.token }
        });
        assert.equal(favorite.status,200);
        const alertPath = candidatePath + '/price-alert';
        await request(buyer, alertPath, 403, { enabled: 'yes' }, '');
        await request(other, alertPath, 404, { enabled: 'yes' });
        await request(buyer, alertPath, 303, { enabled: 'yes' });
        const countViewPath = '/api/listing-views/' + candidate;
        await request(buyer, countViewPath, 403, {}, '');
        await request(seller, countViewPath, 204, {});
        await request(buyer, countViewPath, 204, {});
        await request(buyer, countViewPath, 204, {});
        const [[counted]] = await db.execute('SELECT views FROM listings WHERE id=?', [candidate]);
        assert.equal(counted.views, 1);
        await request({}, '/seller-stats', 302);
        assert.match((await request(seller, '/seller-stats', 200)).html, /Current version/);
        assert.doesNotMatch((await request(buyer, '/seller-stats?user_id=' + seller.id, 200)).html, /Current version/);
        const comparePath = '/compare?ids=' + [candidate, privateId, blockedId, candidate].join(',');
        const compare = await request({}, comparePath, 200);
        assert.match(compare.html, /Current version/);
        assert.equal((compare.html.match(/data-remove-comparison=/g) || []).length, 1);
        const comparisonPreview = await request(buyer, '/compare?ids=' + [candidate, expensive, abroad, cheap].join(','), 200);
        assert.match(comparisonPreview.html, /Цены указаны в исходных валютах/);
        assert.match(comparisonPreview.html, /data-compare-differences/);
        assert.match(comparisonPreview.html, /data-compare-clear/);
        assert.match(comparisonPreview.html, /compare-difference/);
        assert.ok(comparisonPreview.html.includes(publicPhoto));
        assert.equal((comparisonPreview.html.match(/data-remove-comparison=/g) || []).length, 4);
        for (const url of ['/', '/search', categoryUrl, '/recommendations', '/favorites',
            (await request(buyer, candidatePath, 301)).headers.get('location')]) {
            const compareSurface = await request(buyer, url, 200);
            assert.match(compareSurface.html, /data-compare-id=/, url);
            assert.match(compareSurface.html, /data-header-compare/, url);
            assert.doesNotMatch(compareSurface.html, /data-compare-bar|data-compare-clear/, url);
        }
        await start(buyer,candidate,303);
        await request(buyer, '/messages/start', 303, { listing_id: candidate });
        const ownerCardPath = '/my-listings?q=' + encodeURIComponent('Current version');
        assert.deepEqual(cardMetrics((await request(seller, ownerCardPath + '&status=active', 200)).html), [1, 1, 1]);
        assert.deepEqual(cardMetrics((await request(buyer, ownerCardPath + '&user_id=' + seller.id, 200)).html), []);
        await recordView(buyer, candidate);
        assert.ok((await historyIds(buyer)).includes(candidate));
        await request(seller,candidatePath + '/edit',302,{ ...edit('Private pending edit'), price: '30', attr_condition: 'like_new' });
        assert.equal((await currentReview()).status,'pending_review');
        assert.deepEqual(cardMetrics((await request(seller, '/my-listings?status=pending_review&q=Private+pending+edit', 200)).html), [1, 1, 1]);
        assert.doesNotMatch((await request({}, comparePath, 200)).html, /Private pending edit|Current version/);
        const priceHistory = async () => (await db.execute('SELECT price,is_drop FROM listing_price_history WHERE listing_id=? ORDER BY id', [candidate]))[0];
        assert.deepEqual(await priceHistory(), [{ price: '35.00', is_drop: 0 }]);
        await request(buyer, '/notifications/' + sellerPublication[0].id + '/open', 404);
        await request({},candidatePath,404);
        await start(buyer,candidate,404);
        await request(buyer,'/messages/start',404,{ listing_id:candidate });
        assert.doesNotMatch((await request(buyer,'/my-purchases',200)).html,/Private pending edit/);
        assert.doesNotMatch((await request(buyer,'/favorites',200)).html,/Private pending edit/);
        const pendingPhoto = '/uploads/listings/private-profile-' + key + '.webp';
        await db.execute('INSERT INTO listing_images(listing_id,image_path,sort_order) VALUES (?,?,0)', [candidate, pendingPhoto]);
        const profileDuringReview = (await request(buyer, publicProfile, 200)).html;
        assert.doesNotMatch(profileDuringReview, /Private pending edit|Current version/);
        assert.ok(!profileDuringReview.includes(pendingPhoto));
        const feedDuringReview = (await request(buyer, feedPath, 200)).html;
        assert.doesNotMatch(feedDuringReview, /Private pending edit|Current version/);
        assert.ok(!feedDuringReview.includes(pendingPhoto));
        const historyDuringReview = (await request(buyer, historyPath, 200)).html;
        assert.doesNotMatch(historyDuringReview, /Private pending edit|Current version/);
        assert.ok(!historyDuringReview.includes(pendingPhoto));
        await recordView(buyer, candidate);
        assert.deepEqual(await historyIds(buyer), [candidate]);
        await db.execute('DELETE FROM listing_images WHERE listing_id=? AND image_path=?', [candidate, pendingPhoto]);
        assert.ok(!(await request({},'/sitemap.xml',200)).html.includes('/listing/' + candidate + '/'));
        version = (await currentReview()).review_version;
        const race = await Promise.all([
            request(admin,decisionPath,undefined,form(version,'approve')),
            request(admin,decisionPath,undefined,form(version,'reject','Race decision'))
        ]);
        assert.deepEqual(race.map(item=>item.status).sort(),[303,409]);
        if ((await currentReview()).status === 'rejected') {
            await request(seller,candidatePath + '/publish',302,{});
            await request(admin,decisionPath,303,form((await currentReview()).review_version,'approve'));
        }
        assert.equal(await jobs.processBatch(), false);
        assert.deepEqual(await publicationNotices(candidate), sellerPublication);
        assert.deepEqual(await priceHistory(), [{ price: '35.00', is_drop: 0 }, { price: '30.00', is_drop: 1 }]);
        const finalComparison = await request({}, comparePath, 200);
        assert.match(finalComparison.html, /Как новое/);
        const priceNotices = (await db.execute("SELECT user_id FROM notifications WHERE event_key LIKE ?", ['price-drop:' + candidate + ':%']))[0];
        assert.deepEqual(priceNotices, [{ user_id: buyer.id }]);
        await move(seller,(await rows(candidate))[0].id,'accept',303);
        await request(seller,candidatePath + '/edit',409,edit('Edit during deal'));
        await request(seller,candidatePath + '/images/1/delete',409,{});
        assert.equal((await currentReview()).status,'active');
        async function publishFixture(title, beforePublish) {
            const id = await listing(title, 'draft');
            if (beforePublish) await beforePublish(id);
            await request(seller, '/listings/' + id + '/publish', 302, {});
            const [[listingVersion]] = await db.execute('SELECT review_version FROM listings WHERE id=?', [id]);
            await request(admin, '/admin/moderation/' + id, 303, form(listingVersion.review_version, 'approve'));
            return id;
        }
        const historical = await publishFixture('Historical publication fixture', id =>
            db.execute('UPDATE listings SET subscription_announcement_pending=0 WHERE id=?', [id]));
        assert.equal(await jobFor(historical), undefined);
        const withdrawn = await publishFixture('Withdrawn before notification');
        assert.equal((await jobFor(withdrawn)).finished_at, null);
        await request(seller, '/listings/' + withdrawn + '/unpublish', 302, {});
        assert.equal(await jobs.processBatch(), true);
        assert.deepEqual(await publicationNotices(withdrawn), []);
        assert.ok((await jobFor(withdrawn)).finished_at);

        subscriberFixture = key + '-batch-%@example.invalid';
        await db.query('INSERT INTO users (name,email,password_hash) VALUES ?', [
            Array.from({ length: 201 }, (_, index) => ['Batch subscriber', key + '-batch-' + index + '@example.invalid', 'test-only'])
        ]);
        await db.execute('INSERT INTO seller_follows(seller_id,follower_id) SELECT ?,id FROM users WHERE email LIKE ?',
            [seller.id, subscriberFixture]);
        const batchListing = await publishFixture('Publication with multiple batches');
        assert.equal(await jobs.processBatch(), true);
        assert.ok((await publicationNotices(batchListing)).length <= 200);
        assert.equal((await jobFor(batchListing)).finished_at, null);
        assert.equal(await jobs.processBatch(), true);
        assert.equal((await publicationNotices(batchListing)).length, 203);
        assert.ok((await jobFor(batchListing)).finished_at);
        await db.execute('DELETE FROM users WHERE email LIKE ?', [subscriberFixture]);
        assert.match((await request({}, publicProfile, 200)).html, /data-follower-count aria-live="polite">3</);

        const savedPath = '/saved-searches';
        savedChild = (await db.execute("INSERT INTO categories(parent_id,slug,name) VALUES (?,?,'Saved search child')",
            [category, key + '-saved-child']))[0].insertId;
        savedCity = (await db.execute("INSERT INTO cities(country_id,name) VALUES (?,'Saved search city')", [country]))[0].insertId;
        const savedFilters = { search: 'Saved match', country_id: country, city_id: savedCity, category_id: category,
            min_price: '24,50', max_price: '25', currency: 'EUR', sort: 'price_desc', page: '3' };
        const savedNotices = async id => (await db.execute('SELECT user_id,text,link FROM notifications WHERE event_key=?',
            ['saved-search-listing:' + id]))[0];
        assert.match((await request(buyer, '/search?' + new URLSearchParams(savedFilters), 200)).html, /Сохранить поиск/);
        await request(buyer, savedPath, 403, savedFilters, '');
        await request(buyer, savedPath, 400, { ...savedFilters, country_id: feedCountry.id });
        await request(buyer, savedPath, 400, { ...savedFilters, currency: '' });
        const saves = await Promise.all([request(buyer, savedPath, 303, savedFilters),
            request(buyer, savedPath, 303, { ...savedFilters, page: '1' })]);
        assert.equal(saves[0].headers.get('location'), savedPath);
        const [savedRows] = await db.execute('SELECT id,name,notify FROM saved_searches WHERE user_id=?', [buyer.id]);
        assert.equal(savedRows.length, 1);
        const savedId = savedRows[0].id;
        const openSaved = savedPath + '/' + savedId + '/open';
        const editSaved = savedPath + '/' + savedId;
        const opened = new URL((await request(buyer, openSaved, 302)).headers.get('location'), base);
        assert.equal(opened.pathname, '/search');
        assert.equal(opened.searchParams.get('city_id'), String(savedCity));
        assert.equal(opened.searchParams.get('min_price'), '24.50');
        assert.equal(opened.searchParams.get('sort'), 'price_desc');
        assert.ok(!opened.searchParams.has('page'));
        await request(other, openSaved, 404);
        await request(other, editSaved, 404, { intent: 'delete' });
        await request(buyer, editSaved, 403, { intent: 'update', name: 'Blocked by CSRF' }, '');
        await request(buyer, editSaved, 303, { intent: 'update', name: 'Renamed saved search', notify: '1' });
        const savedPage = await request(buyer, savedPath, 200);
        assert.match(savedPage.html, /Renamed saved search/);
        assert.match(savedPage.headers.get('x-robots-tag'), /noindex/);
        assert.match(savedPage.html, /Saved search city/);
        await request(admin, savedPath, 303, savedFilters);
        const [[muted]] = await db.execute('SELECT id FROM saved_searches WHERE user_id=?', [admin.id]);
        await request(admin, savedPath + '/' + muted.id, 303, { intent: 'update', name: 'Muted filter' });
        await request(buyer, savedPath, 303, { ...savedFilters, category_id: savedChild });
        await request(other, savedPath, 303, { ...savedFilters, min_price: '26', max_price: '30' });
        await request(other, savedPath, 303, { ...savedFilters, currency: feedCountry.currency });
        await request(other, savedPath, 303, { ...savedFilters, city_id: '', country_id: feedCountry.id });
        await request(seller, savedPath, 303, savedFilters);
        const savedListing = await publishFixture('Saved match in a child category', id =>
            db.execute('UPDATE listings SET city_id=?,category_id=? WHERE id=?', [savedCity, savedChild, id]));
        assert.deepEqual(await savedNotices(savedListing), []);
        assert.equal((await Promise.all([jobs.processBatch(), jobs.processBatch()])).filter(Boolean).length, 1);
        const deliveredSaved = await savedNotices(savedListing);
        assert.deepEqual(deliveredSaved.map(item => item.user_id), [buyer.id]);
        assert.equal(deliveredSaved[0].link, '/listings/' + savedListing);
        assert.match(deliveredSaved[0].text, /Saved match in a child category.*25\.00 EUR/);
        const recPath = '/recommendations';
        const recPage = await request(buyer, recPath + '?country=DE', 200);
        assert.match(recPage.headers.get('cache-control'), /no-store/);
        assert.match(recPage.headers.get('x-robots-tag'), /noindex/);
        assert.equal(cardIds(recPage.html)[0], savedListing);
        assert.match(recPage.html, /data-listing-view-button="list"/);
        const recPageTwo = cardIds((await request(buyer, recPath + '?page=2', 200)).html);
        assert.equal(cardIds(recPage.html).length, 20);
        assert.ok(recPageTwo.length > 0 && recPageTwo.every(id => !cardIds(recPage.html).includes(id)));
        const recHome = (await request(buyer, '/', 200)).html.match(/aria-labelledby="recommendations-title"[\s\S]*?<\/section>/)[0];
        assert.deepEqual(cardIds(recHome), cardIds(recPage.html).slice(0, 8));
        assert.match(recHome, /href="\/recommendations"/);
        const latest = cardIds((await request(buyer, recPath + '?sort=newest', 200)).html);
        const [expectedLatest] = await db.execute(`SELECT l.id FROM listings l JOIN users u ON u.id=l.user_id
            WHERE l.status='active' AND l.moderation_locked=0 AND u.status='active' AND l.country_id=? AND l.user_id<>?
            ORDER BY l.created_at DESC,l.id DESC LIMIT 20`, [country, buyer.id]);
        assert.deepEqual(latest, expectedLatest.map(row => row.id));
        const similarCards = cardIds((await request(buyer, canonicalPath, 200)).html.match(/aria-labelledby="similar-title"[\s\S]*?<\/section>/)[0]);
        assert.equal(similarCards.length, 4);
        assert.ok(!similarCards.includes(seoId));
        const foreignRecs = cardIds((await request(buyer, recPath + '?country=' + feedCountry.code, 200)).html);
        assert.ok(foreignRecs.includes(abroad) && !foreignRecs.includes(savedListing));
        assert.ok(!cardIds((await request(seller, recPath + '?country=all', 200)).html).includes(savedListing));
        await request(buyer, recPath + '?country=all', 200);
        assert.ok((await publicationNotices(savedListing)).some(notice => notice.user_id === buyer.id));
        assert.ok((await request(buyer, opened.pathname + opened.search, 200)).html.includes('Saved match in a child category'));
        await request(seller, '/listings/' + savedListing + '/unpublish', 302, {});
        await request(seller, '/listings/' + savedListing + '/publish', 302, {});
        const [[reapproval]] = await db.execute('SELECT review_version FROM listings WHERE id=?', [savedListing]);
        await request(admin, '/admin/moderation/' + savedListing, 303, form(reapproval.review_version, 'approve'));
        assert.equal(await jobs.processBatch(), false);
        assert.deepEqual(await savedNotices(savedListing), deliveredSaved);
        await request(buyer, editSaved, 303, { intent: 'delete' });
        await request(buyer, openSaved, 404);

        // Exercise the real login and session rotation without leaving either fixture account active outside this test.
        const password = 'test-only-' + key;
        await db.execute('UPDATE users SET password_hash=? WHERE id=?', [await require('bcrypt').hash(password, 4), buyer.id]);
        const pendingResponse = await request(guest, savedPath, 303, { search: 'Guest saved filters', country_id: country });
        assert.equal(pendingResponse.headers.get('location'), '/login');
        const loginResponse = await request(guest, '/login', 302, { email: key + '-1@example.invalid', password });
        assert.equal(loginResponse.headers.get('location'), savedPath + '/new');
        const afterLogin = { cookie: loginResponse.headers.get('set-cookie').split(';')[0] };
        assert.notEqual(afterLogin.cookie, guest.cookie);
        const pendingPage = await request(afterLogin, savedPath + '/new', 200);
        assert.match(pendingPage.html, /name="search" value="Guest saved filters"/);
        assert.ok(pendingPage.html.includes('name="country_id" value="' + country + '"'));
        afterLogin.token = pendingPage.html.match(/name="favorites-csrf-token" content="([a-f0-9]{64})"/)[1];
        await request(afterLogin, savedPath, 303, { search: 'Guest saved filters', country_id: country });
        for (let i = 0; i < 29; i++) {
            await request(other, savedPath, i < 27 ? 303 : 409, { search: 'Saved limit ' + i });
        }
        const [[savedCount]] = await db.execute('SELECT COUNT(*) AS total FROM saved_searches WHERE user_id=?', [other.id]);
        assert.equal(Number(savedCount.total), 30);

        await request({}, historyPath, 302);
        await request({}, '/api/recently-viewed/' + cheap, 302, {});
        await request(buyer, historyPath + '/clear', 403, {}, '');
        await request(buyer, '/profile/viewing-history', 403, { save_listing_history: 'off' }, '');
        assert.match((await request(buyer, '/profile', 200)).html, /value="on" selected>Включено/);
        assert.match((await request(buyer, canonicalPath, 200)).html, /src="\/js\/recently-viewed\.js"/);
        assert.doesNotMatch((await request(seller, canonicalPath, 200)).html, /src="\/js\/recently-viewed\.js"/);
        assert.doesNotMatch((await request({}, canonicalPath, 200)).html, /src="\/js\/recently-viewed\.js"/);
        const head = await fetch(base + canonicalPath, { method: 'HEAD', headers: { cookie: buyer.cookie } });
        assert.equal(head.status, 200);
        const preload = await fetch(base + '/api/recently-viewed/' + cheap, { method: 'POST', headers: {
            cookie: buyer.cookie, 'X-CSRF-Token': buyer.token, 'Sec-Purpose': 'prefetch'
        }});
        assert.equal(preload.status, 204);
        assert.deepEqual(await historyIds(buyer), [candidate]);
        await recordView(buyer, cheap, 403, '');
        await recordView(seller, cheap);
        for (const unavailable of [privateId, blockedId, item]) await recordView(buyer, unavailable);
        await db.execute("UPDATE users SET status='blocked' WHERE id=?", [other.id]);
        await recordView(buyer, blockedSellerListing);
        await db.execute("UPDATE users SET status='active' WHERE id=?", [other.id]);
        assert.deepEqual(await historyIds(seller), []);
        assert.deepEqual(await historyIds(buyer), [candidate]);
        await recordView(buyer, cheap);
        await recordView(buyer, expensive);
        await Promise.all([recordView(buyer, cheap), recordView(buyer, cheap)]);
        assert.deepEqual(await historyIds(buyer), [cheap, expensive, candidate]);
        assert.match((await request(other, historyPath + '?user_id=' + buyer.id, 200)).html, /История просмотров пока пуста/);
        await request(other, historyPath + '/' + cheap + '/remove', 303, {});
        assert.deepEqual(await historyIds(buyer), [cheap, expensive, candidate]);
        await request(buyer, historyPath + '/' + expensive + '/remove', 403, {}, '');
        await request(buyer, historyPath + '/' + expensive + '/remove', 303, { user_id: other.id });
        assert.deepEqual(await historyIds(buyer), [cheap, candidate]);
        const historyPage = await request(buyer, historyPath, 200);
        assert.match(historyPage.headers.get('cache-control'), /no-store/);
        assert.match(historyPage.headers.get('x-robots-tag'), /noindex/);
        assert.match(historyPage.html, /Да, очистить историю/);
        assert.equal(cardIds(historyPage.html)[0], cheap);
        await request(buyer, '/profile/viewing-history', 303, { save_listing_history: 'off', user_id: other.id });
        assert.doesNotMatch((await request(buyer, canonicalPath, 200)).html, /src="\/js\/recently-viewed\.js"/);
        await recordView(buyer, expensive);
        assert.deepEqual(await historyIds(buyer), [cheap, candidate]);
        await request(buyer, '/profile/viewing-history', 303, { save_listing_history: 'on' });
        await recordView(buyer, expensive);
        assert.equal((await toggleFavorite('PUT')).status, 200);
        assert.match((await request(buyer, historyPath, 200)).html, heart);
        assert.equal((await toggleFavorite('DELETE')).status, 200);
        await db.query('INSERT INTO listings(user_id,category_id,country_id,title,description,price,currency,status) VALUES ?', [
            Array.from({ length: 105 }, (_, index) => [seller.id, category, country, 'History test ' + index, 'Fixture', 10, 'EUR', 'active'])
        ]);
        const [historyFixtures] = await db.execute("SELECT id FROM listings WHERE category_id=? AND title LIKE 'History test %' ORDER BY id", [category]);
        for (let start = 0; start < historyFixtures.length; start += 15) {
            await Promise.all(historyFixtures.slice(start, start + 15).map(row => recordView(buyer, row.id)));
        }
        const capped = await historyIds(buyer);
        assert.equal(capped.length, 100);
        assert.ok(!capped.includes(cheap) && !capped.includes(expensive));
        await recordView(buyer, capped.at(-1));
        const moved = await historyIds(buyer);
        assert.equal(moved.length, 100);
        assert.equal(moved[0], capped.at(-1));
        const recentSection = html => html.match(/<section\b[^>]*aria-labelledby="recent-listings-title"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? '';
        const homePreview = recentSection((await request(buyer, '/', 200)).html);
        assert.deepEqual(cardIds(homePreview), moved.slice(0, 4));
        assert.match(homePreview, /href="\/recently-viewed">Смотреть все/);
        await recordView(buyer, seoId);
        assert.deepEqual(cardIds(recentSection((await request(buyer, canonicalPath, 200)).html)), moved.slice(0, 4));
        assert.equal(recentSection((await request({}, canonicalPath, 200)).html), '');
        assert.equal(recentSection((await request(other, canonicalPath, 200)).html), '');
        await request(buyer, '/profile/viewing-history', 303, { save_listing_history: 'off' });
        assert.equal(recentSection((await request(buyer, canonicalPath, 200)).html), '');
        await request(buyer, '/profile/viewing-history', 303, { save_listing_history: 'on' });
        const paginatedHistory = [];
        for (let page = 1; page <= 5; page++) {
            const cards = cardIds((await request(buyer, historyPath + '?page=' + page, 200)).html);
            assert.equal(cards.length, 20);
            paginatedHistory.push(...cards);
        }
        assert.deepEqual(paginatedHistory, [seoId, ...moved.slice(0, 99)]);
        await db.execute("UPDATE listings SET status='draft', moderation_locked=1 WHERE id=?", [moved[0]]);
        assert.deepEqual(cardIds(recentSection((await request(buyer, canonicalPath, 200)).html)), moved.slice(1, 5));
        await recordView(other, cheap);
        await request(buyer, historyPath + '/clear', 303, { user_id: other.id });
        assert.deepEqual(await historyIds(buyer), []);
        assert.deepEqual(await historyIds(other), [cheap]);
        assert.match((await request(buyer, historyPath, 200)).html, /История просмотров пока пуста/);

        // Two equally recent items in the same category: only the price signal distinguishes them.
        const near = await listing('Recommendation near', 'active');
        const far = await listing('Recommendation far', 'active');
        await db.execute("UPDATE listings SET category_id=?,created_at='2020-01-01',price=IF(id=?,25,500) WHERE id IN (?,?)",
            [savedChild, near, near, far]);
        const recommendationModel = require('../models/recommendation.model');
        async function orderedPair(historyEnabled) {
            const options = { userId: other.id, countryId: country, historyEnabled };
            const first = await recommendationModel(options);
            const ids = first.listings.map(row => row.id);
            for (let p = 2; p <= first.totalPages; p++) {
                const next = await recommendationModel({ ...options, requestedPage: p });
                ids.push(...next.listings.map(row => row.id));
            }
            assert.ok(![privateId, blockedId, item, abroad].some(id => ids.includes(id)));
            return ids.filter(id => id === near || id === far);
        }
        await recordView(other, savedListing);
        assert.deepEqual(await orderedPair(true), [near, far]);
        assert.deepEqual(await orderedPair(false), [far, near]);
        await db.execute('INSERT INTO favorites(user_id,listing_id) VALUES (?,?)', [other.id, savedListing]);
        assert.deepEqual(await orderedPair(false), [near, far]);

        const negotiable = await listing('Negotiation fixture', 'active');
        const offerData = { listing_id: negotiable, listing_version: '0', currency: 'EUR', amount: '10.25', request_key: crypto.randomUUID() };
        await request({}, '/offers', 302);
        await request(buyer, '/offers', 404, offerData);
        const negotiableEdit = { title: 'Negotiation fixture', description: 'Test', price: '25',
            country_id: country, category_id: category };
        await request(seller, '/listings/' + negotiable + '/edit', 400, { ...negotiableEdit, bargaining_enabled: 'invalid' });
        await request(seller, '/listings/' + negotiable + '/edit', 302, { ...negotiableEdit, bargaining_enabled: '1' });
        const [[editedOfferListing]] = await db.execute('SELECT bargaining_enabled,status,review_version FROM listings WHERE id=?', [negotiable]);
        assert.equal(editedOfferListing.bargaining_enabled, 1);
        assert.equal(editedOfferListing.status, 'pending_review');
        await request(buyer, '/listings/' + negotiable, 404);
        await request(admin, '/admin/moderation/' + negotiable, 303, form(editedOfferListing.review_version,'approve'));
        offerData.listing_version = String(editedOfferListing.review_version);
        const negotiablePath = (await request(buyer, '/listings/' + negotiable, 301)).headers.get('location');
        assert.match((await request(buyer, negotiablePath, 200)).html, /Запросить покупку<\/button>\s*<\/form>\s*<button[^>]*data-open-price-offer>Предложить свою цену/);
        assert.doesNotMatch((await request(seller, negotiablePath, 200)).html, /data-open-price-offer/);
        await request(seller, '/offers', 404, offerData);
        await request(buyer, '/offers', 403, offerData, '');
        await request(buyer, '/offers', 400, { ...offerData, amount: '10.251' });
        await request(buyer, '/offers', 409, { ...offerData, currency: 'UAH' });
        const openedOffer = (await request(buyer, '/offers', 303, offerData)).headers.get('location');
        assert.equal((await request(buyer, '/offers', 303, offerData)).headers.get('location'), openedOffer);
        await request(buyer, '/offers', 409, { ...offerData, request_key: crypto.randomUUID() });
        await request(other, openedOffer, 404);
        assert.match((await request(seller, '/offers?side=received', 200)).html, /Negotiation fixture/);
        const offerPage = await request(buyer, openedOffer, 200);
        assert.match(offerPage.html, /10\.25 EUR/);
        assert.match(offerPage.headers.get('x-robots-tag'), /noindex/);
        await request(buyer, openedOffer + '/reply', 409, { version: '1', action: 'accepted' });
        await request(seller, openedOffer + '/reply', 303, { version: '1', action: 'countered', amount: '12,50' });
        const racing = await Promise.all([
            request(buyer, openedOffer + '/reply', undefined, { version: '2', action: 'accepted' }),
            request(buyer, openedOffer + '/reply', undefined, { version: '2', action: 'accepted' })
        ]);
        assert.deepEqual(racing.map(result => result.status).sort(), [303,409]);
        await request(seller, openedOffer + '/checkout', 404, {});
        const checkout = await request(buyer, openedOffer + '/checkout', 303, {});
        assert.equal((await request(buyer, openedOffer + '/checkout', 303, {})).headers.get('location'), checkout.headers.get('location'));
        const [agreedDeal] = await rows(negotiable);
        assert.equal((await rows(negotiable)).length, 1);
        assert.equal(agreedDeal.price, '12.50');
        assert.equal(agreedDeal.currency, 'EUR');
        assert.equal(agreedDeal.status, 'requested');
        assert.equal((await db.execute('SELECT price FROM listings WHERE id=?', [negotiable]))[0][0].price, '25.00');
        assert.match((await request(buyer, checkout.headers.get('location'), 200)).html, /12[,.]5/);
        const declinedOffer = (await request(other, '/offers', 303, offerData)).headers.get('location');
        await request(seller, declinedOffer + '/reply', 303, { version: '1', action: 'declined' });
        await request(other, '/offers', 409, { ...offerData, request_key: crypto.randomUUID() });
        await request(buyer, '/offers', 409, { ...offerData, listing_version: '0', request_key: crypto.randomUUID() });
        const [offerNotices] = await db.execute('SELECT id,user_id FROM notifications WHERE link=? ORDER BY id', [openedOffer]);
        assert.deepEqual(offerNotices.map(row => row.user_id), [seller.id, buyer.id, seller.id]);
        await request(seller, '/notifications/' + offerNotices[0].id + '/open', 302);
        await request(other, '/notifications/' + offerNotices[0].id + '/open', 404);
        await request(seller, '/listings/' + negotiable + '/edit', 302, { ...negotiableEdit, description: 'Updated negotiation fixture',
            price: '24.50', attr_condition: 'good', bargaining_enabled: '0' });
        const [[disabledOfferListing]] = await db.execute(
            'SELECT bargaining_enabled,review_version,description,price,currency,category_id,country_id,item_condition FROM listings WHERE id=?', [negotiable]);
        assert.equal(disabledOfferListing.bargaining_enabled, 0);
        assert.deepEqual(disabledOfferListing, { bargaining_enabled: 0, review_version: disabledOfferListing.review_version,
            description: 'Updated negotiation fixture', price: '24.50', currency: 'EUR', category_id: category,
            country_id: country, item_condition: null });
        await request(admin, '/admin/moderation/' + negotiable, 303, form(disabledOfferListing.review_version,'approve'));
        assert.doesNotMatch((await request(buyer, negotiablePath, 200)).html, /data-open-price-offer/);

        const sms = require('../services/phoneSms');
        const rateKey = crypto.randomBytes(32);
        const previousSms = { configuration: sms.configuration, send: sms.send };
        const phone = '+49' + String(crypto.randomInt(1000000000)).padStart(9, '0');
        const secondPhone = '+48' + phone.slice(3);
        const receivedCodes = new Map();
        const sendCode = '/profile/phone/verification/send';
        const confirmCode = '/profile/phone/verification/confirm';
        const badge = /title="Телефон подтверждён"/;
        try {
            for (const user of [seller, buyer]) await request(user, '/profile/phone', 303, { phone });
            assert.match((await request(seller, '/profile', 200)).html, /id="phone-code"/);
            await request({}, sendCode, 302, {});
            await request(seller, sendCode, 403, {}, '');
            sms.configuration = () => null;
            await request(seller, sendCode, 503, {});
            assert.doesNotMatch((await request({}, publicProfile, 200)).html, badge);
            sms.configuration = () => ({ key: rateKey });
            sms.send = async (_, recipient, code) => { receivedCodes.set(recipient, code); };
            await request(seller, sendCode, 303, {});
            const code = receivedCodes.get(phone);
            assert.match(code, /^\d{6}$/);
            assert.match((await request(seller, sendCode, 429, {})).headers.get('retry-after'), /^\d+$/);
            const wrongCode = code === '000000' ? '111111' : '000000';
            await request(seller, confirmCode, 422, { code: wrongCode });
            await request(seller, confirmCode, 303, { code });
            await request(seller, confirmCode, 422, { code });
            const verifiedProfile = (await request({}, publicProfile, 200)).html;
            assert.match(verifiedProfile, badge);
            assert.ok(!verifiedProfile.includes(phone));
            assert.match((await request({}, negotiablePath, 200)).html, badge);
            await request(buyer, sendCode, 303, {});
            await request(buyer, confirmCode, 422, { code: receivedCodes.get(phone) });
            await request(seller, '/profile/phone', 303, { phone, phone_public: '1' });
            assert.match((await request({}, publicProfile, 200)).html, badge);
            await request(seller, '/profile/phone', 303, { phone: secondPhone });
            assert.doesNotMatch((await request({}, publicProfile, 200)).html, badge);
            // Use a different account to exercise expiry and attempt cap without bypassing its resend budget.
            await request(other, '/profile/phone', 303, { phone: secondPhone });
            await request(other, sendCode, 303, {});
            const otherCode = receivedCodes.get(secondPhone);
            const otherWrong = otherCode === '000000' ? '111111' : '000000';
            for (let i = 0; i < 5; i++) await request(other, confirmCode, 422, { code: otherWrong });
            await request(other, confirmCode, 422, { code: otherCode });
            const [[attempts]] = await db.execute('SELECT attempts FROM phone_verifications WHERE user_id=?', [other.id]);
            assert.equal(attempts.attempts, 5);
            await db.execute('UPDATE phone_verifications SET attempts=0,expires_at=CURRENT_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE user_id=?', [other.id]);
            await request(other, confirmCode, 422, { code: otherCode });
            await request(other, '/profile/phone', 303, { phone });
            assert.equal((await db.execute('SELECT 1 FROM phone_verifications WHERE user_id=?', [other.id]))[0].length, 0);
        } finally {
            Object.assign(sms, previousSms);
            for (const action of ['send', 'confirm']) {
                for (const [scope, values] of Object.entries({ resend: [seller.id, buyer.id, other.id],
                    account: [seller.id, buyer.id, other.id], phone: [phone, secondPhone], ip: ['127.0.0.1'] })) {
                    for (const value of values) {
                        const digest = crypto.createHmac('sha256', rateKey).update(JSON.stringify(['phone-rate', action, scope, value])).digest('hex');
                        await db.execute('DELETE FROM auth_rate_limits WHERE key_hash=?', [digest]);
                    }
                }
            }
        }
        const reportPath = publicProfile + '/report';
        await request({}, reportPath, 302, { reason: 'fraud' });
        await request(seller, reportPath, 400, { reason: 'fraud' });
        await request(buyer, reportPath, 403, { reason: 'fraud' }, '');
        await request(buyer, reportPath, 303, { reason: 'fraud', comment: '<b>Trust fixture</b>' });
        await request(buyer, reportPath, 409, { reason: 'fraud' });
        await request(seller, '/admin/seller-reports', 403);
        const reportQueue = (await request(admin, '/admin/seller-reports', 200)).html;
        assert.match(reportQueue, /&lt;b&gt;Trust fixture&lt;\/b&gt;/);
        const [[reportRow]] = await db.execute('SELECT id FROM seller_reports WHERE author_id=? AND seller_id=?', [buyer.id, seller.id]);
        const reportAction = '/admin/seller-reports/' + reportRow.id;
        const resolution = { status: 'accepted', reason: 'Reviewed test report', request_key: crypto.randomUUID() };
        await request(buyer, reportAction, 403, resolution);
        await request(admin, reportAction, 403, resolution, '');
        await request(admin, reportAction, 303, resolution);
        assert.match((await request(admin, '/admin/seller-reports?status=accepted', 200)).html, /Trust fixture/);
        const [[audit]] = await db.execute('SELECT action FROM admin_logs WHERE action_key=?', [resolution.request_key]);
        assert.equal(audit.action, 'seller_report_accepted');
        const [[reportedSeller]] = await db.execute('SELECT status FROM users WHERE id=?', [seller.id]);
        assert.equal(reportedSeller.status, 'active');
        assert.doesNotMatch((await request(seller, publicProfile, 200)).html, /Trust fixture/);

        let [[vehicles]] = await db.execute("SELECT id FROM categories WHERE slug='vehicles' AND is_active=1");
        if (!vehicles) {
            const [root] = await db.execute("INSERT INTO categories(slug,name) VALUES ('vehicles','Vehicles fixture')");
            attributeRoot = root.insertId;
            vehicles = { id: attributeRoot };
        }
        await db.execute('UPDATE categories SET parent_id=? WHERE id=?', [vehicles.id, category]);
        const [otherCategory] = await db.execute("INSERT INTO categories(slug,name) VALUES (?,'Other fixture')", [key + '-other']);
        attributeOther = otherCategory.insertId;
        const attrFields = { title: 'Structured fixture', description: 'Unstructured detail XYZ', price: '42',
            country_id: country, category_id: category, bargaining_enabled: '1', attributes_form: '1',
            attr_car_brand: 'Sample brand', attr_car_model: 'Sample model', attr_car_year: '2022',
            attr_car_mileage: '16000', attr_car_fuel: 'Гибрид', attr_car_gearbox: 'Автоматическая', attr_condition: 'Хорошее' };
        async function createWithAttributes(fields, status) {
            const body = new FormData();
            for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
            const response = await fetch(base + '/listings', { method: 'POST', headers: { cookie: seller.cookie, 'X-CSRF-Token': seller.token },
                body, redirect: 'manual' });
            assert.equal(response.status, status);
            return Number(response.headers.get('location')?.split('=')[1]);
        }
        await createWithAttributes({ ...attrFields, attr_car_year: '1700' }, 400);
        const structured = await createWithAttributes(attrFields, 302);
        const structuredPath = '/listings/' + structured;
        const savedAttributes = new URLSearchParams({ category_id: category, country_id: country, currency: 'EUR',
            sort: 'price_desc', attr_car_mileage_min: '16000', attr_car_mileage_max: '16000', attr_car_brand: 'Sample brand' });
        savedAttributes.append('attr_car_fuel', 'Гибрид');
        savedAttributes.append('attr_car_fuel', 'Бензин');
        const [[quotaFixture]] = await db.execute('SELECT CAST(id AS CHAR) AS id FROM saved_searches WHERE user_id=? ORDER BY id DESC LIMIT 1', [other.id]);
        await request(other, savedPath + '/' + quotaFixture.id, 303, { intent: 'delete' });
        await request(other, savedPath, 303, savedAttributes);
        await request(seller, savedPath, 303, savedAttributes);
        const [[structuredSaved]] = await db.execute('SELECT CAST(id AS CHAR) AS id,attribute_query FROM saved_searches WHERE user_id=? AND attribute_query IS NOT NULL', [other.id]);
        const structuredOpen = '/saved-searches/' + structuredSaved.id + '/open';
        const structuredUrl = new URL((await request(other, structuredOpen + '?edit=1', 302)).headers.get('location'), base);
        assert.equal(structuredUrl.searchParams.get('sort'), 'price_desc');
        assert.deepEqual(structuredUrl.searchParams.getAll('attr_car_fuel'), ['Бензин','Гибрид']);
        await request(buyer, structuredUrl.pathname + structuredUrl.search, 404);
        const editedCriteria = new URLSearchParams(savedAttributes);
        editedCriteria.set('saved_search_id', structuredSaved.id);
        editedCriteria.set('name', 'Structured saved');
        await request(other, savedPath, 303, editedCriteria);
        assert.match((await request(other, savedPath, 200)).html, /Пробег/);
        assert.equal((await db.execute('SELECT COUNT(*) AS total FROM listing_attributes WHERE listing_id=?', [structured]))[0][0].total, 7);
        assert.match((await request(seller, structuredPath + '/edit', 200)).html, /value="Sample brand"/);
        await request(seller, structuredPath + '/publish', 302, {});
        const approveStructured = async () => {
            const [[row]] = await db.execute('SELECT review_version FROM listings WHERE id=?', [structured]);
            await request(admin, '/admin/moderation/' + structured, 303, form(row.review_version, 'approve'));
        };
        await approveStructured();
        for (let batch = 0; batch < 30 && await jobs.processBatch(); batch++) {}
        assert.deepEqual((await savedNotices(structured)).map(row => row.user_id), [other.id]);
        assert.equal(await jobs.processBatch(), false);
        assert.equal((await savedNotices(structured)).length, 1);
        assert.deepEqual(cardIds((await request(other, structuredUrl.pathname + structuredUrl.search, 200)).html), [structured]);
        assert.equal(cardIds((await request(other, '/recommendations?country=DE', 200)).html)[0], structured);
        await db.execute("UPDATE saved_searches SET attribute_query='attr_removed=1' WHERE id=?", [structuredSaved.id]);
        assert.match((await request(other, savedPath, 200)).html, /Условия устарели/);
        const staleUrl = (await request(other, structuredOpen, 302)).headers.get('location');
        await request(other, staleUrl, 400);
        await db.execute('UPDATE saved_searches SET attribute_query=? WHERE id=?', [structuredSaved.attribute_query, structuredSaved.id]);
        const structuredCanonical = (await request(buyer, structuredPath, 301)).headers.get('location');
        assert.match((await request(buyer, structuredCanonical, 200)).html, /16000 км/);
        const combined = new URLSearchParams({ category_id: category, country_id: country, currency: 'EUR', min_price: '40',
            attr_car_mileage_min: '14000', attr_car_mileage_max: '17000', attr_car_brand: 'Sample brand', sort: 'price_desc' });
        combined.append('attr_car_fuel', 'Бензин');
        combined.append('attr_car_fuel', 'Гибрид');
        assert.deepEqual(cardIds((await request(buyer, '/search?' + combined, 200)).html), [structured]);
        assert.deepEqual(cardIds((await request(buyer, '/category/vehicles?' + combined, 200)).html), [structured]);
        await request(buyer, '/search?' + combined + '&attr_car_year_min=2100&attr_car_year_max=2025', 400);
        const [[foreignField]] = await db.execute("SELECT COUNT(*) AS total FROM listing_attributes WHERE listing_id=? AND field_key='device_brand'", [structured]);
        assert.equal(foreignField.total, 0);
        const compareStructured = (await request(buyer, '/compare?ids=' + structured + ',' + cheap, 200)).html;
        assert.match(compareStructured, /Sample brand/);
        assert.doesNotMatch(compareStructured, /Unstructured detail XYZ/);
        const matchingIds = [];
        for (let index = 0; index < 20; index++) matchingIds.push(await listing('Attribute batch ' + index, 'active'));
        await db.query("INSERT INTO listing_attributes(listing_id,field_key,text_value) VALUES ?", [
            matchingIds.map(id => [id, 'car_brand', 'Sample brand'])
        ]);
        const similarStructured = (await request(buyer, structuredCanonical, 200)).html.match(/aria-labelledby="similar-title"[\s\S]*?<\/section>/)[0];
        assert.equal(cardIds(similarStructured).length, 4);
        assert.ok(cardIds(similarStructured).every(id => matchingIds.includes(id)));
        const pagedAttributes = '/search?category_id=' + category + '&attr_car_brand=Sample+brand&sort=oldest';
        const attributeFirst = (await request(buyer, pagedAttributes, 200)).html;
        assert.equal(cardIds(attributeFirst).length, 20);
        assert.match(attributeFirst, /attr_car_brand=Sample\+brand&amp;page=2|attr_car_brand=Sample\+brand&amp;sort=oldest&amp;page=2/);
        const attributeSecond = cardIds((await request(buyer, pagedAttributes + '&page=2', 200)).html);
        assert.equal(attributeSecond.length, 1);
        assert.ok(!cardIds(attributeFirst).includes(attributeSecond[0]));
        const conditionFilter = '/search?category_id=' + category + '&attr_condition=good&search=Structured+fixture';
        assert.deepEqual(cardIds((await request(buyer, conditionFilter, 200)).html), [structured]);
        assert.equal((await db.execute("SELECT text_value FROM listing_attributes WHERE listing_id=? AND field_key='condition'", [structured]))[0][0].text_value, 'good');
        await db.execute("UPDATE listing_attributes SET text_value='Хорошее' WHERE listing_id=? AND field_key='condition'", [structured]);
        assert.deepEqual(cardIds((await request(buyer, conditionFilter, 200)).html), [structured]);
        assert.match((await request(seller, structuredPath + '/edit', 200)).html, /value="good" selected/);
        await request(seller, structuredPath + '/edit', 400, { ...attrFields, attr_condition: 'Произвольное значение' });
        await request(seller, structuredPath + '/edit', 302, { ...attrFields, attr_car_mileage: '16100' });
        await request(buyer, structuredCanonical, 404);
        assert.doesNotMatch((await request(buyer, '/compare?ids=' + structured, 200)).html, /16100|Sample brand/);
        await approveStructured();
        assert.match((await request(buyer, structuredCanonical, 200)).html, /16100 км/);
        await request(seller, structuredPath + '/edit', 302, { ...attrFields, category_id: attributeOther, attr_condition: '', attr_device_brand: 'Ignored' });
        assert.equal((await db.execute('SELECT COUNT(*) AS total FROM listing_attributes WHERE listing_id=?', [structured]))[0][0].total, 0);
        await approveStructured();
        assert.match((await request(buyer, '/compare?ids=' + structured + ',' + cheap, 200)).html, /Товары из разных категорий/);
        await db.execute("UPDATE listings SET item_condition='Редкое старое состояние' WHERE id=?", [structured]);
        assert.match((await request(seller, structuredPath + '/edit', 200)).html, /Прежнее значение: «Редкое старое состояние»/);
        const replacement = { ...attrFields, category_id: attributeOther, attr_condition: 'parts' };
        await request(seller, structuredPath + '/edit', 302, replacement);
        await approveStructured();
        const renewedCondition = (await request(buyer, '/compare?ids=' + structured, 200)).html;
        assert.match(renewedCondition, /На запчасти \/ неисправное/);
        assert.doesNotMatch(renewedCondition, /Редкое старое состояние/);

        const lifecycle = require('../models/listingLifecycle.model');
        const lifecyclePath = '/my-listings/lifecycle';
        const seasonal = await listing('Lifecycle fixture', 'draft');
        const seasonalPath = '/listings/' + seasonal;
        const state = async () => (await db.execute(
            'SELECT status,published_at,expires_at,bumped_at,created_at,review_version FROM listings WHERE id=?', [seasonal]))[0][0];
        const approveSeasonal = async () => request(admin, '/admin/moderation/' + seasonal, 303, form((await state()).review_version,'approve'));
        const action = (name, id = seasonal) => ({ action: name, ids: id, request_key: crypto.randomUUID() });
        assert.equal((await state()).published_at, null);
        await request(seller, seasonalPath + '/publish', 302, {});
        await approveSeasonal();
        const published = await state();
        assert.equal((published.expires_at - published.published_at) / 86400000, 30);
        await request(seller, seasonalPath + '/edit', 302, edit('Lifecycle revised'));
        await approveSeasonal();
        assert.deepEqual((await state()).expires_at, published.expires_at);
        await request(seller, lifecyclePath, 403, action('renew'), '');
        await request(buyer, lifecyclePath, 303, action('renew'));
        assert.deepEqual((await state()).expires_at, published.expires_at);
        const renew = action('renew');
        await Promise.all([request(seller, lifecyclePath, 303, renew), request(seller, lifecyclePath, 303, renew)]);
        const renewed = await state();
        assert.equal((renewed.expires_at - published.expires_at) / 86400000, 30);
        await request(seller, lifecyclePath, 303, action('renew'));
        assert.deepEqual((await state()).expires_at, renewed.expires_at);
        await request(seller, lifecyclePath, 409, { ...renew, action: 'bump' });
        await Promise.all([request(seller, lifecyclePath, 303, action('bump')), request(seller, lifecyclePath, 303, action('bump'))]);
        const bumped = await state();
        assert.ok(bumped.bumped_at);
        assert.deepEqual(bumped.created_at, published.created_at);
        await request(seller, lifecyclePath, 303, action('bump'));
        assert.deepEqual((await state()).bumped_at, bumped.bumped_at);
        assert.equal(cardIds((await request(buyer, '/search?category_id=' + category + '&sort=newest', 200)).html)[0], seasonal);
        await db.execute('UPDATE listings SET expires_at=UTC_TIMESTAMP(3)+INTERVAL 3 DAY WHERE id=?', [seasonal]);
        await lifecycle.processBatch();
        await lifecycle.processBatch();
        const [[warning]] = await db.execute(
            'SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND event_key LIKE ?', [seller.id, 'listing-expiry:' + seasonal + ':%']);
        assert.equal(warning.total, 1);
        await db.execute('UPDATE listings SET expires_at=UTC_TIMESTAMP(3) WHERE id=?', [seasonal]);
        await request(buyer, seasonalPath, 404);
        assert.ok(!cardIds((await request(buyer, '/search?category_id=' + category, 200)).html).includes(seasonal));
        await lifecycle.processBatch();
        assert.equal((await state()).status, 'archived');
        await request(seller, lifecyclePath, 303, action('renew'));
        assert.equal((await state()).status, 'active');
        const mixedArchive = new URLSearchParams({ action: 'archive', request_key: crypto.randomUUID() });
        mixedArchive.append('ids', seasonal);
        mixedArchive.append('ids', 4294967295);
        await request(seller, lifecyclePath, 303, mixedArchive);
        assert.equal((await state()).status, 'archived');
        await request(seller, lifecyclePath, 303, mixedArchive);
        await request(seller, lifecyclePath, 303, action('restore'));
        assert.equal((await state()).status, 'pending_review');
        await approveSeasonal();
        assert.equal((await state()).status, 'active');

        const [[existingServices]] = await db.query("SELECT id FROM categories WHERE slug='services'");
        if (!existingServices) {
            [ { insertId: serviceRoot } ] = await db.query("INSERT INTO categories(slug,name) VALUES ('services','Services')");
        }
        const [[originalCategory]] = await db.execute('SELECT parent_id FROM categories WHERE id=?', [category]);
        [ { insertId: serviceBranch } ] = await db.execute('INSERT INTO categories(slug,name,parent_id) VALUES (?,?,?)',
            [key + '-services', 'Service branch', existingServices?.id || serviceRoot]);
        await db.execute('UPDATE categories SET parent_id=? WHERE id=?', [serviceBranch, category]);
        const service = await listing('Nested service item', 'active');
        await db.execute('UPDATE listings SET bargaining_enabled=1 WHERE id=?', [service]);
        await db.execute('UPDATE users SET phone_public=0 WHERE id=?', [seller.id]);
        const servicePath = (await request(buyer, '/listings/' + service, 301)).headers.get('location');
        const serviceHtml = (await request(buyer, servicePath, 200)).html;
        const navs = html => (html.match(/class="[^"]*site-breadcrumbs(?=[ "])/g) || []).length;
        assert.equal(navs(serviceHtml), 1);
        assert.equal((serviceHtml.match(/"@type":"BreadcrumbList"/g) || []).length, 1);
        assert.match(serviceHtml, /\/category\/services[\s\S]*Service branch[\s\S]*Account test[\s\S]*Nested service item/);
        assert.match(serviceHtml, /Написать исполнителю/);
        assert.doesNotMatch(serviceHtml, /Запросить покупку|data-open-price-offer|Показать телефон/);
        await start(serviceBuyer, service, 409);
        await request(serviceBuyer, '/offers', 409, { ...offerData, listing_id: service, listing_version: '0', request_key: crypto.randomUUID() });
        const [[serviceWrites]] = await db.execute(`SELECT (SELECT COUNT(*) FROM deals WHERE listing_id=?) AS deals,
            (SELECT COUNT(*) FROM price_negotiations WHERE listing_id=?) AS offers`, [service, service]);
        assert.deepEqual([Number(serviceWrites.deals), Number(serviceWrites.offers)], [0, 0]);
        await request(buyer, '/messages/start', 303, { listing_id: service });
        await db.execute('UPDATE users SET phone_public=1 WHERE id=?', [seller.id]);
        assert.match((await request(buyer, servicePath, 200)).html, /Показать телефон/);
        const categoryHtml = (await request(buyer, '/category/' + key, 200)).html;
        assert.equal(navs(categoryHtml), 1);
        assert.match(categoryHtml, /\/category\/services[\s\S]*Service branch/);
        await db.execute('UPDATE categories SET is_active=0 WHERE id=?', [serviceBranch]);
        const categoryWithoutBranch = (await request(buyer, '/category/' + key, 200)).html;
        assert.match(categoryWithoutBranch, /href="\/category\/services"/);
        assert.doesNotMatch(categoryWithoutBranch, /Service branch/);
        await start(serviceBuyer, service, 409);
        assert.equal(navs((await request(buyer, '/', 200)).html), 0);
        const profileHtml = (await request(buyer, '/profile?edit=1', 200)).html;
        assert.equal(navs(profileHtml), 1);
        assert.match(profileHtml, /href="\/profile"[\s\S]*Редактирование профиля/);
        assert.doesNotMatch(profileHtml, /"@type":"BreadcrumbList"/);
        await db.execute('UPDATE categories SET parent_id=? WHERE id=?', [originalCategory.parent_id, category]);

        const lockedCandidate = await listing('Locked pre-moderation item','draft');
        await request(seller,'/listings/' + lockedCandidate + '/publish',302,{});
        const [[lockedVersion]] = await db.execute('SELECT review_version FROM listings WHERE id=?',[lockedCandidate]);
        await request(admin,'/admin/listings/' + lockedCandidate,303,{mode:'block',reason:'Test',request_key:crypto.randomUUID()});
        await request(admin,'/admin/moderation/' + lockedCandidate,409,form(lockedVersion.review_version,'approve'));
        await request(seller,'/listings/' + lockedCandidate + '/publish',404,{});
        const blockedCandidate = await listing('Blocked seller candidate','draft');
        await request(seller,'/listings/' + blockedCandidate + '/publish',302,{});
        const [[blockedVersion]] = await db.execute('SELECT review_version FROM listings WHERE id=?',[blockedCandidate]);
        await request(admin,'/admin/users/' + seller.id,303,{status:'blocked',reason:'Test',request_key:crypto.randomUUID()});
        await request(admin,'/admin/moderation/' + blockedCandidate,409,form(blockedVersion.review_version,'approve'));
        await request(admin,decisionPath,409,form((await currentReview()).review_version,'approve'));
        await request({},candidatePath,404);
        await request({}, publicProfile, 404);
        assert.doesNotMatch((await request(buyer, '/following', 200)).html, />New profile name<\/a>/);
        assert.match((await request(buyer, feedPath, 200)).html, /Найдите интересных продавцов/);
        for (let i = 0; i < 21; i++) await listing('Queue pagination ' + i, 'pending_review');
        const queuePath = '/admin/moderation?country=' + country + '&category=' + category;
        const pageOne = (await request(admin,queuePath,200)).html;
        const pageTwo = (await request(admin,queuePath + '&page=2',200)).html;
        assert.equal((pageOne.match(/data-moderation-listing=/g) || []).length,20);
        assert.equal((pageTwo.match(/data-moderation-listing=/g) || []).length,1);
        assert.match(pageOne,/data-admin-count="moderation"[^>]*>[1-9]\d*</);
        console.log('Pre-moderation checks passed: status transitions, stale review, concurrency, visibility, notifications and reservation.');
        console.log('SEO checks passed: metadata, breadcrumbs, redirects, XML, robots, noindex, pagination, JSON-LD and CSP header.');
        console.log('Account and review checks passed: purchases, CSRF, parallel creation, edit deadline, rating, escaped output, moderation, reports, notice and roles.');
        console.log('Deal details checks passed: roles, conversation, price snapshot, private images, event history, old links, CSRF and rollback.');
        console.log('Dispute checks passed: private evidence, concurrency, CSRF, workflow, transaction rollback, notifications, and audit.');
        console.log('Public seller profiles passed: published cards, rating, pagination, sort, favorites, blocked users, privacy, and SEO.');
        console.log('Seller follows passed: CSRF, guest/self/blocked checks, AJAX state, moderation, opt-out, worker concurrency, and rollback.');
        console.log('Following feed passed: country, pagination, currency sorting, seller links, favorites, privacy, and no notification writes.');
        console.log('Saved searches passed: filters, ownership, auth carry-over, quota, concurrent saves, matching and seller jobs.');
        console.log('Recently viewed passed: public-only views, CSRF, isolation, opt-out, favorites, concurrent 100-item cap and pagination.');
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
        if (category) {
            if (savedChild) {
                await db.execute('DELETE FROM listings WHERE category_id=?', [savedChild]);
                await db.execute('DELETE FROM categories WHERE id=?', [savedChild]);
            }
            for (const table of ['deal_dispute_images', 'deal_dispute_entries']) {
                await db.execute(`DELETE child FROM ${table} child JOIN deal_disputes s ON s.id=child.dispute_id
                    JOIN deals d ON d.id=s.deal_id JOIN listings l ON l.id=d.listing_id WHERE l.category_id=?`, [category]);
            }
            await db.execute(`DELETE s FROM deal_disputes s JOIN deals d ON d.id=s.deal_id
                JOIN listings l ON l.id=d.listing_id WHERE l.category_id=?`, [category]);
            await db.execute(`DELETE p FROM review_reports p JOIN deals d ON d.id=p.deal_id
                JOIN listings l ON l.id=d.listing_id WHERE l.category_id=?`,[category]);
            await db.execute(`DELETE r FROM reviews r JOIN deals d ON d.id=r.deal_id
                JOIN listings l ON l.id=d.listing_id WHERE l.category_id=?`,[category]);
            await db.execute('DELETE FROM deals WHERE listing_id IN (SELECT id FROM listings WHERE category_id=?)',[category]);
            await db.execute('DELETE FROM listings WHERE category_id=?',[category]);
            await db.execute('DELETE FROM categories WHERE id=?',[category]);
        }
        if (attributeOther) {
            await db.execute('DELETE FROM listings WHERE category_id=?', [attributeOther]);
            await db.execute('DELETE FROM categories WHERE id=?', [attributeOther]);
        }
        if (attributeRoot) await db.execute('DELETE FROM categories WHERE id=?', [attributeRoot]);
        if (serviceBranch) await db.execute('DELETE FROM categories WHERE id=?', [serviceBranch]);
        if (serviceRoot) await db.execute('DELETE FROM categories WHERE id=?', [serviceRoot]);
        for (const { id } of users) {
            await db.execute('DELETE FROM admin_logs WHERE admin_id=?',[id]);
            await db.execute('DELETE FROM users WHERE id=?',[id]);
        }
        if (subscriberFixture) await db.execute('DELETE FROM users WHERE email LIKE ?', [subscriberFixture]);
        if (savedCity) await db.execute('DELETE FROM cities WHERE id=?', [savedCity]);
        if (createdCountry) await db.execute('DELETE FROM countries WHERE id=?',[country]);
        if (createdFeedCountry) await db.execute('DELETE FROM countries WHERE id=?',[createdFeedCountry]);
        await db.end();
    }
}
verifyTestEnvironment().then(run).catch(error => { console.error(error.code || error.name, error.message, error.stack?.split('\n').find(line => line.includes('account.integration.js'))); process.exitCode = 1; });
