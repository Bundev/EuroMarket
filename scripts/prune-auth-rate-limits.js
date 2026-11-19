require('dotenv').config({ quiet: true });
const db = require('../config/db');
const { MariaDbStore } = require('../services/authRateStore');
new MariaDbStore(db).prune()
    .then(() => console.log('Expired authentication rate limits pruned (up to 1000 rows).'))
    .catch(error => { console.error('Rate cleanup failed:', error.code || error.name); process.exitCode = 1; })
    .finally(() => db.end());
