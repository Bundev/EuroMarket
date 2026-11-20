
const db = require('../config/db');

// Получить все активные категории
async function getAllCategories({ includeInactive = false } = {}) {
    const [rows] = await db.query(`
        SELECT id, parent_id, slug, name, icon, is_active
        FROM categories
        ${includeInactive ? '' : 'WHERE is_active = 1'}
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

    return {
        categoryIds: [...ids],
        subcategories: categories.filter(item => Number(item.parent_id) === Number(category.id))
    };
}

function getCategoryAncestors(category, categories) {
    const breadcrumbs = [];
    const visited = new Set();
    let current = category;
    while (current && !visited.has(Number(current.id))) {
        visited.add(Number(current.id));
        breadcrumbs.unshift(current);
        current = categories.find(item => Number(item.id) === Number(current.parent_id));
    }
    return breadcrumbs;
}

function isServiceCategory(ancestors) {
    return ancestors.some(category => category.slug === 'services');
}

async function requireGoodsCategory(connection, categoryId) {
    const [ancestors] = await connection.execute(
        `WITH RECURSIVE lineage AS (
            SELECT id,parent_id,slug FROM categories WHERE id=?
            UNION DISTINCT SELECT c.id,c.parent_id,c.slug FROM categories c JOIN lineage p ON p.parent_id=c.id
         ) SELECT slug FROM lineage`, [categoryId]);
    if (isServiceCategory(ancestors)) {
        throw Object.assign(new Error('Для услуг покупка и торг недоступны. Напишите исполнителю.'), { status: 409 });
    }
}

module.exports = { getAllCategories, getCategoryNavigation, getCategoryAncestors, isServiceCategory, requireGoodsCategory };
