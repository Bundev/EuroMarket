const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

const sessionStore = new MySQLStore({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    createDatabaseTable: process.env.NODE_ENV !== 'production',
    expiration: 7 * 24 * 60 * 60 * 1000,
    schema: {
        tableName: 'sessions'
    }
});

const sessionMiddleware = session({
    name: 'euromarket.sid',
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
});

module.exports = sessionMiddleware;
module.exports.store = sessionStore;
