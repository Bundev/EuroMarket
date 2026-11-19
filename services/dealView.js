const statuses = Object.freeze({
    requested: 'Ожидает решения продавца',
    accepted: 'Ожидает передачи товара',
    declined: 'Отклонена',
    cancelled: 'Отменена',
    completed: 'Завершена'
});

function actionState(deal, side) {
    const seller = side === 'seller';
    const ownConfirmation = seller ? deal.seller_confirmed_at : deal.buyer_confirmed_at;
    const otherConfirmation = seller ? deal.buyer_confirmed_at : deal.seller_confirmed_at;
    const available = Boolean(deal.parties_active && !deal.moderation_locked);
    const actions = [];
    if (side !== 'admin') {
        if (seller && deal.status === 'requested') {
            if (available && deal.listing_status === 'active') actions.push(['accept', 'Принять запрос']);
            actions.push(['decline', 'Отклонить запрос']);
        }
        if (!deal.active_dispute_id && deal.status === 'accepted' && available && !ownConfirmation && ['active', 'draft'].includes(deal.listing_status)) {
            actions.push(['confirm', seller ? 'Подтвердить передачу' : 'Подтвердить получение']);
        }
        if (!deal.active_dispute_id && ((!seller && deal.status === 'requested') || (deal.status === 'accepted' && !otherConfirmation))) {
            actions.push(['cancel', 'Отменить сделку']);
        }
    }
    return { available, actions };
}

function timeline(deal) {
    const events = [
        ['requested', 'Покупатель отправил запрос', deal.created_at],
        ['accepted', 'Запрос принят', deal.accepted_at],
        ['declined', 'Запрос отклонён', deal.declined_at],
        ['seller_confirmed', 'Продавец подтвердил передачу товара', deal.seller_confirmed_at],
        ['buyer_confirmed', 'Покупатель подтвердил получение товара', deal.buyer_confirmed_at],
        ['completed', 'Сделка завершена', deal.completed_at],
        ['cancelled', 'Сделка отменена', deal.cancelled_at]
    ];
    return events.filter(([, , date]) => date).sort((a, b) => a[2] - b[2]);
}

module.exports = { statuses, actionState, timeline };
