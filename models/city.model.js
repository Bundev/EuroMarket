
const db = require('../config/db');

async function getCitiesByCountry(countryId) {
    const [rows] = await db.execute(
        `SELECT id, name
         FROM cities
         WHERE country_id = ?
           AND is_active = 1
         ORDER BY name`,
        [countryId]
    );

    return rows;
}

module.exports = { getCitiesByCountry };
