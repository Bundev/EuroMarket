const logError = require('../services/logError');
const listingModel = require('../models/listing.model');
const categoryModel = require('../models/category.model');
const searchFilters = require('../services/searchFilters');
const seo = require('../services/seo');

async function searchPage(req, res) {
    try {
        const categories = await categoryModel.getAllCategories();
        const category = req.params.slug
            ? categories.find(item => item.slug === req.params.slug)
            : null;
        if (req.params.slug && !category) {
            return res.status(404).send('Категория не найдена');
        }
        const isFavoritesPage = req.path === '/favorites';
        const searchAction = isFavoritesPage ? '/favorites' :
            category ? '/category/' + encodeURIComponent(category.slug) : '/search';
        const { filters, currencies, locationError, filterError: criteriaError } =
            await searchFilters.parse(req.query, res.locals.countries, categories, category);
        if (locationError) return res.status(400).send(locationError);
        const { search, countryId, cityId, categoryId, minPrice, maxPrice, currency } = filters;
        const selectedCategory = category || categories.find(item => Number(item.id) === categoryId);
        const navigation = selectedCategory
            ? categoryModel.getCategoryNavigation(selectedCategory, categories)
            : { categoryIds: null, breadcrumbs: [], subcategories: [] };
        const sort = req.query.sort ?? 'newest';
        filters.sort = sort;
        filters.categoryIds = navigation.categoryIds;
        if (isFavoritesPage) filters.favoriteUserId = req.session.user.id;
        let filterError = criteriaError;
        if (!filterError && (typeof sort !== 'string' || !Object.hasOwn(listingModel.SEARCH_SORTS, sort))) {
            filterError = 'Выберите сортировку из списка.';
        } else if (!filterError && !currency && ['price_asc', 'price_desc'].includes(sort)) {
            filterError = 'Выберите валюту для фильтрации или сортировки по цене.';
        }

        const pageInput = req.query.page;
        const parsedPage = typeof pageInput === 'string' && /^[1-9]\d*$/.test(pageInput)
            ? Number(pageInput)
            : 1;
        const requestedPage = Number.isSafeInteger(parsedPage) ? parsedPage : 1;
        const result = filterError
            ? { listings: [], total: 0, page: 1, totalPages: 0 }
            : await listingModel.searchListings(filters, requestedPage);

        const isCleanCategory = Boolean(category && !filterError && !search && countryId === null &&
            cityId === null && !currency && minPrice === null && maxPrice === null && sort === 'newest' &&
            Object.keys(req.query).every(key => key === 'page' || /^(?:utm_[a-z_]+|gclid|fbclid)$/.test(key)) &&
            (pageInput === undefined || String(result.page) === pageInput));
        const categoryLink = slug => seo.categoryPath(slug) + (countryId !== null ? '?country_id=' + countryId : '');
        if (category) {
            const label = seo.plain(category.name, 80);
            const titleLabel = categories.some(item => item.id !== category.id && seo.plain(item.name, 80) === label)
                ? label + ' · ' + seo.plain(category.slug, 60) : label;
            const pageLabel = result.page > 1 ? ' · страница ' + result.page : '';
            const trail = [{ name: 'Главная', path: '/' }, ...navigation.breadcrumbs.map((item, index, items) => ({
                name: item.name, path: index === items.length - 1 ? seo.pagedPath(searchAction, result.page) : seo.categoryPath(item.slug)
            }))];
            seo.apply(res, {
                path: seo.pagedPath(searchAction, result.page),
                title: `${titleLabel}${pageLabel} — объявления в Европе | EuroMarket`,
                description: `Объявления категории «${label}» на EuroMarket, раздел ${category.slug}${pageLabel}. Каталог предложений по странам Европы.`,
                structured: { '@context': 'https://schema.org', ...seo.breadcrumbs(res, trail) },
                indexable: isCleanCategory
            });
        }

        const query = searchFilters.params(filters);
        query.set('sort', sort);
        if (category && countryId === null) query.set('country_id', '');
        const pageUrl = page => {
            if (isCleanCategory) return seo.pagedPath(searchAction, page);
            const params = new URLSearchParams(query);
            params.set('page', String(page));
            return searchAction + '?' + params.toString();
        };
        const pageNumbers = new Set([1, result.totalPages]);
        const startPage = Math.max(2, Math.min(result.page - 1, result.totalPages - 3));
        const endPage = Math.min(result.totalPages - 1, Math.max(result.page + 1, 4));
        for (let page = startPage; page <= endPage; page++) pageNumbers.add(page);
        const paginationItems = [];
        let previousPage = 0;
        for (const page of [...pageNumbers].filter(page => page > 0).sort((a, b) => a - b)) {
            if (page - previousPage > 1) paginationItems.push(null);
            paginationItems.push(page);
            previousPage = page;
        }

        res.status(filterError ? 400 : 200).render('pages/search', {
            ...filters,
            category,
            categoryLink,
            listingPath: seo.listingPath,
            isFavoritesPage,
            saveFields: searchAction === '/search' && !filterError ? searchFilters.params(filters) : null,
            searchAction,
            breadcrumbs: navigation.breadcrumbs,
            subcategories: navigation.subcategories,
            minPriceInput: typeof req.query.min_price === 'string' ? req.query.min_price : '',
            maxPriceInput: typeof req.query.max_price === 'string' ? req.query.max_price : '',
            categories,
            currencies,
            filterError,
            ...result,
            pageUrl,
            paginationItems
        });

    } catch (error) {
        logError('Ошибка поиска:', error);
        res.status(500).send('Ошибка поиска объявлений');
    }
}

module.exports = { searchPage };
