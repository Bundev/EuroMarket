const router = require('express').Router();
const db = require('../config/db');
const { getAllCategories } = require('../models/category.model');
const seo = require('../services/seo');

const chunkSize = 10000;
const publicListings = `FROM listings l JOIN users u ON u.id=l.user_id AND u.status='active'
    WHERE l.status='active' AND l.moderation_locked=0`;
const xml = value => String(value).replace(/[<>&"']/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
})[char]);

function sendXml(res, root, entries) {
    res.removeHeader('X-Robots-Tag');
    res.set('Cache-Control', 'no-cache');
    return res.type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n<' + root +
        ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + entries.join('\n') + '\n</' + root + '>'
    );
}

function entry(res, path, updatedAt) {
    const date = updatedAt && new Date(updatedAt);
    const lastmod = date && Number.isFinite(date.getTime()) ? '<lastmod>' + date.toISOString() + '</lastmod>' : '';
    return '<url><loc>' + xml(seo.absolute(res, path)) + '</loc>' + lastmod + '</url>';
}

async function catalogEntries(res) {
    const categories = await getAllCategories();
    return [entry(res, '/'), ...categories.map(category => entry(res, seo.categoryPath(category.slug)))];
}

const listingEntries = (res, listings) => listings.map(listing => entry(res, seo.listingPath(listing), listing.updated_at));

router.get('/sitemap.xml', async (req, res) => {
    const [listings] = await db.execute('SELECT l.id,l.title,l.updated_at ' + publicListings + ' ORDER BY l.id LIMIT ?', [chunkSize + 1]);
    const catalog = await catalogEntries(res);
    if (catalog.length + listings.length <= chunkSize) {
        return sendXml(res, 'urlset', [...catalog, ...listingEntries(res, listings)]);
    }
    const [listingChunks] = await db.execute('SELECT DISTINCT l.id DIV ? AS bucket ' + publicListings + ' ORDER BY bucket', [chunkSize]);
    const catalogChunks = Math.ceil(catalog.length / chunkSize);
    const paths = Array.from({ length: catalogChunks }, (_, i) => '/sitemap-catalog-' + i + '.xml');
    paths.push(...listingChunks.map(({ bucket }) => '/sitemap-listings-' + bucket + '.xml'));
    if (paths.length > 50000) throw new Error('Sitemap index exceeds capacity');
    return sendXml(res, 'sitemapindex', paths.map(path => '<sitemap><loc>' + xml(seo.absolute(res, path)) + '</loc></sitemap>'));
});

router.get('/sitemap-:name.xml', async (req, res, next) => {
    const match = /^(catalog|listings)-(0|[1-9]\d{0,5})$/.exec(req.params.name);
    if (!match) return next();
    const offset = Number(match[2]) * chunkSize;
    if (match[1] === 'catalog') {
        const catalog = await catalogEntries(res);
        return offset < catalog.length ? sendXml(res, 'urlset', catalog.slice(offset, offset + chunkSize)) : next();
    }
    const [listings] = await db.execute('SELECT l.id,l.title,l.updated_at ' + publicListings +
        ' AND l.id>=? AND l.id<? ORDER BY l.id', [offset, offset + chunkSize]);
    return listings.length ? sendXml(res, 'urlset', listingEntries(res, listings)) : next();
});

router.get('/robots.txt', (req, res) => {
    res.removeHeader('X-Robots-Tag');
    const privatePaths = ['/profile', '/my-listings', '/my-purchases', '/deals', '/disputes', '/admin', '/messages', '/notifications',
        '/following', '/saved-searches', '/recently-viewed', '/recommendations', '/compare', '/seller-stats', '/offers', '/favorites', '/api/', '/login', '/register', '/logout',
        '/listings/create', '/listings/*/edit'];
    res.type('text/plain').send(['User-agent: *', ...privatePaths.map(path => 'Disallow: ' + path),
        '', 'Sitemap: ' + seo.absolute(res, '/sitemap.xml'), ''].join('\n'));
});

module.exports = router;
