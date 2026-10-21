import type { Pool } from 'pg';

export async function loadUser(pool: Pool, id: number): Promise<number | undefined> {
    const query = `SELECT id FROM users WHERE id = $1`;
    const result = await pool.query(query, [id]);
    return result.rows[0]?.id;
}
