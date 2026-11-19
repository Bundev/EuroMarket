const logError = require('../services/logError');

const { getAllCategories } = require('../models/category.model');
const listingModel = require('../models/listing.model');
const recentlyViewed = require('../models/recentlyViewed.model');
const seo = require('../services/seo');

async function index(req, res) {
    try {
        const { selectedCountryInfo } = res.locals;
        const categories = await getAllCategories();
        const listings = await listingModel.getActiveListings(selectedCountryInfo?.id ?? null);
        const recentListings = res.locals.viewingHistoryEnabled ? await recentlyViewed.preview(req.session.user.id) : [];
        if (recentListings.length) res.set('Cache-Control', 'private, no-store');
        seo.apply(res, {
            path: '/', title: 'EuroMarket — объявления в Европе',
            description: 'Покупайте и продавайте на EuroMarket. Объявления частных продавцов по странам и категориям Европы.',
            indexable: req.query.country === undefined
        });
        res.render('pages/home', {
            categories,
            listings,
            recentListings,
            listingPath: seo.listingPath,
            categoryLink: slug => seo.categoryPath(slug) + (selectedCountryInfo ? '?country_id=' + selectedCountryInfo.id : '')
        });
    } catch (error) {
        logError('Ошибка главной страницы:', error);
        res.status(500).send('Ошибка сервера');
    }
}

module.exports = { index };
