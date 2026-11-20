const { URL } = require('node:url');

// Language and market are independent. Only Russian currently has UI content.
const russian = Object.freeze({ language: 'ru', socialLocale: 'ru_RU' });

function publicOrigin(value, production, port = 3000) {
    if (!value && !production) return 'http://localhost:' + port;
    const url = new URL(value || '');
    if ((production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (production && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('Invalid public origin');
    }
    return url.origin;
}

function plain(value, max = 160) {
    return Array.from(String(value ?? '').normalize('NFKC').replace(/<[^>]*>/g, ' ')
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
        .replace(/\+?\d[\d ().-]{6,}\d/g, ' ')
        .replace(/[\s\p{Cc}]+/gu, ' ').trim()).slice(0, max).join('').trim();
}

function listingPath(listing) {
    const slug = plain(listing.title, 90).normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    return '/listing/' + listing.id + '/' + encodeURIComponent(slug || 'item');
}

const categoryPath = slug => '/category/' + encodeURIComponent(slug);
const pagedPath = (path, page) => path + (page > 1 ? '?page=' + page : '');
const sellerProfilePath = id => '/users/' + id;
const sellerPath = id => sellerProfilePath(id) + '/reviews';
const noIndex = 'noindex, nofollow';

function absolute(res, path) {
    return (res.locals.publicOrigin || 'http://localhost:3000') + path;
}

function localImage(path) {
    return typeof path === 'string' && /^\/uploads\/listings\/[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(path) ? path : null;
}

function jsonForHtml(data) {
    return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function apply(res, { path, title, description, image, structured, indexable = true }) {
    const canonical = absolute(res, path);
    const trail = res.locals.pageBreadcrumbs;
    if (indexable && trail?.length > 1) {
        const chain = breadcrumbs(res, trail.map((item, index) => index === trail.length - 1 ? { ...item, path } : item));
        structured = structured ? { ...structured, '@graph': [...structured['@graph'], chain] }
            : { '@context': 'https://schema.org', ...chain };
    }
    res.locals.seo = {
        title, description, canonical: indexable ? canonical : null,
        image: image && absolute(res, image), json: structured && jsonForHtml(structured),
        indexable, socialLocale: (res.locals.contentLocale || russian).socialLocale
    };
    res.set('X-Robots-Tag', indexable ? 'index, follow' : 'noindex, follow');
}

function breadcrumbs(res, items) {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: items.map(({ name, path }, index) => ({
            '@type': 'ListItem', position: index + 1, name: plain(name, 150) || 'EuroMarket', item: absolute(res, path)
        }))
    };
}

function init(origin) {
    return (req, res, next) => {
        res.locals.publicOrigin = origin;
        res.locals.contentLocale = russian;
        res.set('X-Robots-Tag', noIndex);
        next();
    };
}

module.exports = { publicOrigin, plain, listingPath, categoryPath, pagedPath, sellerProfilePath, sellerPath, absolute, localImage, apply, breadcrumbs, init };
