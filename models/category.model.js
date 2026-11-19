
const db = require('../config/db');

// Получить все активные категории
async function getAllCategories() {
    const [rows] = await db.query(`
        SELECT id, parent_id, slug, name, icon
        FROM categories
        WHERE is_active = 1
        ORDER BY id ASC
    `);

    return rows;
}

function getCategoryNavigation(category, categories) {
    const ids = new Set([Number(category.id)]);
    const descendants = [category];
    for (const parent of descendants) {
        for (const child of categories) {
            if (Number(child.parent_id) === Number(parent.id) && !ids.has(Number(child.id))) {
                ids.add(Number(child.id));
                descendants.push(child);
            }
        }
    }

    const breadcrumbs = [];
    const visited = new Set();
    let current = category;
    while (current && !visited.has(Number(current.id))) {
        visited.add(Number(current.id));
        breadcrumbs.unshift(current);
        current = categories.find(item => Number(item.id) === Number(current.parent_id));
    }
    return {
        categoryIds: [...ids],
        breadcrumbs,
        subcategories: categories.filter(item => Number(item.parent_id) === Number(category.id))
    };
}

module.exports = { getAllCategories, getCategoryNavigation };
