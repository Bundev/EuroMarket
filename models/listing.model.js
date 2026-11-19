
const db = require('../config/db');
const transaction = require('../config/transaction');
const { lockEditable, contentChanged } = require('./listingModeration.model');
const { declinePendingForListing } = require('./deal.model');
const { listingMetrics } = require('./marketplaceTools.model');

const SEARCH_SORTS = Object.freeze({
    newest: 'l.created_at DESC, l.id DESC',
    oldest: 'l.created_at ASC, l.id ASC',
    price_asc: 'l.currency ASC, l.price ASC, l.created_at DESC, l.id DESC',
    price_desc: 'l.currency ASC, l.price DESC, l.created_at DESC, l.id DESC'
});

// Создать объявление
async function createListing(data, connection = db) {
    const {
        userId,
        categoryId,
        countryId,
        cityId,
        title,
        description,
        price,
        currency,
        itemCondition = null,
        bargainingEnabled = false
    } = data;

    const [result] = await connection.execute(
        `INSERT INTO listings (
            user_id,
            category_id,
            country_id,
            city_id,
            title,
            description,
            price,
            currency,
            item_condition,
            bargaining_enabled,
            status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
        [
            userId,
            categoryId,
            countryId,
            cityId || null,
            title,
            description,
            price,
            currency,
            itemCondition,
            bargainingEnabled
        ]
    );

    return result.insertId;
}

// Получить объявления пользователя
async function getUserListings(userId, { status, q, sort, requestedPage }) {
    const filters = ['l.user_id = ?'];
    const params = [userId];
    if (status !== 'all') { filters.push('l.status = ?'); params.push(status); }
    if (q) { filters.push("l.title LIKE ? ESCAPE '!'"); params.push('%' + q.replace(/[!%_]/g, '!$&') + '%'); }
    const where = filters.join(' AND ');
    const order = Object.hasOwn(SEARCH_SORTS, sort) ? SEARCH_SORTS[sort] : SEARCH_SORTS.newest;
    const [[count]] = await db.execute('SELECT COUNT(*) AS total FROM listings l WHERE ' + where, params);
    const totalPages = Math.max(1, Math.ceil(Number(count.total) / 20));
    const page = Math.min(requestedPage, totalPages);
    const [rows] = await db.execute(
        `SELECT l.id,l.title,l.price,l.currency,l.status,l.moderation_locked,l.moderation_reason,
            l.review_reason,l.created_at,${listingMetrics},
            c.name AS category_name,
            (
                SELECT li.image_path
                FROM listing_images li
                WHERE li.listing_id = l.id
                ORDER BY li.sort_order ASC, li.id ASC
                LIMIT 1
            ) AS main_image
         FROM (
             SELECT l.id,l.title,l.price,l.currency,l.status,l.moderation_locked,l.moderation_reason,
                    l.review_reason,l.created_at,l.category_id,l.views
             FROM listings l WHERE ${where}
             ORDER BY ${order} LIMIT ? OFFSET ?
         ) l
         JOIN categories c ON c.id = l.category_id
         ORDER BY ${order}`,
        [...params, 20, (page - 1) * 20]
    );

    return { listings: rows, page, totalPages };
}

// Получить активные объявления
async function getActiveListings(countryId = null) {
    const [rows] = await db.execute(
        `SELECT
            l.id,
            l.title,
            l.price,
            l.currency,
            l.created_at,
            c.name AS category_name,
            (
                SELECT li.image_path
                FROM listing_images li
                WHERE li.listing_id = l.id
                ORDER BY li.sort_order ASC, li.id ASC
                LIMIT 1
            ) AS main_image
         FROM listings l
         JOIN categories c ON c.id = l.category_id
         JOIN users u ON u.id = l.user_id AND u.status = 'active'
         WHERE l.status = 'active' AND l.moderation_locked = 0
         ${countryId === null ? '' : 'AND l.country_id = ?'}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 50`,
        countryId === null ? [] : [countryId]
    );

    return rows;
}



async function getListingById(id) {
    const [rows] = await db.execute(
        `SELECT
            l.id,
            l.user_id,
            l.category_id,
            l.country_id,
            l.city_id,
            l.title,
            l.description,
            l.item_condition,
            l.bargaining_enabled,
            l.price,
            l.currency,
            l.status,
            l.moderation_locked,
            l.moderation_reason,
            l.review_reason,
            l.review_version,
            l.views,
            l.created_at,
            EXISTS(SELECT 1 FROM deals d WHERE d.reserved_listing_id=l.id AND d.status='accepted') AS reserved,
            c.name AS category_name,
            co.name AS country_name,
            u.name AS seller_name,
            u.status AS seller_status,
            u.created_at AS seller_created_at,
            (SELECT COUNT(*) FROM listings active_listing
             WHERE active_listing.user_id = l.user_id AND active_listing.status = 'active'
               AND active_listing.moderation_locked = 0 AND u.status = 'active') AS seller_active_count
         FROM listings l
         JOIN categories c ON c.id = l.category_id
         JOIN countries co ON co.id = l.country_id
         JOIN users u ON u.id = l.user_id
         WHERE l.id = ?
         LIMIT 1`,
        [id]
    );

    return rows[0] || null;
}


// Обновление объявления пользователя

async function updateListing(listingId, userId, data) {
    return transaction(async connection => {
        const listing = await lockEditable(connection, listingId, userId);
        const { title, description, categoryId, countryId, cityId, price, currency } = data;
        const itemCondition = data.itemCondition === undefined ? listing.item_condition : data.itemCondition;
        const bargainingEnabled = data.bargainingEnabled ?? Boolean(listing.bargaining_enabled);
        if (listing.title === title && listing.description === description &&
            Number(listing.category_id) === categoryId && Number(listing.country_id) === countryId &&
            (listing.city_id === null ? null : Number(listing.city_id)) === cityId &&
            Number(listing.price) === price && listing.currency === currency && listing.item_condition === itemCondition &&
            Boolean(listing.bargaining_enabled) === bargainingEnabled) {
            return { pending: false };
        }
        const pending = await contentChanged(connection, listing);
        await connection.execute(
            'UPDATE listings SET title=?, description=?, category_id=?, country_id=?, city_id=?, price=?, currency=?, item_condition=?, bargaining_enabled=? WHERE id=?',
            [title, description, categoryId, countryId, cityId, price, currency, itemCondition, bargainingEnabled, listingId]
        );
        return { pending };
    });
}

async function publishListing(listingId, userId) {
    return transaction(async connection => {
        const listing = await lockEditable(connection, listingId, userId);
        if (!['draft', 'rejected'].includes(listing.status) || listing.moderation_locked) return false;
        await connection.execute(
            "UPDATE listings SET status='pending_review', review_version=review_version+1, review_submitted_at=CURRENT_TIMESTAMP(3), review_reason=NULL WHERE id=?",
            [listingId]
        );
        return true;
    });
}

async function unpublishListing(listingId, userId) {
    const [result] = await executeAsActor(userId,
        `UPDATE listings
         SET status = 'draft',
             updated_at = NOW()
         WHERE id = ?
           AND user_id = ?
           AND status = 'active'`,
        [listingId, userId]
    );

    return result.affectedRows > 0;
}


async function markListingSold(listingId, userId) {
    return transaction(async connection => {
        const [[listing]] = await connection.execute(
            "SELECT id FROM listings WHERE id=? AND user_id=? AND status='active' AND moderation_locked=0 FOR UPDATE", [listingId, userId]
        );
        if (!listing) return false;
        const [[reserved]] = await connection.execute('SELECT id FROM deals WHERE reserved_listing_id=? FOR UPDATE', [listingId]);
        if (reserved) throw Object.assign(new Error('Завершите или отмените открытую сделку в разделе «Мои покупки».'), { status: 409 });
        await connection.execute('SET @euromarket_actor_user_id = ?', [userId]);
        await connection.execute("UPDATE listings SET status='sold', updated_at=NOW() WHERE id=?", [listingId]);
        await declinePendingForListing(connection, listingId, 'Запрос на покупку закрыт: продавец отметил объявление проданным');
        return true;
    });
}

async function searchListings(
    { search, countryId, cityId, categoryId = null, categoryIds, currency, minPrice = null, maxPrice = null,
        sort, favoriteUserId, sellerId, followerId, recentViewerId },
    requestedPage = 1
) {
    const conditions = ["l.status = 'active'", 'l.moderation_locked = 0'];
    const params = [];
    const recent = recentViewerId !== undefined;
    const orderBy = recent ? 'v.id DESC' : Object.hasOwn(SEARCH_SORTS, sort) ? SEARCH_SORTS[sort] : SEARCH_SORTS.newest;
    if (recent) params.push(recentViewerId);

    if (sellerId !== undefined) {
        conditions.push('l.user_id = ?');
        params.push(sellerId);
    }

    if (followerId !== undefined) {
        conditions.push('EXISTS (SELECT 1 FROM seller_follows f WHERE f.seller_id = l.user_id AND f.follower_id = ?)');
        params.push(followerId);
    }

    if (favoriteUserId !== undefined) {
        conditions.push('EXISTS (SELECT 1 FROM favorites f WHERE f.listing_id = l.id AND f.user_id = ?)');
        params.push(favoriteUserId);
    }

    if (search) {
        conditions.push(
            '(l.title LIKE ? OR l.description LIKE ?)'
        );
        params.push(`%${search}%`, `%${search}%`);
    }

    if (countryId) {
        conditions.push('l.country_id = ?');
        params.push(countryId);
    }

    if (cityId) {
        conditions.push('l.city_id = ?');
        params.push(cityId);
    }

    if (categoryIds?.length) {
        conditions.push(`l.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
        params.push(...categoryIds);
    } else if (categoryId !== null) {
        conditions.push('l.category_id = ?');
        params.push(categoryId);
    }

    if (currency) {
        conditions.push('l.currency = ?');
        params.push(currency);
    }

    if (minPrice !== null) {
        conditions.push('l.price >= ?');
        params.push(minPrice);
    }

    if (maxPrice !== null) {
        conditions.push('l.price <= ?');
        params.push(maxPrice);
    }

    const fromClause = `FROM listings l
         ${recent ? 'JOIN recently_viewed v ON v.listing_id=l.id AND v.user_id=?' : ''}
         JOIN users seller ON seller.id=l.user_id AND seller.status='active'
         JOIN categories cat ON cat.id = l.category_id
         JOIN countries co ON co.id = l.country_id
         LEFT JOIN cities ci ON ci.id = l.city_id
         WHERE ${conditions.join(' AND ')}`;
    const [[count]] = await db.execute(
        `SELECT COUNT(*) AS total ${fromClause}`,
        params
    );
    const total = Number(count.total);
    const pageSize = 20;
    const totalPages = Math.ceil(total / pageSize);
    const validPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const page = Math.min(validPage, Math.max(1, totalPages));
    const offset = (page - 1) * pageSize;

    const [rows] = await db.execute(
        `SELECT
            l.id,
            l.title,
            l.price,
            l.currency,
            l.created_at,
            seller.id AS seller_id,
            seller.name AS seller_name,
            cat.name AS category_name,
            co.name AS country_name,
            ci.name AS city_name,
            (
                SELECT li.image_path
                FROM listing_images li
                WHERE li.listing_id = l.id
                ORDER BY li.sort_order ASC, li.id ASC
                LIMIT 1
            ) AS main_image
         ${fromClause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    return { listings: rows, total, page, totalPages };
}



module.exports = {
    getPublicPhone,
    createListing,
    getUserListings,
    getActiveListings,
    getListingById,
    updateListing,
    publishListing,
    unpublishListing,
    markListingSold,
    searchListings,
    SEARCH_SORTS
};

async function getPublicPhone(listingId) {
    const [rows] = await db.execute(
        `SELECT u.phone
         FROM listings l JOIN users u ON u.id = l.user_id
         WHERE l.id = ? AND l.status = 'active' AND l.moderation_locked=0
           AND u.status = 'active' AND u.phone_public = 1
           AND u.phone IS NOT NULL AND u.phone <> ''
         LIMIT 1`,
        [listingId]
    );
    return rows[0]?.phone || null;
}

async function executeAsActor(userId, sql, params) {
    const connection = db.getConnection ? await db.getConnection() : db;
    let reusable = false;
    try {
        await connection.execute('SET @euromarket_actor_user_id = ?', [userId]);
        return await connection.execute(sql, params);
    } finally {
        try {
            await connection.execute('SET @euromarket_actor_user_id = NULL');
            reusable = true;
        } finally {
            if (connection !== db) {
                if (reusable) connection.release();
                else connection.destroy();
            }
        }
    }
}
