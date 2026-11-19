const express = require('express');
const path = require('node:path');

function previewApp() {
    const app = express();
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../views'));
    app.use('/css', express.static(path.resolve(__dirname, '../public/css')));
    app.use('/js', express.static(path.resolve(__dirname, '../public/js')));
    app.get('/api/messages/unread', (req, res) => res.json({ unread: 0, notifications: 0 }));
    app.get('/api/notifications', (req, res) => res.json({ items: [], unread: 0 }));
    app.get('/toast-demo.js', (req, res) => res.sendFile(path.join(__dirname, 'toasts.browser.js')));
    app.get('/', (req, res) => {
        res.render('../tests/toasts-preview', {
            toasts: [], user: { id: 1, name: 'Тестовый пользователь', role: 'user' },
            countries: [{ id: 1, name: 'Украина', code: 'UA' }, { id: 2, name: 'Германия', code: 'DE' }],
            selectedCountry: 'all', selectedCountryInfo: null, headerSearchQuery: '',
            unreadMessages: 0, unreadNotifications: 0, favoritesCsrfToken: 'test-only',
            widths: [320, 390, 768, 1024, 1440, 1920]
        });
    });
    return app;
}
module.exports = previewApp;
if (require.main === module) previewApp().listen(3197, '127.0.0.1', () => console.log('Toast preview: http://127.0.0.1:3197 (no database connection)'));
