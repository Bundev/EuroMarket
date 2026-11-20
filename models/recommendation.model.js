const db = require('../config/db');
const { matchesSavedAttributes, validatedSearches } = require('./attributeMatch');
const { SEARCH_SORTS } = require('./listing.model');

const preferredFields = "'car_brand','car_model','car_year','car_mileage','car_fuel','device_brand','device_model','device_storage','condition','property_type','property_area','property_rooms'";
const sameValue = `((a.text_value IS NOT NULL AND BINARY a.text_value=BINARY p.text_value) OR
    (a.number_value IS NOT NULL AND a.number_value=p.number_value))`;

const visible = "l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 AND seller.status='active'";
const newest = 'l.created_at DESC, l.id DESC';
// Cold start: recent listings first, then number of favorites, then newest.
const popular = "(l.created_at >= CURRENT_DATE - INTERVAL 30 DAY) DESC, (SELECT COUNT(*) FROM favorites f WHERE f.listing_id=l.id) DESC";

const interests = `WITH RECURSIVE signals AS (
    SELECT listing_id, 4 AS weight FROM favorites WHERE user_id=?
    UNION ALL
    SELECT listing_id, 2 FROM recently_viewed WHERE user_id=? AND ?=1
), preferences AS (
    SELECT l.category_id, l.currency, MAX(s.weight) AS weight,
           SUM(l.price*s.weight)/SUM(s.weight) AS target_price
    FROM signals s JOIN listings l ON l.id=s.listing_id JOIN users seller ON seller.id=l.user_id
    WHERE ${visible}
    GROUP BY l.category_id, l.currency
), preference_attributes AS (
    SELECT DISTINCT l.category_id,a.field_key,a.text_value,a.number_value
    FROM signals s JOIN listings l ON l.id=s.listing_id JOIN users seller ON seller.id=l.user_id
    JOIN listing_attributes a ON a.listing_id=l.id
    WHERE ${visible} AND a.field_key IN (${preferredFields})
), searches AS (
    SELECT id,category_id,country_id,city_id,currency,min_price,max_price,query_text,attribute_query
    FROM saved_searches WHERE user_id=?
),
search_categories(search_id, category_id) AS (
    SELECT s.id,c.id FROM searches s JOIN categories c ON c.id=s.category_id AND c.is_active=1
    UNION DISTINCT
    SELECT sc.search_id,c.id FROM search_categories sc JOIN categories c ON c.parent_id=sc.category_id AND c.is_active=1
)`;

const relevance = `COALESCE((SELECT MAX(p.weight +
    CASE WHEN p.currency=l.currency AND ABS(l.price-p.target_price)<=p.target_price*0.25 THEN 2 ELSE 0 END)
    FROM preferences p WHERE p.category_id=l.category_id),0)
    + LEAST(3, (SELECT COUNT(DISTINCT a.field_key) FROM listing_attributes a
        JOIN preference_attributes p ON p.category_id=l.category_id AND p.field_key=a.field_key
        WHERE a.listing_id=l.id AND ${sameValue}))
    + 8 * EXISTS (SELECT 1 FROM searches s
        WHERE (s.country_id IS NULL OR s.country_id=l.country_id)
          AND (s.city_id IS NULL OR s.city_id=l.city_id)
          AND (s.category_id IS NULL OR EXISTS (SELECT 1 FROM search_categories sc
               WHERE sc.search_id=s.id AND sc.category_id=l.category_id))
          AND (s.currency IS NULL OR s.currency=l.currency)
          AND (s.min_price IS NULL OR (s.currency=l.currency AND l.price>=s.min_price))
          AND (s.max_price IS NULL OR (s.currency=l.currency AND l.price<=s.max_price))
          AND (s.query_text='' OR l.title LIKE CONCAT('%',s.query_text,'%')
                               OR l.description LIKE CONCAT('%',s.query_text,'%'))
          AND ${matchesSavedAttributes})`;

async function recommendations({ userId, countryId, historyEnabled, similar, previewSize, sort, requestedPage }) {
    const filters = [visible], params = [];
    if (userId) { filters.push('l.user_id<>?'); params.push(userId); }
    if (countryId) { filters.push('l.country_id=?'); params.push(countryId); }
    if (similar) {
        filters.push('l.id<>?', 'l.category_id=?');
        params.push(similar.id, similar.category_id);
    }
    const candidates = `FROM listings l JOIN users seller ON seller.id=l.user_id`;
    const where = 'WHERE ' + filters.join(' AND ');
    const limit = previewSize || 20;
    let total = 0, page = 1, totalPages = 0;
    if (!previewSize) {
        const [[count]] = await db.execute(`SELECT COUNT(*) AS total ${candidates} ${where}`, params);
        total = Number(count.total);
        totalPages = Math.ceil(total / limit);
        if (Number.isSafeInteger(requestedPage) && requestedPage > 0) page = Math.min(requestedPage, totalPages || 1);
    }
    let prefix = '', order = SEARCH_SORTS.newest;
    const prefixParams = [], orderParams = [];
    if (similar) {
        order = `(SELECT COUNT(*) FROM listing_attributes a JOIN listing_attributes p ON p.listing_id=? AND p.field_key=a.field_key
            WHERE a.listing_id=l.id AND ${sameValue}) DESC,
                 (l.country_id=?) DESC, (l.currency=?) DESC,
                 CASE WHEN l.currency=? THEN ABS(l.price-?) END ASC, ${newest}`;
        orderParams.push(similar.id, similar.country_id, similar.currency, similar.currency, similar.price);
    } else if (sort !== 'newest') {
        order = popular + ', ' + newest;
        if (userId) {
            prefix = interests;
            prefixParams.push(userId, userId, Number(Boolean(historyEnabled)), userId);
            const [structured] = await db.execute(
                'SELECT CAST(id AS CHAR) AS id,category_id,attribute_query FROM saved_searches WHERE user_id=? AND attribute_query IS NOT NULL', [userId]);
            const [categories] = structured.length ? await db.query(
                'SELECT id,parent_id,slug FROM categories WHERE is_active=1') : [[]];
            orderParams.push(validatedSearches(structured, categories));
            order = relevance + ' DESC, ' + order;
        }
    }
    const [listings] = await db.execute(`${prefix}
        SELECT l.id,l.title,l.price,l.currency,l.created_at,co.name AS country_name,ci.name AS city_name,
               (SELECT i.image_path FROM listing_images i WHERE i.listing_id=l.id ORDER BY i.sort_order,i.id LIMIT 1) AS main_image
        ${candidates} JOIN countries co ON co.id=l.country_id LEFT JOIN cities ci ON ci.id=l.city_id
        ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...prefixParams, ...params, ...orderParams, limit, (page - 1) * limit]);
    return { listings, page, total, totalPages };
}

module.exports = recommendations;
