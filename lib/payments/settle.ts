import { PAYOUT_MAX_ATTEMPTS, PAYOUT_RETRY_MINUTES } from "@/lib/config";
import { query, withTransaction } from "@/lib/db";
import { applyEvent } from "@/lib/orders/apply";
import { getProvider } from "./index";

/*
 * Sending money out of escrow: payouts to farmers, refunds to buyers. Never paying twice comes first.
 *
 * Per row (kind payout or refund; charge rows are never settled):
 *  1. CLAIM in a short transaction (FOR UPDATE SKIP LOCKED): push next_attempt_at forward and, on the
 *     first attempt, set attempts = 1 and reference = <orderId>-<kind>-1. A concurrent settleOrder
 *     skips the row (locked, then not yet due).
 *  2. Before a re-attempt, find out what happened to the PREVIOUS reference. Payouts: verifyTransfer.
 *     successful -> done; pending or unreadable -> wait; failed -> claim a new attempt (new reference).
 *     Refunds: the provider has no status check, so none is made; see the note at refundAttempted.
 *  3. Call the provider outside any transaction, then record the result in another short transaction.
 */

const SYSTEM = { kind: "system" as const };
const RETRY = `now() + interval '${Math.floor(PAYOUT_RETRY_MINUTES)} minutes'`;
const PHONE = /^\+256\d{9}$/;
const ID = /^\d{1,18}$/;

type Kind = "payout" | "refund";
type Claimed = {
  id: string;
  order_id: string;
  kind: Kind;
  amount: string;
  attempts: number;
  reference: string;
  raw: { last?: { status?: string } } | null;
  phone: string | null;
  name: string | null;
  charge_ref: string | null;
  reattempt?: boolean;
};

const mask = (phone: string | null) => (phone ? `${phone.slice(0, 6)}***` : "none");

/** Take the row for this process. Returns null when it is locked, not due, or already finished. */
async function claim(id: string): Promise<Claimed | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<Claimed>(
      `select p.id::text as id, p.order_id::text as order_id, p.kind, p.amount::text as amount, p.attempts,
              p.reference, p.raw,
              coalesce(u.payout_phone, u.phone) as phone, u.name,
              (select c.provider_ref from payments c where c.order_id = p.order_id and c.kind = 'charge' limit 1) as charge_ref
         from payments p
         join orders o on o.id = p.order_id
         join users u on u.id = o.farmer_id
        where p.id = $1 and p.kind in ('payout', 'refund') and p.status in ('pending', 'retry_due')
          and (p.next_attempt_at is null or p.next_attempt_at <= now())
        for update of p skip locked`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.attempts === 0) {
      const reference = `${row.order_id}-${row.kind}-1`;
      await tx.query(`update payments set attempts = 1, reference = $2, next_attempt_at = ${RETRY}, updated_at = now() where id = $1`, [
        id,
        reference,
      ]);
      return { ...row, attempts: 1, reference };
    }
    await tx.query(`update payments set next_attempt_at = ${RETRY}, updated_at = now() where id = $1`, [id]);
    return { ...row, reattempt: true };
  });
}

/** Start the next attempt after verifying the previous one is dead. Null if someone else moved the row. */
async function claimNextAttempt(row: Claimed): Promise<Claimed | null> {
  const attempts = row.attempts + 1;
  const reference = `${row.order_id}-${row.kind}-${attempts}`;
  const r = await query(
    `update payments set attempts = $3, reference = $4, next_attempt_at = ${RETRY}, updated_at = now()
      where id = $1 and attempts = $2 and status in ('pending', 'retry_due') returning id`,
    [row.id, row.attempts, attempts, reference],
  );
  return r.rows.length ? { ...row, attempts, reference } : null;
}

async function record(row: Claimed, status: "successful" | "pending" | "retry_due" | "stuck", providerRef: string | undefined, raw: unknown) {
  await query(
    `update payments set status = $3, provider_ref = coalesce($4, provider_ref), raw = $5::jsonb, updated_at = now()
      where id = $1 and reference = $2`,
    [row.id, row.reference, status, providerRef ?? null, JSON.stringify(raw)],
  );
  console.info(`settle ${row.reference}: ${status}`);
}

const stuck = (row: Claimed, reason: string) => {
  console.error(`settle ${row.reference}: STUCK (${reason})`);
  return record(row, "stuck", undefined, { reason });
};

async function processRow(id: string): Promise<void> {
  let row = await claim(id);
  if (!row) return;
  const provider = getProvider();

  if (row.reattempt) {
    // A re-attempt: what happened to the previous reference?
    if (row.kind === "payout") {
      let prev: "successful" | "pending" | "failed";
      try {
        prev = (await provider.verifyTransfer(row.reference)).status;
      } catch (err) {
        // Cannot tell: sending again could pay twice. Wait; the claim already deferred the next look.
        console.error(`settle ${row.reference}: verifyTransfer failed, will look again later`, err instanceof Error ? err.message : "error");
        return;
      }
      if (prev === "successful") return record(row, "successful", undefined, { verified: "successful" });
      if (prev === "pending") {
        console.info(`settle ${row.reference}: still pending at provider`);
        return;
      }
    } else if (row.raw?.last?.status === "pending") {
      // refundAttempted: the provider accepted the previous refund request but offers no way to ask
      // how it ended, and a new request could refund the buyer twice. Leave it for an admin.
      return stuck(row, "refund accepted by provider but its outcome cannot be checked; admin must confirm");
    }
    // The previous attempt is known to have failed.
    if (row.attempts >= PAYOUT_MAX_ATTEMPTS) return stuck(row, "previous attempt failed and no attempts are left");
    const next = await claimNextAttempt(row);
    if (!next) return;
    row = next;
  }

  const amount = Number(row.amount);
  let result: { status: "pending" | "successful" | "failed"; providerRef?: string; error?: string };
  if (row.kind === "payout") {
    if (!row.phone || !PHONE.test(row.phone)) return stuck(row, "farmer has no valid payout phone");
    try {
      result = await provider.transfer({
        reference: row.reference,
        amount,
        phone: row.phone,
        narration: `AgriLink order ${row.order_id}`,
        beneficiaryName: row.name || row.phone,
      });
    } catch (err) {
      result = { status: "failed", error: err instanceof Error ? err.message : "error" };
    }
  } else {
    if (!row.charge_ref) return stuck(row, "the charge has no provider reference to refund");
    try {
      result = await provider.refund({ reference: row.reference, chargeProviderRef: row.charge_ref, amount });
    } catch (err) {
      result = { status: "failed", error: err instanceof Error ? err.message : "error" };
    }
  }

  const raw = { attempt: row.attempts, last: { status: result.status, error: result.error } };
  if (result.status === "successful") return record(row, "successful", result.providerRef, raw);
  if (result.status === "pending") return record(row, "pending", result.providerRef, raw);
  console.warn(`settle ${row.reference}: attempt ${row.attempts} failed (${mask(row.phone)})`);
  return record(row, row.attempts >= PAYOUT_MAX_ATTEMPTS ? "stuck" : "retry_due", result.providerRef, raw);
}

/** If every payout/refund row is successful, tell the order. Anything unfinished keeps it waiting. */
async function finish(orderId: string): Promise<void> {
  const { rows } = await query<{ kind: Kind; status: string }>(
    "select kind, status from payments where order_id = $1 and kind in ('payout', 'refund')",
    [orderId],
  );
  if (rows.length === 0 || rows.some((r) => r.status !== "successful")) return;
  const farmerPaid = rows.some((r) => r.kind === "payout");
  const r = await applyEvent(orderId, { type: "settlement_done", farmerPaid }, SYSTEM);
  if (!r.ok && r.reason !== "not_allowed") console.error(`settle order ${orderId}: settlement_done refused (${r.reason})`);
}

/**
 * Send every due payout and refund of an order, then complete the order if all of them landed.
 * Safe to call at any time and concurrently. Provider failures are recorded, never thrown.
 */
export async function settleOrder(orderId: string): Promise<void> {
  if (!ID.test(orderId)) return;
  try {
    const { rows } = await query<{ id: string }>(
      `select id::text as id from payments
        where order_id = $1 and kind in ('payout', 'refund') and status in ('pending', 'retry_due')
          and (next_attempt_at is null or next_attempt_at <= now())
        order by id`,
      [orderId],
    );
    for (const r of rows) {
      try {
        await processRow(r.id);
      } catch (err) {
        console.error(`settle row ${r.id} of order ${orderId} failed`, err instanceof Error ? err.message : "error");
      }
    }
    await finish(orderId);
  } catch (err) {
    console.error(`settleOrder ${orderId} failed`, err instanceof Error ? err.message : "error");
  }
}

/**
 * Settle every order that has due payout/refund rows, plus orders whose rows all succeeded but whose
 * state was never moved on (a crash between the two). Returns how many orders were looked at.
 */
export async function settleDue(): Promise<number> {
  const { rows } = await query<{ order_id: string }>(
    `select distinct p.order_id::text as order_id from payments p
      where p.kind in ('payout', 'refund')
        and ((p.status in ('pending', 'retry_due') and (p.next_attempt_at is null or p.next_attempt_at <= now()))
          or (p.status = 'successful'
              and not exists (select 1 from payments q where q.order_id = p.order_id and q.kind in ('payout', 'refund') and q.status <> 'successful')
              and exists (select 1 from orders o where o.id = p.order_id and o.state in ('releasing', 'refunding'))))`,
  );
  for (const r of rows) await settleOrder(r.order_id);
  return rows.length;
}
