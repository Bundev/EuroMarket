
const db = require('../config/db');
const bcrypt = require('bcrypt');
const { getAuthSecurity } = require('../services/authSecurity');

// Найти пользователя по email
async function findByEmail(email) {
    const [rows] = await db.execute(
        // The indexed comparison locates the row; binary lowercase comparison
        // prevents accent-insensitive SQL collations from aliasing limiter keys.
        'SELECT * FROM users WHERE email = ? AND BINARY LOWER(email) = BINARY ? LIMIT 1',
        [email, email]
    );

    return rows[0] || null;
}

// Создать нового пользователя
async function createUser({ name, email, password }) {
    const normalizedEmail = email.trim().toLowerCase();

    // Same bcrypt work for a new or already registered address. The UNIQUE key
    // arbitrates concurrent registration without a revealing pre-check.
    const passwordHash = await getAuthSecurity().bcryptWork(() => bcrypt.hash(password, 12));

    // Сохраняем пользователя в MariaDB
    const [result] = await db.execute(
        `INSERT INTO users (name, email, password_hash)
         VALUES (?, ?, ?)`,
        [name.trim(), normalizedEmail, passwordHash]
    );

    return result.insertId;
}

// Проверить пароль
async function verifyPassword(password, passwordHash) {
    return getAuthSecurity().bcryptWork(() => bcrypt.compare(password, passwordHash));
}

async function findPublicById(id) {
    const [[user]] = await db.execute(
        `SELECT id,name,created_at,phone_verified_at IS NOT NULL AS phone_verified,
                (SELECT COUNT(*) FROM deals d WHERE d.seller_id=users.id AND d.status='completed') AS completed_deals
         FROM users WHERE id=? AND status='active'`, [id]);
    return user;
}

module.exports = {
    updateName,
    updatePhone,
    findByEmail,
    findPublicById,
    createUser,
    verifyPassword
};

async function updateName(userId, name) {
    const [result] = await db.execute("UPDATE users SET name=? WHERE id=? AND status='active'", [name, userId]);
    return result.affectedRows > 0;
}

async function updatePhone(userId, phone, phonePublic) {
    const [result] = await db.execute("UPDATE users SET phone=?,phone_public=? WHERE id=? AND status='active'",
        [phone, phonePublic, userId]);
    return result.affectedRows > 0;
}
