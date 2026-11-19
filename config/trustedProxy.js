const { isIP } = require('node:net');

// Empty by default. Never trust arbitrary forwarding headers or a hop count.
const entries = (process.env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
        throw new Error('Invalid TRUSTED_PROXIES configuration');
    }
}
module.exports = entries.length ? entries : false;
