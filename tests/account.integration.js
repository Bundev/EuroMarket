require('dotenv').config({ quiet: true });
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
    let server, category, country, createdCountry, createdFeedCountry, subscriberFixture, savedChild, savedCity;
    try {
        assert.equal((await db.query('SELECT DATABASE() AS name'))[0][0].name, 'euromarket_test');
        const applyMigrations = require('./apply-migrations');
        const migrations = ['011_deal_notifications.sql', '012_deal_events.sql', '013_deal_disputes.sql', '014_seller_follows.sql', '015_saved_searches.sql', '016_recently_viewed.sql'];
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
        for (const role of ['user','user','user','admin']) {
            const index = users.length;
            const [row] = await db.execute("INSERT INTO users(name,email,password_hash,role) VALUES (?,?, 'test-only',?)",
                ['Account ' + index, key + '-' + index + '@example.invalid', role]);
            users.push({ id: row.insertId });
        }
        const [seller,buyer,other,admin] = users;
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
        for (const route of ['home','search','savedSearch','auth','profile','follow','listing','recentlyViewed','deal','dispute','review','message','favorite','notification','admin']) {
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
        assert.match(queue, /data-open-disputes>[1-9]\d*</);
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
        const attempts = await Promise.all([
            saveReview(winner, accepted.id, undefined, { comment: marker }),
            saveReview(winner, accepted.id, undefined, { comment: marker })
        ]);
        assert.deepEqual(attempts.map(result => result.status).sort(), [303,409]);
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
        await request(stranger, adminUrl, 403, { mode:'hide', reason:'Test', request_key:crypto.randomUUID() });
        assert.match((await request(admin,'/admin/reviews',200)).html,/Жалобы \(открытых: 1\)/);
        assert.match((await request(admin,adminUrl + '/reports',200)).html,/Requires moderator review/);
        await request(admin, adminUrl, 403, { mode:'hide', reason:'Test', request_key:crypto.randomUUID() }, '');
        const moderation = mode => request(admin, adminUrl, 303, { mode, reason:'Test', request_key:crypto.randomUUID() });
        await moderation('hide');
        const afterHide = (await request({},sellerReviews,200)).html;
        assert.match(afterHide,/1 \/ 5 · отзывов: 1/);
        assert.match((await request({}, publicProfile, 200)).html, /1 \/ 5 · отзывов: 1/);
        assert.doesNotMatch(afterHide,/&lt;em&gt;/);
        assert.match((await request(winner,'/my-purchases',200)).html,/Отзыв скрыт модератором/);
        assert.match((await request(admin,adminUrl + '/reports',200)).html,/Закрыта/);
        assert.equal((await db.execute("SELECT COUNT(*) AS total FROM admin_logs WHERE action='review_hide' AND admin_id=? AND target_id=?",
            [admin.id, accepted.id]))[0][0].total,1);
        await moderation('restore');
        assert.match((await request({},sellerReviews,200)).html,/2,5 \/ 5 · отзывов: 2/);
        await request(stranger, reportUrl, 303, { reason:'Another complaint' });
        await moderation('dismiss');
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
            await db.execute('INSERT INTO reviews (deal_id,rating,comment) VALUES (?,5,?)', [deal.insertId, 'Pagination review ' + i]);
        }
        const reviewPageOne = (await request({},sellerReviews,200)).html;
        const reviewPageTwo = (await request({},sellerReviews + '?page=2',200)).html;
        assert.equal((reviewPageOne.match(/<article class="card card-body mb-3">/g) || []).length, 20);
        assert.equal((reviewPageTwo.match(/<article class="card card-body mb-3">/g) || []).length, 2);
        assert.match(reviewPageTwo,/Страница 2 из 2/);
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
        await start(buyer,candidate,303);
        await recordView(buyer, candidate);
        assert.ok((await historyIds(buyer)).includes(candidate));
        await request(seller,candidatePath + '/edit',302,edit('Private pending edit'));
        assert.equal((await currentReview()).status,'pending_review');
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
            request(buyer, savedPath, 303, { ...savedFilters, sort: 'newest', page: '1' })]);
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
        assert.ok(!opened.searchParams.has('sort') && !opened.searchParams.has('page'));
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
        assert.deepEqual(deliveredSaved.map(item => item.user_id).sort(), [seller.id, buyer.id].sort());
        assert.equal(deliveredSaved[0].link, '/listings/' + savedListing);
        assert.match(deliveredSaved[0].text, /Saved match in a child category.*25\.00 EUR/);
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
        const paginatedHistory = [];
        for (let page = 1; page <= 5; page++) {
            const cards = cardIds((await request(buyer, historyPath + '?page=' + page, 200)).html);
            assert.equal(cards.length, 20);
            paginatedHistory.push(...cards);
        }
        assert.deepEqual(paginatedHistory, moved);
        await recordView(other, cheap);
        await request(buyer, historyPath + '/clear', 303, { user_id: other.id });
        assert.deepEqual(await historyIds(buyer), []);
        assert.deepEqual(await historyIds(other), [cheap]);
        assert.match((await request(buyer, historyPath, 200)).html, /История просмотров пока пуста/);

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
        assert.match(pageOne,/aria-label="На проверке">/);
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
run().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
