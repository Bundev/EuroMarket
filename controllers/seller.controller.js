const { findPublicById } = require('../models/user.model');
const { ratingFor } = require('../models/review.model');
const { searchListings } = require('../models/listing.model');
const seo = require('../services/seo');
const follows = require('../models/follow.model');

const sorts = Object.freeze({
    newest: 'Сначала новые',
    price_asc: 'Сначала дешевле',
    price_desc: 'Сначала дороже'
});

function positiveInteger(value) {
    return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

async function show(req, res) {
    // Viewer-specific favorites and CSRF state are rendered with the public catalog.
    res.set('Cache-Control', 'private, no-store');
    const sellerId = positiveInteger(req.params.id);
    const seller = sellerId && sellerId <= 4294967295 && await findPublicById(sellerId);
    if (!seller) return res.status(404).send('Продавец не найден.');

    const { sort: sortInput, page: pageInput } = req.query;
    const sort = typeof sortInput === 'string' && Object.hasOwn(sorts, sortInput) ? sortInput : 'newest';
    const [rating, catalog, follow] = await Promise.all([
        ratingFor(sellerId),
        searchListings({ sellerId, sort }, positiveInteger(pageInput) || 1),
        follows.summary(sellerId, req.session.user?.id)
    ]);
    const profilePath = seo.sellerProfilePath(sellerId);
    res.locals.pageBreadcrumbs = require('../services/breadcrumbs').trail({ name: seller.name, path: profilePath });
    const pageLabel = catalog.page > 1 ? ' · страница ' + catalog.page : '';
    const label = seo.plain(seller.name, 72);
    const sellerLabel = label ? label + ' · продавец №' + sellerId : 'Продавец №' + sellerId;
    const indexable = (sortInput === undefined || sortInput === 'newest') &&
        (pageInput === undefined || String(catalog.page) === pageInput) &&
        Object.keys(req.query).every(key => /^(?:page|sort|utm_[a-z_]+|gclid|fbclid)$/.test(key));
    seo.apply(res, {
        path: seo.pagedPath(profilePath, catalog.page),
        title: sellerLabel + pageLabel + ' — EuroMarket',
        description: 'Публичный профиль продавца №' + sellerId + (label ? ' «' + label + '»' : '') +
            ' на EuroMarket. Активных объявлений: ' + catalog.total + ', опубликованных отзывов: ' + rating.total + pageLabel + '.',
        indexable
    });

    const linkTo = page => sort === 'newest' ? seo.pagedPath(profilePath, page)
        : profilePath + '?' + new URLSearchParams(page === 1 ? { sort } : { sort, page });
    res.render('pages/seller-profile', {
        seller, rating, follow, ...catalog, sorts, sort, profilePath, linkTo,
        reviewsPath: seo.sellerPath(sellerId), listingPath: seo.listingPath,
        reportReasons: require('../models/sellerReport.model').reasons
    });
}

module.exports = { show };
