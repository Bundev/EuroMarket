const fs = require('node:fs');
const path = require('node:path');

module.exports = async function applyMigrations(connection, selectedFiles) {
    const [[selected]] = await connection.query('SELECT DATABASE() AS name');
    if (selected.name !== 'euromarket_test') throw new Error('Migrations in tests require euromarket_test');
    const directory = path.join(__dirname, '../database/migrations');
    const files = selectedFiles ?? fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    for (const file of files) {
        let delimiter = ';', statement = '';
        for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/)) {
            const directive = /^DELIMITER\s+(\S+)\s*$/i.exec(line);
            if (directive) { delimiter = directive[1]; continue; }
            statement += line + '\n';
            const trimmed = statement.trim();
            if (trimmed.endsWith(delimiter)) {
                await connection.query(trimmed.slice(0, -delimiter.length));
                statement = '';
            }
        }
        if (statement.trim()) throw new Error('Incomplete migration: ' + file);
    }
};
