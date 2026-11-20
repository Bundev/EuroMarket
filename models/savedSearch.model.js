const { createHash } = require('node:crypto');
const db = require('../config/db');
const transaction = require('../config/transaction');

async function create(actor, name, filters, editId) {
    const { search, countryId, cityId, categoryId, currency, minPrice, maxPrice, sort = 'newest', attributeQuery = '' } = filters;
    const base = [search.toLowerCase(), countryId, cityId, categoryId, currency, minPrice, maxPrice];
    // Preserve the keys of existing searches with the default sort and no characteristics.
    const key = createHash('sha256').update(JSON.stringify(
        sort === 'newest' && !attributeQuery ? base : [...base, sort, attributeQuery]
    )).digest();
    return transaction(async connection => {
        const [[owner]] = await connection.execute("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE", [actor]);
        if (!owner) return 'unauthorized';
        if (editId) {
            const [[target]] = await connection.execute('SELECT id FROM saved_searches WHERE user_id=? AND id=? FOR UPDATE', [actor, editId]);
            if (!target) return 'missing';
        }
        const [[existing]] = await connection.execute(
            'SELECT CAST(id AS CHAR) AS id FROM saved_searches WHERE user_id=? AND criteria_key=?', [actor, key]
        );
        if (existing && existing.id !== editId) return 'exists';
        const values = [name, search, countryId, cityId, categoryId, currency || null, minPrice, maxPrice, key, attributeQuery || null, sort];
        if (editId) {
            await connection.execute(
                `UPDATE saved_searches SET name=?,query_text=?,country_id=?,city_id=?,category_id=?,currency=?,min_price=?,
                   max_price=?,criteria_key=?,attribute_query=?,sort_order=? WHERE user_id=? AND id=?`, [...values, actor, editId]);
            return 'updated';
        }
        const [[count]] = await connection.execute('SELECT COUNT(*) AS total FROM saved_searches WHERE user_id=?', [actor]);
        if (Number(count.total) >= 30) return 'limit';
        await connection.execute(
            `INSERT INTO saved_searches (name,query_text,country_id,city_id,category_id,currency,min_price,max_price,criteria_key,attribute_query,sort_order,user_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [...values, actor]
        );
        return 'created';
    });
}

const fields = 'CAST(s.id AS CHAR) AS id, s.name, s.notify, s.query_text AS search, s.country_id AS countryId, s.city_id AS cityId,' +
    ' s.category_id AS categoryId, s.currency, s.min_price AS minPrice, s.max_price AS maxPrice, s.attribute_query AS attributeQuery, s.sort_order AS sort';

async function list(actor) {
    const [rows] = await db.execute(
        `SELECT ${fields}, co.name AS countryName, ci.name AS cityName, ca.name AS categoryName
         FROM saved_searches s LEFT JOIN countries co ON co.id=s.country_id
         LEFT JOIN cities ci ON ci.id=s.city_id LEFT JOIN categories ca ON ca.id=s.category_id
         WHERE s.user_id=? ORDER BY s.id DESC LIMIT 30`, [actor]
    );
    return rows;
}

async function find(actor, id) {
    const [[row]] = await db.execute(`SELECT ${fields} FROM saved_searches s WHERE s.user_id=? AND s.id=?`, [actor, id]);
    return row;
}

async function change(actor, id, intent, name, notify) {
    const [result] = intent === 'delete'
        ? await db.execute('DELETE FROM saved_searches WHERE user_id=? AND id=?', [actor, id])
        : await db.execute('UPDATE saved_searches SET name=?, notify=? WHERE user_id=? AND id=?', [name, notify, actor, id]);
    return result.affectedRows > 0;
}

module.exports = { create, list, find, change };
