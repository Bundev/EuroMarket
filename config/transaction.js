const db = require('./db');

async function transaction(work) {
    const connection = await db.getConnection();
    let reusable = true;
    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try { await connection.rollback(); }
        catch (rollbackError) { reusable = false; }
        throw error;
    } finally {
        try { await connection.execute('SET @euromarket_actor_user_id = NULL'); }
        catch (error) { reusable = false; }
        if (reusable) connection.release();
        else connection.destroy();
    }
}
module.exports = transaction;
