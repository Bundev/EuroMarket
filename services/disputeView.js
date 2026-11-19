const reasons = Object.freeze({
    not_delivered: 'Товар не передан',
    not_as_described: 'Товар не соответствует описанию',
    payment: 'Проблема с оплатой',
    other: 'Другое'
});
const statuses = Object.freeze({
    open: 'Открыт',
    info_requested: 'Запрошена дополнительная информация',
    resolved: 'Закрыт с решением',
    rejected: 'Отклонён'
});
const actions = Object.freeze({
    opened: 'Спор открыт',
    reply: 'Сообщение',
    request_info: 'Запрос дополнительной информации',
    resolve: 'Решение администратора',
    reject: 'Спор отклонён'
});
module.exports = { reasons, statuses, actions };
