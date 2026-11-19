const db = require('../config/db');

const visible = "l.status='active' AND l.moderation_locked=0 AND seller.status='active'";
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
), searches AS (
    SELECT id,category_id,country_id,city_id,currency,min_price,max_price,query_text
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
    + 8 * EXISTS (SELECT 1 FROM searches s
        WHERE (s.country_id IS NULL OR s.country_id=l.country_id)
          AND (s.city_id IS NULL OR s.city_id=l.city_id)
          AND (s.category_id IS NULL OR EXISTS (SELECT 1 FROM search_categories sc
               WHERE sc.search_id=s.id AND sc.category_id=l.category_id))
          AND (s.currency IS NULL OR s.currency=l.currency)
          AND (s.min_price IS NULL OR (s.currency=l.currency AND l.price>=s.min_price))
          AND (s.max_price IS NULL OR (s.currency=l.currency AND l.price<=s.max_price))
          AND (s.query_text='' OR l.title LIKE CONCAT('%',s.query_text,'%')
                               OR l.description LIKE CONCAT('%',s.query_text,'%')))`;

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
    let prefix = '', order = newest;
    const prefixParams = [], orderParams = [];
    if (similar) {
        order = `(l.country_id=?) DESC, (l.currency=?) DESC,
                 CASE WHEN l.currency=? THEN ABS(l.price-?) END ASC, ${newest}`;
        orderParams.push(similar.country_id, similar.currency, similar.currency, similar.price);
    } else if (sort !== 'newest') {
        order = popular + ', ' + newest;
        if (userId) {
            prefix = interests;
            prefixParams.push(userId, userId, Number(Boolean(historyEnabled)), userId);
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
