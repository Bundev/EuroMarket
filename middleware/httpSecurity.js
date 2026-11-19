const policy = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://cdn.jsdelivr.net/npm/tom-select@2.4.3/dist/js/tom-select.complete.min.js",
    "script-src-attr 'none'",
    "style-src 'self' https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css https://cdn.jsdelivr.net/npm/tom-select@2.4.3/dist/css/tom-select.bootstrap5.min.css",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'"
].join('; ');

module.exports = function httpSecurity({ production, csp }) {
    return (req, res, next) => {
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'same-origin'
        });
        if (csp !== 'off') res.set(csp === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', policy);
        if (production) {
            if (!req.secure) return res.status(400).type('text').send('Используйте HTTPS.');
            res.set('Strict-Transport-Security', 'max-age=31536000');
        }
        next();
    };
};
