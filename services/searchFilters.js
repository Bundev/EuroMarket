const db = require('../config/db');

function parseId(value) {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return NaN;
    return Number(value) <= 4294967295 ? Number(value) : NaN;
}

function parsePrice(value) {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^\d{1,10}(?:[.,]\d{1,2})?$/.test(value)) return NaN;
    return Number(value.replace(',', '.'));
}

async function parse(input, countries, categories, category) {
    const search = typeof input.search === 'string' ? input.search.trim().slice(0, 100) : '';
    const countryId = parseId(input.country_id);
    const cityId = parseId(input.city_id);
    const categoryId = category ? Number(category.id) : parseId(input.category_id);
    const currency = input.currency ?? '';
    const minPrice = parsePrice(input.min_price);
    const maxPrice = parsePrice(input.max_price);
    const filters = { search, countryId, cityId, categoryId, currency, minPrice, maxPrice };
    const currencies = [...new Set(countries.map(country => country.currency))].sort();

    let locationError;
    if (Number.isNaN(countryId) || Number.isNaN(cityId) || (cityId !== null && countryId === null)) {
        locationError = 'Некорректные фильтры';
    } else if (countryId !== null && !countries.some(country => Number(country.id) === countryId)) {
        locationError = 'Страна не найдена';
    } else if (cityId !== null) {
        const [[city]] = await db.execute('SELECT id FROM cities WHERE id=? AND country_id=? AND is_active=1', [cityId, countryId]);
        if (!city) locationError = 'Некорректный город';
    }

    let filterError = '';
    if (categoryId !== null && !categories.some(category => Number(category.id) === categoryId)) {
        filterError = 'Выберите категорию из списка.';
    } else if (Number.isNaN(minPrice) || Number.isNaN(maxPrice)) {
        filterError = 'Укажите неотрицательную цену (до 10 цифр и 2 знаков после запятой).';
    } else if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        filterError = 'Минимальная цена не может быть выше максимальной.';
    } else if (currency !== '' && !currencies.includes(currency)) {
        filterError = 'Выберите валюту из списка.';
    } else if (!currency && (minPrice !== null || maxPrice !== null)) {
        filterError = 'Выберите валюту для фильтрации или сортировки по цене.';
    }
    return { filters, currencies, locationError, filterError };
}

function params({ search, countryId, cityId, categoryId, currency, minPrice, maxPrice, sort, attributeQuery }) {
    const query = new URLSearchParams(Object.entries({
        search, country_id: countryId, city_id: cityId, category_id: categoryId, currency, min_price: minPrice, max_price: maxPrice, sort
    }).filter(([, value]) => value != null && value !== ''));
    for (const [key, value] of new URLSearchParams(attributeQuery)) query.append(key, value);
    return query;
}

function url(filters) {
    const query = params(filters);
    return query.size ? '/search?' + query : '/search';
}

module.exports = { parse, params, url };
