const home = { name: 'Главная', path: '/' };
const sections = {
    '/search': 'Поиск', '/favorites': 'Избранное', '/compare': 'Сравнение',
    '/messages': 'Сообщения', '/profile': 'Мой профиль', '/my-listings': 'Мои объявления',
    '/saved-searches': 'Сохранённые поиски', '/notifications': 'Уведомления',
    '/my-purchases': 'Сделки', '/offers': 'Предложения цены', '/admin': 'Администрирование',
    '/following': 'Подписки', '/recently-viewed': 'Недавно просмотренные', '/recommendations': 'Рекомендации'
};
const admin = {
    users: 'Пользователи', listings: 'Объявления', reports: 'Жалобы', logs: 'Журнал действий',
    moderation: 'Модерация', reviews: 'Отзывы', disputes: 'Споры', 'seller-reports': 'Жалобы на продавцов'
};

function trail(...items) { return [home, ...items]; }

function forRequest(req) {
    const path = req.path;
    const section = (parent, name) => trail({ name: sections[parent], path: parent }, { name, path });
    if (path === '/profile' && req.query.edit === '1') return section('/profile', 'Редактирование профиля');
    if (Object.hasOwn(sections, path)) return trail({ name: sections[path], path });
    if (/^\/listings\/\d+\/edit$/.test(path)) return section('/my-listings', 'Редактирование объявления');
    if (path === '/listings/create') return section('/my-listings', 'Новое объявление');
    if (path === '/seller-stats') return section('/my-listings', 'Статистика');
    if (path === '/following/feed') return section('/following', 'Лента подписок');
    if (path === '/saved-searches/new') return section('/saved-searches', 'Новый поиск');
    if (/^\/messages\/\d+$/.test(path)) return section('/messages', 'Диалог');
    if (/^\/(?:deals|my-purchases|disputes)\/\d+$/.test(path)) return section('/my-purchases', path.startsWith('/disputes') ? 'Спор' : 'Сделка');
    if (/^\/offers\/\d+$/.test(path)) return section('/offers', 'Переговоры');
    if (/^\/admin\/reports\/reviews(?:\/\d+)?$/.test(path) || path === '/admin/seller-reports') {
        const items = section('/admin', 'Жалобы');
        items[2].path = '/admin/reports';
        const isSellerReport = path === '/admin/seller-reports';
        items.push({ name: isSellerReport ? 'На продавцов' : 'На отзывы', path: isSellerReport ? path : '/admin/reports/reviews' });
        if (items.at(-1).path !== path) items.push({ name: 'Жалобы на отзыв', path });
        return items;
    }
    const match = /^\/admin\/([a-z-]+)(?:\/\d+(\/reports)?)?$/.exec(path);
    if (match && Object.hasOwn(admin, match[1])) {
        const parent = '/admin/' + match[1];
        const items = section('/admin', admin[match[1]]);
        items[2].path = parent;
        if (path !== parent) items.push({ name: match[2] ? 'Жалобы на отзыв' : match[1] === 'reviews' ? 'Отзыв' : 'Карточка пользователя', path });
        return items;
    }
    return [];
}

module.exports = { trail, forRequest };
