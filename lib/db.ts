import { Pool } from "pg";

export type Tx = { query: typeof query };

const globalForPool = globalThis as unknown as { __agrilinkPool?: Pool };

function pool(): Pool {
  if (!globalForPool.__agrilinkPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPool.__agrilinkPool = new Pool({ connectionString });
  }
  return globalForPool.__agrilinkPool;
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  const res = await pool().query(sql, params as any[]);
  return { rows: res.rows as T[] };
}

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const tx: Tx = {
      query: async <R = any>(sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params as any[]);
        return { rows: res.rows as R[] };
      },
    };
    const result = await fn(tx);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Close the shared pool (tests and scripts). */
export async function closePool(): Promise<void> {
  const p = globalForPool.__agrilinkPool;
  globalForPool.__agrilinkPool = undefined;
  if (p) await p.end();
}
