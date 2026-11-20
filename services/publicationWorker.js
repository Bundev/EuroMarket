const { processBatch } = require('../models/publicationJob.model');
const logError = require('./logError');
const lifecycle = require('../models/listingLifecycle.model');

function start() {
    let stopped = false;
    let timer;
    let active;
    let nextLifecycle = 0;
    async function run() {
        if (Date.now() >= nextLifecycle) {
            nextLifecycle = Date.now() + 60000;
            try { await lifecycle.processBatch(); }
            catch (error) { logError('Ошибка обработки сроков объявлений:', error); }
        }
        return processBatch();
    }
    function schedule(delay) {
        if (stopped) return;
        timer = setTimeout(() => {
            active = run().then(work => schedule(work ? 250 : 2000), error => {
                logError('Ошибка очереди публикаций:', error);
                schedule(5000);
            });
        }, delay);
        timer.unref();
    }
    schedule(0);
    return async () => {
        stopped = true;
        clearTimeout(timer);
        await active;
    };
}

module.exports = { start };
