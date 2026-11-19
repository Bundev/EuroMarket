const { processBatch } = require('../models/publicationJob.model');
const logError = require('./logError');

function start() {
    let stopped = false;
    let timer;
    let active;
    function schedule(delay) {
        if (stopped) return;
        timer = setTimeout(() => {
            active = processBatch().then(work => schedule(work ? 250 : 2000), error => {
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
