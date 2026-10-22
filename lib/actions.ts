import { HttpError } from "@/lib/auth/guard";
import { withTransaction, type Tx } from "@/lib/db";

/**
 * Run `fn` at most once per actionId. A repeated actionId returns the first stored result,
 * also when two requests arrive at the same moment: the primary key on synced_actions makes
 * the second insert wait for the first transaction, so only the winner runs `fn`.
 * `fn` gets the transaction, so the work and the action record commit together.
 * Results must be JSON-serialisable. If `fn` throws, nothing is stored and a retry runs again.
 */
export async function withAction<T>(
  actionId: string | undefined,
  userId: string,
  action: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTransaction(async (tx) => {
    if (actionId === undefined) return fn(tx);
    const ins = await tx.query(
      `insert into synced_actions (action_id, user_id, action) values ($1, $2, $3)
       on conflict (action_id) do nothing returning action_id`,
      [actionId, userId, action],
    );
    if (ins.rows.length === 0) {
      // Another request owns this id (and has committed, since the insert waited for it).
      const { rows } = await tx.query<{ user_id: string; result: T }>(
        "select user_id::text as user_id, result from synced_actions where action_id = $1",
        [actionId],
      );
      if (rows.length === 0 || rows[0].user_id !== userId) throw new HttpError(409, "error.conflict");
      return rows[0].result;
    }
    const result = await fn(tx);
    const json = JSON.stringify(result === undefined ? null : result);
    await tx.query("update synced_actions set result = $2::jsonb where action_id = $1", [actionId, json]);
    return JSON.parse(json) as T;
  });
}
