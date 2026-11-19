require('dotenv').config({ quiet: true });
const db = require('../config/db');
require('../services/listingImages').reconcile()
    .then(() => console.log('Image reconciliation completed.'))
    .catch(error => { console.error('Image reconciliation failed:', error.code || error.name); process.exitCode = 1; })
    .finally(() => db.end());
