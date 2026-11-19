const crypto = require('node:crypto');
const types = new Set(['success', 'error', 'warning', 'info']);

function message(type, text) {
    return { id: crypto.randomUUID(), type: types.has(type) ? type : 'info', message: String(text).slice(0, 600) };
}
function flash(req, type, text) {
    if (!req.session) return;
    req.session.flashToasts = [...(req.session.flashToasts || []), message(type, text)].slice(-6);
}
function browserRequest(req) {
    return !req.path.startsWith('/api/') && !req.is('application/json') && !req.get('Accept')?.includes('application/json');
}
function backUrl(req) {
    if (/^\/(login|register)/.test(req.path)) return req.path.startsWith('/register') ? '/register' : '/login';
    if (['/profile', '/profile/phone', '/profile/viewing-history'].includes(req.path)) return '/profile';
    if (req.path.startsWith('/recently-viewed')) return '/recently-viewed';
    if (req.path === '/following/settings') return '/following';
    if (req.path.startsWith('/saved-searches')) return '/saved-searches';
    const offer = /^\/offers(?:\/([1-9]\d{0,9})(?:\/(?:reply|checkout))?)?$/.exec(req.path);
    if (offer) return offer[1] ? '/offers/' + offer[1] : '/offers';
    if (/^\/deals\/[1-9]\d{0,9}$/.test(req.path)) return req.path;
    const dispute = /^\/((?:deals|disputes)\/[1-9]\d{0,9})\/(?:disputes|reply)$/.exec(req.path);
    if (dispute) return '/' + dispute[1];
    const adminDispute = /^\/admin\/disputes\/([1-9]\d{0,9})$/.exec(req.path);
    if (adminDispute) return '/disputes/' + adminDispute[1];
    if (req.path.startsWith('/my-purchases')) return '/my-purchases';
    if (req.path.startsWith('/admin/reviews')) return '/admin/reviews';
    if (req.path.startsWith('/admin/moderation')) return '/admin/moderation';
    if (/^\/admin\//.test(req.path)) return '/admin';
    const listing = /^\/listings\/([1-9]\d*)/.exec(req.path);
    if (listing && req.path.endsWith('/purchase')) return '/listings/' + listing[1];
    if (listing && /\/(?:publish|unpublish|sold)$/.test(req.path)) return '/my-listings';
    if (listing) return '/listings/' + listing[1] + '/edit';
    return req.path === '/listings' ? '/listings/create' : '/';
}

module.exports = function toasts(req, res, next) {
    if (res.locals.toastMiddleware) return next();
    res.locals.toastMiddleware = true;
    const render = res.render.bind(res), send = res.send.bind(res);
    res.locals.toasts = [];
    res.render = (view, options = {}, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        // Polling/API calls do not consume flash. Consume only when rendering HTML.
        const pending = req.session?.flashToasts || [];
        if (pending.length) {
            delete req.session.flashToasts;
            res.set('Cache-Control', 'no-store');
        }
        const provided = options.toasts || [];
        res.locals.toasts = [...pending, ...provided].slice(-6);
        res.locals.toastRendering = true;
        return render(view, { ...options, toasts: res.locals.toasts }, callback);
    };
    res.send = body => {
        if (res.statusCode >= 400 && typeof body === 'string' && req.get('Accept') === 'application/json' && !res.get('Content-Type')) {
            return res.status(res.statusCode).json({ error: body });
        }
        if (res.statusCode >= 400 && typeof body === 'string' && browserRequest(req) && !res.locals.toastErrorPage && !res.locals.toastRendering) {
            let text = body;
            if (res.get('Content-Type')?.includes('application/json')) {
                try { const result = JSON.parse(body); if (typeof result.error !== 'string') return send(body); text = result.error; }
                catch { return send(body); }
            }
            res.locals.toastErrorPage = true;
            res.removeHeader('Content-Type');
            const notice = message(res.statusCode === 429 ? 'warning' : 'error', text);
            return res.render('pages/action-result', { toasts: [notice], backUrl: backUrl(req) });
        }
        return send(body);
    };
    next();
};
module.exports.flash = flash;
module.exports.browserRequest = browserRequest;
