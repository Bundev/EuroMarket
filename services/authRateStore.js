const MAX_KEYS = 20000;

class MemoryStore {
    constructor({ now = Date.now, maxKeys = MAX_KEYS } = {}) { this.now = now; this.maxKeys = maxKeys; this.entries = new Map(); }
    async run(keys, work) {
        const now = this.now();
        if (this.entries.size + keys.length > this.maxKeys) {
            for (const [key, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(key);
            const missing = keys.filter(key => !this.entries.has(key)).length;
            if (this.entries.size + missing > this.maxKeys) throw Object.assign(new Error('Rate store full'), { status: 429, retryAfter: 60 });
        }
        const states = new Map(keys.map(key => {
            const value = this.entries.get(key);
            return [key, value && value.expiresAt > now ? structuredClone(value) : {}];
        }));
        // No await inside the critical section: atomic across requests in this process.
        const result = work(states, now);
        for (const [key, value] of states) if (value.expiresAt > now) this.entries.set(key, value);
        return result;
    }
}

class MariaDbStore {
    constructor(db) { this.db = db; }
    async run(keys, work) {
        const connection = await this.db.getConnection();
        let reusable = true;
        try {
            await connection.beginTransaction();
            const [[clock]] = await connection.query('SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) AS now_ms');
            const now = Number(clock.now_ms);
            const states = new Map();
            for (const key of [...new Set(keys)].sort()) {
                await connection.execute("INSERT INTO auth_rate_limits(key_hash,state_json,expires_at) VALUES (?,'{}',?) ON DUPLICATE KEY UPDATE key_hash=VALUES(key_hash)", [key, now + 60000]);
                const [[row]] = await connection.execute('SELECT state_json,expires_at FROM auth_rate_limits WHERE key_hash=? FOR UPDATE', [key]);
                states.set(key, Number(row.expires_at) > now ? (typeof row.state_json === 'string' ? JSON.parse(row.state_json) : row.state_json) : {});
            }
            const result = work(states, now);
            for (const [key, value] of states) {
                await connection.execute('UPDATE auth_rate_limits SET state_json=?,expires_at=? WHERE key_hash=?', [JSON.stringify(value), value.expiresAt || now + 60000, key]);
            }
            await connection.commit();
            return result;
        } catch (error) {
            try { await connection.rollback(); } catch { reusable = false; }
            throw error;
        } finally { if (reusable) connection.release(); else connection.destroy(); }
    }
    async prune() {
        // Bounded maintenance; safe to schedule independently of login requests.
        await this.db.query('DELETE FROM auth_rate_limits WHERE expires_at < FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) LIMIT 1000');
    }
}
module.exports = { MemoryStore, MariaDbStore };
