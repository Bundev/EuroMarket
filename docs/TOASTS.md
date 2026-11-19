# Toast и flash-сообщения

Toast сообщает о результате действия и не создаёт строки в `notifications`.
Колокольчик и его polling работают отдельно. Миграция не требуется.

Компонент: `views/partials/toasts.ejs`, `public/js/toasts.js`, стили `.em-toast*`
в `public/css/main.css`. Он подключён к страницам, общим шаблонам и страницам
входа/регистрации. Bootstrap JS не требуется; новые зависимости не добавлены.

## AJAX

```js
// Только после успешного ответа сервера:
window.EuroMarketToast.show('Изменения сохранены.', 'success');
window.EuroMarketToast.show('Не удалось сохранить изменения.', 'error');
window.EuroMarketToast.show('Проверьте выбранную страну.', 'warning');
window.EuroMarketToast.show('Дополнительная информация.', 'info');
```

Типы: success / error / warning / info. Текст выводится через textContent.
HTML и произвольные ссылки не поддерживаются. Для предложения входа доступно
`{ action: { href: '/login' } }` третьим аргументом. Для явной дедупликации
можно передать `{ key: 'message-sent:' + message.id }`.

Одновременно видны не более трёх сообщений; очередь ограничена 20 записями.
Одинаковые сообщения подавляются в течение двух секунд. Success исчезает
через 5 с, info через 6 с, warning через 8 с, error через 12 с.
Наведение и фокус приостанавливают таймер. Есть кнопка 44×44 px, Enter/Space
и Escape. Error использует role=alert/assertive, остальные status/polite.
Учитывается prefers-reduced-motion. Область расположена ниже sticky header;
меню шапки и модальные окна остаются выше Toast. На малых экранах доступна
внутренняя прокрутка области сообщений.

Polling не вызывает show: в чате Toast создаётся только в обработчике отправки,
избранное — только после ответа своего запроса. Не добавляйте show в refresh.

## Серверные переходы

```js
const { flash } = require('../middleware/toasts');
// После успешной записи/COMMIT:
flash(req, 'success', 'Объявление опубликовано.');
res.redirect(303, '/profile');
```

В сессию сохраняются только ID, тип и короткий текст, максимум шесть сообщений.
Express-session сохраняет flash перед завершением ответа с перенаправлением.
Middleware извлекает flash только при render HTML. API/polling/статика его
не потребляют. Ответ с flash помечается Cache-Control: no-store.
EJS экранирует текст/атрибуты. Пароли и тела запросов не сохраняются.
UUID уже показанных flash запоминаются в sessionStorage (максимум 100), чтобы
не повторить сообщение при восстановлении устаревшей страницы. Без доступа
к sessionStorage остаётся серверная одноразовая выдача. Восстановление bfcache
очищает старые видимые Toast. Без JavaScript сообщения доступны через noscript.

Вход добавляет flash ПОСЛЕ session.regenerate. Выход через regenerate уничтожает
старую авторизованную сессию, создаёт чистую гостевую, сохраняет выбранную страну
и сообщение о выходе. Регистрация сохраняет одинаковый текст для нового и
существующего адреса. Для HTML-форм используется redirect, JSON-клиенты сохраняют
прежний HTTP 201. Данные старого аккаунта при повторной регистрации не меняются.

Текстовые ошибки HTML-запросов показываются общей страницей action-result с Toast
и ссылкой возврата. Коды 400/401/403/409/413/429/500 и Retry-After сохраняются.
JSON/API-ответы не оборачиваются. Render существующих форм с ошибками, в частности
ошибки фильтров поиска, сохраняет исходную форму и сообщения возле ввода.
Старые query-флаги phone_saved/reported больше не создают сообщения повторно.

## Проверки

```powershell
node tests/toasts.integration.js
node tests/toasts.preview.js
```

Первый тест работает только на euromarket_test, откатывает тестовые записи и
использует отдельный каталог фотографий. Второй запускает локальную страницу
на 127.0.0.1:3197 без подключения к БД. Это тестовый инструмент, он не включён
в маршруты приложения. Кнопка проверки интерфейса проверяет экранирование,
дедупликацию, очередь, ARIA-роли, фокус, Escape и таймеры.

## Изменённые файлы

- `middleware/toasts.js`, `index.js`.
- `public/js/toasts.js`, `public/js/favorites.js`, `public/js/chat.js`, `public/css/main.css`.
- `controllers/auth.controller.js`, `controllers/listing.controller.js`,
  `controllers/profile.controller.js`, `controllers/admin.controller.js`.
- `views/partials/toasts.ejs`, `views/partials/head.ejs`.
- `views/pages/action-result.ejs`, `views/pages/home.ejs`, `views/pages/search.ejs`,
  `views/pages/listing-create.ejs`, `views/pages/listing-edit.ejs`,
  `views/pages/listing-show.ejs`, `views/pages/profile.ejs`, `views/pages/login.ejs`,
  `views/pages/register.ejs`, `views/pages/conversation.ejs`, `views/pages/messages.ejs`,
  `views/pages/notifications.ejs`.
- `views/admin/panel.ejs`, `views/admin/user.ejs`.
- `tests/toasts.integration.js`, `tests/toasts.preview.js`, `tests/toasts-preview.ejs`,
  `tests/toasts.browser.js`, `docs/TOASTS.md`.
