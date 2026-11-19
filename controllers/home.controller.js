const logError = require('../services/logError');

const { getAllCategories } = require('../models/category.model');
const listingModel = require('../models/listing.model');
const recentlyViewed = require('../models/recentlyViewed.model');
const seo = require('../services/seo');
const recommendations = require('../models/recommendation.model');

function preferences(req, res) {
    return { userId: req.session.user?.id, countryId: res.locals.selectedCountryInfo?.id,
        historyEnabled: res.locals.viewingHistoryEnabled };
}

async function feed(req, res) {
    const sort = req.query.sort === 'newest' ? 'newest' : 'relevance';
    const result = await recommendations({ ...preferences(req, res), sort, requestedPage: Number(req.query.page) });
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.render('pages/recommendations', { ...result, sort, listingPath: seo.listingPath,
        headerCountryAction: '/recommendations', headerCountrySort: sort,
        linkTo: page => '/recommendations?' + new URLSearchParams({ sort, page }) });
}

async function index(req, res) {
    try {
        const { selectedCountryInfo } = res.locals;
        const categories = await getAllCategories();
        const listings = await listingModel.getActiveListings(selectedCountryInfo?.id ?? null);
        const recentListings = res.locals.viewingHistoryEnabled ? await recentlyViewed.preview(req.session.user.id) : [];
        const recommended = await recommendations({ ...preferences(req, res), previewSize: 8 });
        res.set('Cache-Control', 'private, no-store');
        seo.apply(res, {
            path: '/', title: 'EuroMarket — объявления в Европе',
            description: 'Покупайте и продавайте на EuroMarket. Объявления частных продавцов по странам и категориям Европы.',
            indexable: req.query.country === undefined
        });
        res.render('pages/home', {
            categories,
            listings,
            recentListings,
            recommended: recommended.listings,
            listingPath: seo.listingPath,
            categoryLink: slug => seo.categoryPath(slug) + (selectedCountryInfo ? '?country_id=' + selectedCountryInfo.id : '')
        });
    } catch (error) {
        logError('Ошибка главной страницы:', error);
        res.status(500).send('Ошибка сервера');
    }
}

module.exports = { index, feed };
