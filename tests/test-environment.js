const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');

const database = 'euromarket_test';

async function verifyTestEnvironment() {
    const env = process.env;
    if (env.NODE_ENV === 'production' || env.DB_NAME !== database) {
        throw new Error('Требуется DB_NAME=euromarket_test и окружение разработки или тестирования.');
    }
    if (!env.DB_HOST || !env.DB_USER || !env.DB_PASSWORD || env.DB_USER.toLowerCase() === 'root') {
        throw new Error('Задайте DB_HOST, DB_USER и DB_PASSWORD отдельной тестовой учётной записи.');
    }
    const port = Number(env.DB_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный DB_PORT.');
    let connection;
    try {
        connection = await mysql.createConnection({ host: env.DB_HOST, port, user: env.DB_USER,
            password: env.DB_PASSWORD, database, connectTimeout: 5000 });
        const [[target]] = await connection.query('SELECT DATABASE() AS db');
        const [production] = await connection.query("SHOW DATABASES LIKE 'euromarket'");
        const [grants] = await connection.query('SHOW GRANTS');
        // SHOW GRANTS can include credentials. Never print its rows or raw driver errors.
        const limited = grants.every(row => {
            const grant = Object.values(row)[0];
            // MariaDB also reports its built-in PUBLIC grants for test and test_*.
            if (/^GRANT [A-Z ,]+ ON `test(?:\\_%|)`\.\* TO PUBLIC$/i.test(grant)) return true;
            if (/ WITH GRANT OPTION\b/i.test(grant)) return false;
            return /^GRANT USAGE ON \*\.\* TO /i.test(grant) ||
                /^GRANT [A-Z ,]+ ON `euromarket\\?_test`\.\* TO /i.test(grant);
        });
        if (target.db !== database || production.length || !grants.length || !limited) {
            throw new Error('UNSAFE_GRANTS');
        }
    } catch (error) {
        throw new Error(error.message === 'UNSAFE_GRANTS' ?
            'Отказ: учётная запись имеет посторонние права или доступ к рабочей базе.' :
            'Не удалось подтвердить тестовую базу и права учётной записи.');
    } finally {
        if (connection) await connection.end();
    }
    env.NODE_ENV = 'test';
    env.AUTH_RATE_STORE = 'memory';
    env.SESSION_SECRET = randomBytes(48).toString('hex');
}

module.exports = verifyTestEnvironment;
