const db = require('../config/db');
const transaction = require('../config/transaction');
const { insertDealEvent } = require('./notification.model');
const { requireGoodsCategory } = require('./category.model');

function fail(message, status = 409) {
    throw Object.assign(new Error(message), { status });
}

async function lockParties(connection, buyer, seller) {
    const [rows] = await connection.execute('SELECT id, status FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [buyer, seller]);
    return rows.length === 2 && rows.every(row => row.status === 'active');
}

async function lockListing(connection, listingId) {
    const [[listing]] = await connection.execute(
        `SELECT id,user_id,category_id,title,status,moderation_locked,price,currency,bargaining_enabled,review_version,
                COALESCE(expires_at<=UTC_TIMESTAMP(3),FALSE) AS is_expired FROM listings WHERE id=? FOR UPDATE`, [listingId]
    );
    return listing;
}

async function requestPurchase(listingId, buyer, requestKey, negotiationId) {
    const [[initial]] = await db.execute('SELECT user_id FROM listings WHERE id=?', [listingId]);
    if (!initial || Number(initial.user_id) === buyer) fail('Объявление недоступно для покупки.', 404);
    const seller = Number(initial.user_id);
    return transaction(async connection => {
        const active = await lockParties(connection, buyer, seller);
        const listing = await lockListing(connection, listingId);
        if (!active || !listing || Number(listing.user_id) !== seller) {
            fail('Объявление недоступно для покупки.', 404);
        }
        const [[replayed]] = await connection.execute(
            'SELECT id FROM deals WHERE buyer_id=? AND listing_id=? AND purchase_request_key=? FOR UPDATE',
            [buyer, listingId, requestKey]
        );
        if (replayed) fail('Этот запрос на покупку уже отправлен.');
        if (listing.status !== 'active' || listing.is_expired || listing.moderation_locked) {
            fail('Объявление недоступно для покупки.', 404);
        }
        await requireGoodsCategory(connection, listing.category_id);
        const [[existing]] = await connection.execute('SELECT id FROM deals WHERE listing_id=? AND open_buyer_id=? FOR UPDATE', [listingId, buyer]);
        if (existing) fail('У вас уже есть открытый запрос по этому объявлению.');
        const [[reserved]] = await connection.execute('SELECT id FROM deals WHERE reserved_listing_id=? FOR UPDATE', [listingId]);
        if (reserved) fail('Объявление уже зарезервировано.');
        let price = listing.price;
        let agreement;
        if (negotiationId) {
            [[agreement]] = await connection.execute(
                `SELECT amount,version FROM price_negotiations
                 WHERE id=? AND listing_id=? AND buyer_id=? AND seller_id=? AND status='accepted'
                   AND listing_version=? AND currency=? AND updated_at>CURRENT_TIMESTAMP(3)-INTERVAL 7 DAY FOR UPDATE`,
                [negotiationId, listingId, buyer, seller, listing.review_version, listing.currency]);
            if (!agreement || !listing.bargaining_enabled) fail('Договорённость больше недоступна.');
            price = agreement.amount;
        }
        const [insert] = await connection.execute(
            'INSERT INTO deals(listing_id,buyer_id,seller_id,price,currency,purchase_request_key) VALUES (?,?,?,?,?,?)',
            [listingId, buyer, seller, price, listing.currency, requestKey]
        );
        await insertDealEvent(
            connection, seller, insert.insertId, 'requested',
            `Новый запрос на покупку «${listing.title}» · ${price} ${listing.currency}`
        );
        if (agreement) {
            await connection.execute("UPDATE price_negotiations SET status='converted',deal_id=?,version=version+1 WHERE id=?",
                [insert.insertId, negotiationId]);
            await connection.execute(
                "INSERT INTO price_negotiation_events (negotiation_id,version,actor_id,action,amount) VALUES (?,?,?,'converted',?)",
                [negotiationId, agreement.version + 1, buyer, price]);
        }
        return insert.insertId;
    });
}

async function findParticipantDeal(id, actor) {
    const [[deal]] = await db.execute(
        'SELECT listing_id,buyer_id,seller_id FROM deals WHERE id=? AND (buyer_id=? OR seller_id=?)', [id, actor, actor]
    );
    return deal;
}

// Both callers hold the listing lock, which serializes requests and status changes.
async function declinePendingForListing(connection, listingId, message) {
    await connection.execute(
        `INSERT INTO notifications (user_id, event_key, type, text, link)
         SELECT buyer_id, CONCAT('deal:', id, ':declined'), 'deal', ?, CONCAT('/deals/', id)
         FROM deals WHERE listing_id=? AND status='requested'
         ON DUPLICATE KEY UPDATE notifications.id = notifications.id`,
        [message, listingId]
    );
    await connection.execute("UPDATE deals SET status='declined' WHERE listing_id=? AND status='requested'", [listingId]);
}

async function transition(id, actor, action) {
    const initial = await findParticipantDeal(id, actor);
    if (!initial) fail('Сделка не найдена.', 404);
    const buyer = Number(initial.buyer_id), seller = Number(initial.seller_id);
    return transaction(async connection => {
        const active = await lockParties(connection, buyer, seller);
        const listing = await lockListing(connection, initial.listing_id);
        const [[deal]] = await connection.execute(
            'SELECT status,buyer_confirmed_at,seller_confirmed_at FROM deals WHERE id=? FOR UPDATE', [id]
        );
        if (!deal) fail('Сделка не найдена.', 404);
        if (action === 'confirm' || action === 'cancel') {
            const [[dispute]] = await connection.execute(
                'SELECT id FROM deal_disputes WHERE open_deal_id=? FOR UPDATE', [id]
            );
            if (dispute) fail('Подтверждение и отмена недоступны до закрытия спора.');
        }
        const isSeller = actor === seller;
        const notify = (recipient, event, text) => insertDealEvent(connection, recipient, id, event, text);
        const otherParty = isSeller ? buyer : seller;
        if (action === 'cancel' && ['requested', 'accepted'].includes(deal.status)) {
            // Once one party records handover, only the party that confirmed may retract it by cancelling.
            if (deal.status === 'accepted' && (isSeller ? deal.buyer_confirmed_at : deal.seller_confirmed_at)) {
                fail('Другая сторона уже подтвердила передачу товара.');
            }
            await connection.execute("UPDATE deals SET status='cancelled' WHERE id=?", [id]);
            await notify(otherParty, 'cancelled', isSeller ? 'Продавец отменил сделку' : 'Покупатель отменил сделку');
            return 'Сделка отменена.';
        }
        if (action === 'decline' && deal.status === 'requested' && isSeller) {
            await connection.execute("UPDATE deals SET status='declined' WHERE id=?", [id]);
            await notify(buyer, 'declined', 'Продавец отклонил запрос на покупку');
            return 'Запрос отклонён.';
        }
        if (!active || !listing || Number(listing.user_id) !== seller || listing.moderation_locked) {
            fail('Сделка приостановлена. Проверьте состояние объявления и аккаунтов.');
        }
        if (action === 'accept' && deal.status === 'requested' && isSeller && listing.status === 'active' && !listing.is_expired) {
            const [[reserved]] = await connection.execute('SELECT id FROM deals WHERE reserved_listing_id=? FOR UPDATE', [listing.id]);
            if (reserved) fail('Объявление уже зарезервировано.');
            await connection.execute("UPDATE deals SET status='accepted' WHERE id=?", [id]);
            await notify(buyer, 'accepted', 'Продавец принял ваш запрос на покупку');
            await declinePendingForListing(connection, listing.id, 'Продавец принял другой запрос на покупку');
            return 'Запрос принят. Подтвердите сделку после передачи товара.';
        }
        if (action === 'confirm' && deal.status === 'accepted' && ['active', 'draft'].includes(listing.status)) {
            const column = isSeller ? 'seller_confirmed_at' : 'buyer_confirmed_at';
            if (deal[column]) fail('Вы уже подтвердили передачу товара.');
            await connection.execute('UPDATE deals SET ' + column + '=CURRENT_TIMESTAMP(3) WHERE id=?', [id]);
            await notify(otherParty, isSeller ? 'seller_confirmed' : 'buyer_confirmed',
                isSeller ? 'Продавец подтвердил передачу товара' : 'Покупатель подтвердил получение товара');
            if (!(isSeller ? deal.buyer_confirmed_at : deal.seller_confirmed_at)) {
                return 'Ваше подтверждение принято. Ожидаем вторую сторону.';
            }
            await connection.execute("UPDATE deals SET status='completed', completed_at=CURRENT_TIMESTAMP(3) WHERE id=?", [id]);
            await connection.execute('SET @euromarket_actor_user_id = ?', [actor]);
            await connection.execute("UPDATE listings SET status='sold', updated_at=NOW() WHERE id=?", [listing.id]);
            await notify(buyer, 'completed', 'Сделка завершена');
            await notify(seller, 'completed', 'Сделка завершена');
            return 'Сделка завершена.';
        }
        fail('Это действие недоступно для вашей роли или текущего статуса сделки.');
    });
}

async function findDetails(id, viewerId) {
    const [[deal]] = await db.execute(
        `SELECT d.id, d.listing_id, d.buyer_id, d.seller_id, d.price, d.currency, d.status,
                d.created_at, d.buyer_confirmed_at, d.seller_confirmed_at, d.completed_at,
                accepted.occurred_at AS accepted_at, declined.occurred_at AS declined_at,
                cancelled.occurred_at AS cancelled_at, l.title, l.status AS listing_status,
                l.user_id AS listing_owner_id, l.moderation_locked, viewer.role AS viewer_role,
                buyer.name AS buyer_name, seller.name AS seller_name, owner.status AS listing_owner_status,
                (buyer.status='active' AND seller.status='active') AS parties_active,
                (SELECT image_path FROM listing_images WHERE listing_id=l.id ORDER BY sort_order, id LIMIT 1) AS image_path,
                conversation.id AS conversation_id
         FROM deals d
         JOIN users viewer ON viewer.id=? AND viewer.status='active'
         JOIN listings l ON l.id=d.listing_id
         JOIN users owner ON owner.id=l.user_id
         JOIN users buyer ON buyer.id=d.buyer_id JOIN users seller ON seller.id=d.seller_id
         LEFT JOIN deal_events accepted ON accepted.deal_id=d.id AND accepted.event_type='accepted'
         LEFT JOIN deal_events declined ON declined.deal_id=d.id AND declined.event_type='declined'
         LEFT JOIN deal_events cancelled ON cancelled.deal_id=d.id AND cancelled.event_type='cancelled'
         LEFT JOIN conversations conversation ON conversation.listing_id=l.id
             AND conversation.buyer_id=d.buyer_id AND conversation.seller_id=d.seller_id
             AND viewer.id IN (d.buyer_id, d.seller_id)
         WHERE d.id=? AND (viewer.id IN (d.buyer_id,d.seller_id) OR viewer.role='admin')`,
        [viewerId, id]
    );
    return deal;
}

async function list(userId, side, requestedPage) {
    const party = side === 'seller' ? 'seller_id' : 'buyer_id';
    const [[count]] = await db.execute(
        `SELECT (SELECT COUNT(*) FROM deals WHERE ${party}=?) AS total,
                (SELECT COUNT(*) FROM deals WHERE seller_id=? AND status='requested') AS pending_sales`,
        [userId, userId]
    );
    const totalPages = Math.max(1, Math.ceil(Number(count.total) / 20));
    const page = Math.min(requestedPage, totalPages);
    const [deals] = await db.execute(
        `SELECT d.id,d.listing_id,d.price,d.currency,d.status,d.created_at,d.completed_at,
                d.buyer_confirmed_at,d.seller_confirmed_at,
                CASE WHEN d.seller_id=? OR l.status IN ('active','sold') THEN l.title ELSE 'Объявление недоступно' END AS title,
                l.status AS listing_status,l.moderation_locked,
                dispute.id AS active_dispute_id,
                buyer.name AS buyer_name,seller.name AS seller_name,
                (buyer.status='active' AND seller.status='active' AND l.user_id=d.seller_id) AS parties_active,
                r.rating AS review_rating, r.comment AS review_comment, r.moderation_status AS review_status,
                r.moderation_reason AS review_reason,
                (CURRENT_TIMESTAMP(3) < DATE_ADD(r.created_at, INTERVAL 7 DAY)) AS review_editable
         FROM deals d JOIN listings l ON l.id=d.listing_id
         JOIN users buyer ON buyer.id=d.buyer_id JOIN users seller ON seller.id=d.seller_id
         LEFT JOIN reviews r ON r.deal_id=d.id AND d.buyer_id=?
         LEFT JOIN deal_disputes dispute ON dispute.open_deal_id=d.id
         WHERE d.${party}=? ORDER BY d.id DESC LIMIT ? OFFSET ?`, [userId, userId, userId, 20, (page - 1) * 20]
    );
    return { deals, page, totalPages, pendingSalesCount: Number(count.pending_sales) };
}

async function hasCompletedPurchase(listingId, userId) {
    const [rows] = await db.execute(
        "SELECT id FROM deals WHERE reserved_listing_id=? AND buyer_id=? AND status='completed'",
        [listingId, userId]
    );
    return rows.length > 0;
}

module.exports = { list, findDetails, findParticipantDeal, requestPurchase, transition, hasCompletedPurchase, declinePendingForListing,
    lockParties, lockListing };
