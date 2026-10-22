import { Pool } from "pg";

export type Tx = { query: typeof query; afterCommit: (cb: () => Promise<void> | void) => void };

const globalForPool = globalThis as unknown as { __agrilinkPool?: Pool };

function pool(): Pool {
  if (!globalForPool.__agrilinkPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForPool.__agrilinkPool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000 });
  }
  return globalForPool.__agrilinkPool;
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  const res = await pool().query(sql, params as any[]);
  return { rows: res.rows as T[] };
}

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      client.release();
    }
  };
  const after: Array<() => Promise<void> | void> = [];
  let result: T;
  try {
    await client.query("begin");
    const tx: Tx = {
      afterCommit: (cb) => {
        after.push(cb);
      },
      query: async <R = any>(sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params as any[]);
        return { rows: res.rows as R[] };
      },
    };
    result = await fn(tx);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    release();
    throw err;
  }
  // Committed: give the connection back before callbacks, so a callback that needs the pool
  // cannot deadlock when every connection is busy.
  release();
  for (const cb of after) {
    try {
      await cb();
    } catch (e) {
      console.error("afterCommit callback failed", e);
    }
  }
  return result;
}

/** Close the shared pool (tests and scripts). */
export async function closePool(): Promise<void> {
  const p = globalForPool.__agrilinkPool;
  globalForPool.__agrilinkPool = undefined;
  if (p) await p.end();
}
