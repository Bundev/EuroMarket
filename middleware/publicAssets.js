const express = require('express');
const path = require('node:path');
const router = express.Router();

// Never mount all of public: legacy uploads must not bypass the image handler,
// including with encoded slashes/backslashes on Windows.
for (const directory of ['css', 'js', 'images']) {
    router.use('/' + directory, express.static(path.resolve(__dirname, '../public', directory), {
        dotfiles: 'deny', index: false, redirect: false
    }));
}
module.exports = router;
