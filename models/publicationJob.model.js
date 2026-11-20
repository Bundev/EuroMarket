const transaction = require('../config/transaction');
const { matchesSavedAttributes, validatedSearches } = require('./attributeMatch');

// The caller locks the seller in the approval transaction, as does a new follow.
async function enqueue(connection, listingId, sellerId, version) {
    const [[latest]] = await connection.execute(
        'SELECT CAST(f.id AS CHAR) AS id FROM seller_follows f WHERE f.seller_id=? ORDER BY f.id DESC LIMIT 1', [sellerId]
    );
    const [[latestSearch]] = await connection.query('SELECT CAST(s.id AS CHAR) AS id FROM saved_searches s ORDER BY s.id DESC LIMIT 1');
    if (latest || latestSearch) {
        await connection.execute(
            'INSERT INTO seller_publication_jobs (listing_id,review_version,max_follow_id,max_search_id) VALUES (?,?,?,?)',
            [listingId, version, latest?.id || '0', latestSearch?.id || '0']
        );
    }
}

async function matchSavedSearches(connection, job, listing) {
    const [batch] = await connection.execute(
        'SELECT CAST(s.id AS CHAR) AS id,s.category_id,s.attribute_query FROM saved_searches s WHERE s.id>? AND s.id<=? ORDER BY s.id LIMIT 200',
        [job.search_last, job.search_max]
    );
    if (!batch.length) return job.search_max;
    const end = batch.at(-1).id;
    const structured = batch.filter(search => search.attribute_query !== null);
    const [categories] = structured.length ? await connection.query(
        'SELECT id,parent_id,slug FROM categories WHERE is_active=1') : [[]];
    await connection.execute(
        `INSERT INTO notifications (user_id,event_key,type,text,link)
         WITH RECURSIVE ancestors(id,parent_id) AS (
             SELECT id,parent_id FROM categories WHERE id=? AND is_active=1
             UNION DISTINCT
             SELECT c.id,c.parent_id FROM categories c JOIN ancestors a ON a.parent_id=c.id WHERE c.is_active=1
         )
         SELECT DISTINCT s.user_id,?, 'listing_status', ?, ?
         FROM saved_searches s JOIN users u ON u.id=s.user_id AND u.status='active'
         JOIN listings l ON l.id=?
         LEFT JOIN countries co ON co.id=s.country_id AND co.is_active=1
         LEFT JOIN cities ci ON ci.id=s.city_id AND ci.country_id=s.country_id AND ci.is_active=1
         WHERE s.id>? AND s.id<=? AND s.notify=1 AND s.user_id<>l.user_id
           AND (s.query_text='' OR l.title LIKE CONCAT('%',s.query_text,'%') OR l.description LIKE CONCAT('%',s.query_text,'%'))
           AND (s.country_id IS NULL OR co.id=l.country_id)
           AND (s.city_id IS NULL OR ci.id=l.city_id)
           AND (s.category_id IS NULL OR s.category_id IN (SELECT id FROM ancestors))
           AND (s.currency IS NULL OR s.currency=l.currency)
           AND (s.min_price IS NULL OR (s.currency=l.currency AND l.price>=s.min_price))
           AND (s.max_price IS NULL OR (s.currency=l.currency AND l.price<=s.max_price))
           AND ${matchesSavedAttributes}
         ON DUPLICATE KEY UPDATE notifications.id=notifications.id`,
        [listing.category_id, 'saved-search-listing:' + job.listing_id,
            `Новое объявление по сохранённому поиску: «${listing.title}» · ${listing.price} ${listing.currency}`,
            '/listings/' + job.listing_id, job.listing_id, job.search_last, end, validatedSearches(structured, categories)]
    );
    return batch.length < 200 ? job.search_max : end;
}

async function processBatch() {
    return transaction(async connection => {
        const [[job]] = await connection.query(
            `SELECT listing_id,review_version,CAST(last_follow_id AS CHAR) AS last_id,CAST(max_follow_id AS CHAR) AS max_id,
                    CAST(last_search_id AS CHAR) AS search_last,CAST(max_search_id AS CHAR) AS search_max
             FROM seller_publication_jobs WHERE finished_at IS NULL ORDER BY listing_id
             LIMIT 1 FOR UPDATE SKIP LOCKED`
        );
        if (!job) return false;
        const [[listing]] = await connection.execute(
            `SELECT l.user_id,l.title,l.category_id,l.price,l.currency FROM listings l JOIN users seller ON seller.id=l.user_id AND seller.status='active'
             WHERE l.id=? AND l.review_version=? AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 LOCK IN SHARE MODE`,
            [job.listing_id, job.review_version]
        );
        const [batch] = listing ? await connection.execute(
            'SELECT CAST(f.id AS CHAR) AS id FROM seller_follows f WHERE f.seller_id=? AND f.id>? AND f.id<=? ORDER BY f.id LIMIT 200',
            [listing.user_id, job.last_id, job.max_id]
        ) : [[]];
        let followLast = job.max_id;
        if (batch.length) {
            const end = batch.at(-1).id;
            await connection.execute(
                `INSERT INTO notifications (user_id,event_key,type,text,link)
                 SELECT f.follower_id,?, 'listing_status', ?, ?
                 FROM seller_follows f JOIN users u ON u.id=f.follower_id
                 WHERE f.seller_id=? AND f.id>? AND f.id<=? AND u.status='active' AND u.notify_followed_sellers=1
                 ON DUPLICATE KEY UPDATE notifications.id=notifications.id`,
                ['seller-listing:' + job.listing_id, 'Новое объявление продавца: «' + listing.title + '»',
                    '/listings/' + job.listing_id, listing.user_id, job.last_id, end]
            );
            if (batch.length === 200) followLast = end;
        }
        const searchLast = listing && job.search_last !== job.search_max ? await matchSavedSearches(connection, job, listing) : job.search_max;
        await connection.execute(
            'UPDATE seller_publication_jobs SET last_follow_id=?, last_search_id=?, finished_at=IF(?,CURRENT_TIMESTAMP(3),NULL) WHERE listing_id=?',
            [followLast, searchLast, followLast === job.max_id && searchLast === job.search_max, job.listing_id]
        );
        return true;
    });
}

module.exports = { enqueue, processBatch };
