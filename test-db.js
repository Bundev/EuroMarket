
require('dotenv').config();

const db = require('./config/db');

async function testConnection() {
    try {
        const [rows] = await db.query(
            'SELECT DATABASE() AS database_name, VERSION() AS version'
        );

        console.log('✅ Подключение к MariaDB успешно!');
        console.log('База данных:', rows[0].database_name);
        console.log('Версия MariaDB:', rows[0].version);

    } catch (error) {
        console.error('❌ Ошибка подключения к MariaDB');
        console.error('Код ошибки:', error.code || 'UNKNOWN');
        process.exitCode = 1;

    } finally {
        await db.end();
    }
}

testConnection();
