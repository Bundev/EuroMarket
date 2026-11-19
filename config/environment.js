const { isIP } = require('node:net');
const { publicOrigin } = require('../services/seo');

function readEnvironment(env = process.env) {
    const mode = env.NODE_ENV || 'development';
    const production = mode === 'production';
    const missing = ['DB_HOST', 'DB_USER', 'DB_NAME', 'SESSION_SECRET'].filter(key => !env[key]?.trim());
    const invalid = [];
    const port = Number(env.PORT || 3000);
    const dbPort = Number(env.DB_PORT || 3306);
    const host = env.BIND_HOST || '127.0.0.1';
    if (!['development', 'test', 'production'].includes(mode)) invalid.push('NODE_ENV');
    if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push('PORT');
    if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) invalid.push('DB_PORT');
    if (!isIP(host)) invalid.push('BIND_HOST');
    if (env.SESSION_SECRET && (Buffer.byteLength(env.SESSION_SECRET) < 32 ||
        (production && (new Set(env.SESSION_SECRET).size < 12 || /^(change|replace|example|your|test|dev|secret)/i.test(env.SESSION_SECRET))))) {
        invalid.push('SESSION_SECRET');
    }
    const rateStore = env.AUTH_RATE_STORE || 'memory';
    if (!['memory', 'mariadb'].includes(rateStore) || (production && rateStore !== 'mariadb')) invalid.push('AUTH_RATE_STORE');
    const csp = env.CSP_MODE || (production ? 'report-only' : 'off');
    if (!['off', 'report-only', 'enforce'].includes(csp) || (production && csp === 'off')) invalid.push('CSP_MODE');
    if (production && !env.DB_PASSWORD?.trim()) missing.push('DB_PASSWORD');
    if (production && !env.TRUSTED_PROXIES?.trim()) missing.push('TRUSTED_PROXIES');
    if (production && env.DEBUG) invalid.push('DEBUG');
    if (production && env.NODE_DEBUG) invalid.push('NODE_DEBUG');
    let origin;
    try { origin = publicOrigin(env.PUBLIC_ORIGIN, production, port); }
    catch { invalid.push('PUBLIC_ORIGIN'); }
    if (missing.length || invalid.length) {
        const error = new Error([...new Set([...missing, ...invalid])].join(', '));
        error.code = 'INVALID_ENVIRONMENT';
        throw error;
    }
    return { production, port, host, csp, rateStore, publicOrigin: origin };
}

module.exports = readEnvironment;
