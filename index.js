'use strict';

require('dotenv').config({ quiet: true, debug: false });
const { once } = require('node:events');
const readEnvironment = require('./config/environment');
const logError = require('./services/logError');

async function start() {
    const settings = readEnvironment();
    const trustedProxies = require('./config/trustedProxy');
    const db = require('./config/db');
    let sessionMiddleware, server;

    try {
        // In production these tables must already exist. The server never runs migrations.
        if (settings.production) {
            await db.query('SELECT session_id, expires, data FROM sessions LIMIT 0');
            await db.query('SELECT key_hash, state_json, expires_at FROM auth_rate_limits LIMIT 0');
            await db.query('SELECT id, reserved_listing_id, purchase_request_key FROM deals LIMIT 0');
            await db.query('SELECT deal_id, event_type, occurred_at FROM deal_events LIMIT 0');
            await db.query('SELECT id, open_deal_id, version FROM deal_disputes LIMIT 0');
            await db.query('SELECT dispute_id, action FROM deal_dispute_entries LIMIT 0');
            await db.query('SELECT dispute_id, position, image_data FROM deal_dispute_images LIMIT 0');
            await db.query('SELECT deal_id, rating, hidden_at FROM reviews LIMIT 0');
            await db.query('SELECT deal_id, resolved_at FROM review_reports LIMIT 0');
            await db.query('SELECT review_version, review_submitted_at, review_reason FROM listings LIMIT 0');
            await db.query('SELECT notify_followed_sellers FROM users LIMIT 0');
            await db.query('SELECT save_listing_history FROM users LIMIT 0');
            await db.query('SELECT id, user_id, listing_id FROM recently_viewed LIMIT 0');
            await db.query('SELECT subscription_announcement_pending FROM listings LIMIT 0');
            await db.query('SELECT id, seller_id, follower_id FROM seller_follows LIMIT 0');
            await db.query('SELECT id, user_id, criteria_key, notify FROM saved_searches LIMIT 0');
            await db.query('SELECT listing_id, review_version, last_follow_id, max_follow_id, last_search_id, max_search_id, finished_at FROM seller_publication_jobs LIMIT 0');
            const [[notificationType]] = await db.query(
                "SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='notifications' AND COLUMN_NAME='type'"
            );
            if (!["'review'", "'deal'"].every(type => notificationType?.type.includes(type))) {
                throw Object.assign(new Error('Notification migrations required'), { code: 'ERR_MIGRATION_REQUIRED' });
            }
        }
        sessionMiddleware = require('./config/session');
        await sessionMiddleware.store.onReady();
        const app = require('./config/app')({ settings, trustedProxies, sessionMiddleware });
        server = app.listen(settings.port, settings.host);
        await once(server, 'listening');
    } catch (error) {
        await Promise.allSettled([sessionMiddleware?.store.close(), db.end()]);
        throw error;
    }

    console.log('EuroMarket принимает соединения на порту ' + settings.port);
    const stopPublications = require('./services/publicationWorker').start();

    let stopping = false;
    async function shutdown(signal, exitCode = 0) {
        if (stopping) return;
        stopping = true;
        console.log('Остановка EuroMarket (' + signal + ')');
        const deadline = setTimeout(() => {
            logError('Истекло время остановки EuroMarket');
            server.closeAllConnections();
            process.exit(1);
        }, 15000);
        deadline.unref();
        await Promise.all([new Promise(resolve => server.close(resolve)), stopPublications()]);
        const closed = await Promise.allSettled([sessionMiddleware.store.close(), db.end()]);
        clearTimeout(deadline);
        if (closed.some(result => result.status === 'rejected')) {
            logError('Ошибка закрытия соединений EuroMarket');
            process.exitCode = 1;
        } else {
            process.exitCode = exitCode;
        }
        if (process.connected) process.disconnect();
    }

    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    server.on('error', error => {
        logError('Ошибка HTTP-сервера', error);
        void shutdown('HTTP', 1);
    });
    // Windows services can forward shutdown over IPC when hosted by a Node supervisor.
    if (process.send) {
        process.on('message', message => { if (message === 'shutdown') void shutdown('IPC'); });
        process.once('disconnect', () => { void shutdown('IPC disconnect'); });
    }
}

start().catch(error => {
    if (error.code === 'INVALID_ENVIRONMENT') console.error('Проверьте переменные окружения: ' + error.message);
    else logError('Не удалось запустить EuroMarket', error);
    process.exitCode = 1;
});
