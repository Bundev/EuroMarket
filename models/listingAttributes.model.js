const db = require('../config/db');
const { display } = require('../services/listingAttributes');

async function load(ids, connection = db, publicOnly = false) {
    if (!ids.length) return new Map();
    const [rows] = await connection.execute(
        `SELECT a.listing_id,a.field_key,a.text_value,a.number_value FROM listing_attributes a
         ${publicOnly ? "JOIN listings l ON l.id=a.listing_id AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>UTC_TIMESTAMP(3)) AND l.moderation_locked=0 JOIN users u ON u.id=l.user_id AND u.status='active'" : ''}
         WHERE a.listing_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.field_key`, ids);
    const result = new Map();
    for (const row of rows) {
        if (!result.has(row.listing_id)) result.set(row.listing_id, new Map());
        result.get(row.listing_id).set(row.field_key, row.text_value ?? Number(row.number_value));
    }
    return result;
}

async function replace(id, values, connection) {
    await connection.execute('DELETE FROM listing_attributes WHERE listing_id=?', [id]);
    if (!values.size) return;
    const rows = [...values].map(([key, value]) => [id, key,
        typeof value === 'string' ? value : null, typeof value === 'number' ? value : null]);
    await connection.query('INSERT INTO listing_attributes(listing_id,field_key,text_value,number_value) VALUES ?', [rows]);
}

function formatted(values = new Map(), legacyCondition) {
    const fields = [...values].map(([key, value]) => display(key, value)).filter(Boolean);
    if (legacyCondition && !values.has('condition') && !values.has('property_condition')) fields.push(display('condition', legacyCondition));
    return fields;
}

module.exports = { load, replace, formatted };
