import { PAYOUT_MAX_ATTEMPTS, PAYOUT_RETRY_MINUTES } from "@/lib/config";
import { query, withTransaction } from "@/lib/db";
import { applyEvent } from "@/lib/orders/apply";
import { getProvider } from "./index";

/*
 * Sending money out of escrow: payouts to farmers, refunds to buyers. Never paying twice comes first.
 *
 * Per row (kind payout or refund; charge rows are never settled):
 *  1. CLAIM in a short transaction (FOR UPDATE SKIP LOCKED): push next_attempt_at forward, stamp
 *     first_claimed_at, and on the first attempt set attempts = 1 and reference = <orderId>-<kind>-1.
 *     A concurrent settleOrder skips the row (locked, then not yet due).
 *  2. Before a re-attempt, find out what happened to the previous one.
 *     Payouts: if the last attempt was a definite decline, send again. Otherwise verifyTransfer:
 *       successful -> done; pending, not_found (after an ambiguous attempt) or unreadable -> wait;
 *       failed -> new attempt under a new reference.
 *     Refunds: a pending refund is re-checked with verifyRefund by its id and never re-sent;
 *       failed -> new attempt. A refund call that threw is stuck at once (no id, no idempotency key).
 *  3. Call the provider outside any transaction, then record the result in another short transaction
 *     that only touches rows still open.
 *  A row still unfinished 3 hours after its first claim becomes stuck (after the verify answer is known).
 */

const SYSTEM = { kind: "system" as const };
const RETRY = `now() + interval '${Math.floor(PAYOUT_RETRY_MINUTES)} minutes'`;
const PHONE = /^\+256\d{9}$/;
const ID = /^\d{1,18}$/;

type Kind = "payout" | "refund";
/** One provider attempt (or check). `definite` is true only when the provider clearly said no. */
type Entry = { attempt: number; status: string; definite?: boolean; error?: string; via?: string; at: string };
type Raw = { attempts?: Entry[]; reason?: string };
type Claimed = {
  id: string;
  order_id: string;
  kind: Kind;
  amount: string;
  attempts: number;
  reference: string;
  provider_ref: string | null;
  raw: Raw | null;
  phone: string | null;
  name: string | null;
  charge_ref: string | null;
  age_sec: number;
  reattempt?: boolean;
};

const MAX_WAIT_SEC = PAYOUT_MAX_ATTEMPTS * PAYOUT_RETRY_MINUTES * 60;
const mask = (phone: string | null) => (phone ? `${phone.slice(0, 6)}***` : "none");
const lastEntry = (row: Claimed): Entry | undefined => row.raw?.attempts?.at(-1);
/** The row's history with one more entry; the history is never rewritten. */
const withEntry = (row: Claimed, e: Omit<Entry, "attempt" | "at">, extra: Partial<Raw> = {}): Raw => ({
  ...row.raw,
  ...extra,
  attempts: [...(row.raw?.attempts ?? []), { attempt: row.attempts, at: new Date().toISOString(), ...e }],
});

/** Take the row for this process. Returns null when it is locked, not due, or already finished. */
async function claim(id: string): Promise<Claimed | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<Claimed>(
      `select p.id::text as id, p.order_id::text as order_id, p.kind, p.amount::text as amount, p.attempts,
              p.reference, p.provider_ref, p.raw,
              coalesce(u.payout_phone, u.phone) as phone, u.name,
              (select c.provider_ref from payments c where c.reference = p.order_id::text || '-charge') as charge_ref,
              extract(epoch from (now() - coalesce(p.first_claimed_at, now())))::float8 as age_sec
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
      await tx.query(
        `update payments set attempts = 1, reference = $2, next_attempt_at = ${RETRY}, first_claimed_at = coalesce(first_claimed_at, now()), updated_at = now() where id = $1`,
        [id, reference],
      );
      return { ...row, attempts: 1, reference };
    }
    await tx.query(
      `update payments set next_attempt_at = ${RETRY}, first_claimed_at = coalesce(first_claimed_at, now()), updated_at = now() where id = $1`,
      [id],
    );
    return { ...row, reattempt: true };
  });
}

/** Start the next attempt after the previous one is known dead. Null if someone else moved the row. */
async function claimNextAttempt(row: Claimed, raw: Raw): Promise<Claimed | null> {
  const attempts = row.attempts + 1;
  const reference = `${row.order_id}-${row.kind}-${attempts}`;
  const r = await query(
    `update payments set attempts = $3, reference = $4, raw = $5::jsonb, next_attempt_at = ${RETRY}, updated_at = now()
      where id = $1 and attempts = $2 and status in ('pending', 'retry_due') returning id`,
    [row.id, row.attempts, attempts, reference, JSON.stringify(raw)],
  );
  return r.rows.length ? { ...row, attempts, reference, raw } : null;
}

/** Writes only rows still open: a successful or stuck row is never overwritten. */
async function record(row: Claimed, status: "successful" | "pending" | "retry_due" | "stuck", providerRef: string | undefined, raw: Raw) {
  const r = await query(
    `update payments set status = $3, provider_ref = coalesce($4, provider_ref), raw = $5::jsonb, updated_at = now()
      where id = $1 and reference = $2 and status in ('pending', 'retry_due') returning id`,
    [row.id, row.reference, status, providerRef ?? null, JSON.stringify(raw)],
  );
  console.info(`settle ${row.reference}: ${r.rows.length ? status : `${status} not recorded, row already closed`}`);
}

const stuck = (row: Claimed, reason: string, e: Omit<Entry, "attempt" | "at"> = { status: "stuck" }) => {
  console.error(`settle ${row.reference}: STUCK (${reason})`);
  return record(row, "stuck", undefined, withEntry(row, e, { reason }));
};

/** Still unresolved after the verify answer is known: stuck once 3 hours old, else look again later. */
function wait(row: Claimed, why: string) {
  if (row.age_sec >= MAX_WAIT_SEC) return stuck(row, `unfinished 3 hours after first claim (${why})`, { status: "stuck", via: "age" });
  console.info(`settle ${row.reference}: waiting (${why})`);
}

async function processRow(id: string): Promise<void> {
  let row = await claim(id);
  if (!row) return;
  const provider = getProvider();

  if (row.reattempt) {
    // A re-attempt: first find out what happened to the previous one.
    // Only an outcome recorded for the CURRENT reference counts. After a new attempt was claimed, the
    // newest history entry belongs to the previous attempt and says nothing about this one (the process
    // may have died after sending it).
    const l = lastEntry(row);
    const last = l && l.attempt === row.attempts ? l : undefined;
    let verifiedFailed = false;
    if (row.kind === "payout") {
      if (!last?.definite) {
        let v: "successful" | "pending" | "failed" | "not_found";
        try {
          v = (await provider.verifyTransfer(row.reference)).status;
        } catch (err) {
          // Cannot tell: sending again could pay twice.
          console.error(`settle ${row.reference}: verifyTransfer failed`, err instanceof Error ? err.message : "error");
          return wait(row, "verifyTransfer failed");
        }
        if (v === "successful") return record(row, "successful", undefined, withEntry(row, { status: "successful", via: "verify" }));
        if (v === "pending") return wait(row, "pending at provider");
        // not_found after an ambiguous attempt: it may still show up.
        if (v === "not_found") return wait(row, "not found after an ambiguous attempt");
        verifiedFailed = true;
      }
    } else if (last?.status === "pending" && row.provider_ref) {
      let v: "successful" | "pending" | "failed";
      try {
        v = (await provider.verifyRefund(row.provider_ref)).status;
      } catch (err) {
        console.error(`settle ${row.reference}: verifyRefund failed`, err instanceof Error ? err.message : "error");
        return wait(row, "verifyRefund failed");
      }
      if (v === "successful") return record(row, "successful", undefined, withEntry(row, { status: "successful", via: "verify" }));
      if (v === "pending") return wait(row, "refund pending at provider");
      verifiedFailed = true;
    } else if (last?.status !== "failed") {
      // Refunds have no idempotency key: if we cannot be sure the last send failed, never send again.
      return stuck(row, "previous refund state unknown");
    }
    // The previous attempt is known to be dead.
    if (row.attempts >= PAYOUT_MAX_ATTEMPTS) return stuck(row, "previous attempt failed and no attempts are left");
    const next = await claimNextAttempt(row, verifiedFailed ? withEntry(row, { status: "failed", via: "verify" }) : (row.raw ?? {}));
    if (!next) return;
    row = next;
  }

  const amount = Number(row.amount);
  if (row.kind === "payout") {
    if (!row.phone || !PHONE.test(row.phone)) return stuck(row, "farmer has no valid payout phone");
    let res: Awaited<ReturnType<typeof provider.transfer>>;
    let definite = false;
    try {
      res = await provider.transfer({
        reference: row.reference,
        amount,
        phone: row.phone,
        narration: `AgriLink order ${row.order_id}`,
        beneficiaryName: row.name || row.phone,
      });
      definite = res.status === "failed" && res.declined === true;
    } catch (err) {
      res = { status: "failed", error: err instanceof Error ? err.message : "error" };
    }
    const raw = withEntry(row, { status: res.status, definite, error: res.error });
    if (res.status === "successful") return record(row, "successful", res.providerRef, raw);
    if (res.status === "pending") return record(row, "pending", res.providerRef, raw);
    console.warn(`settle ${row.reference}: attempt ${row.attempts} failed (${mask(row.phone)})`);
    return record(row, row.attempts >= PAYOUT_MAX_ATTEMPTS ? "stuck" : "retry_due", res.providerRef, raw);
  }

  if (!row.charge_ref) return stuck(row, "the charge has no provider reference to refund");
  let res: Awaited<ReturnType<typeof provider.refund>>;
  try {
    res = await provider.refund({ reference: row.reference, chargeProviderRef: row.charge_ref, amount });
  } catch (err) {
    // No idempotency key on refunds and no id to look it up by: sending again could refund twice.
    return stuck(row, "refund call threw; outcome unknown, admin must check", {
      status: "unknown",
      definite: false,
      error: err instanceof Error ? err.message : "error",
    });
  }
  const raw = withEntry(row, { status: res.status, definite: res.status === "failed", error: res.error });
  if (res.status === "successful") return record(row, "successful", res.providerRef, raw);
  if (res.status === "pending") {
    if (!res.providerRef) return stuck(row, "refund pending but the provider gave no id to check it by");
    return record(row, "pending", res.providerRef, raw);
  }
  console.warn(`settle ${row.reference}: refund attempt ${row.attempts} failed`);
  return record(row, row.attempts >= PAYOUT_MAX_ATTEMPTS ? "stuck" : "retry_due", res.providerRef, raw);
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
 * Settle every order that has due payout/refund rows, plus releasing/refunding orders whose rows all
 * succeeded but whose state was never moved on (a crash between the two). One order failing does
 * not stop the rest. Returns how many orders were looked at.
 */
export async function settleDue(): Promise<number> {
  const { rows } = await query<{ order_id: string }>(
    `select p.order_id::text as order_id from payments p
      where p.kind in ('payout', 'refund') and p.status in ('pending', 'retry_due')
        and (p.next_attempt_at is null or p.next_attempt_at <= now())
     union
     select o.id::text from orders o
      where o.state in ('releasing', 'refunding')
        and exists (select 1 from payments q where q.order_id = o.id and q.kind in ('payout', 'refund'))
        and not exists (select 1 from payments q where q.order_id = o.id and q.kind in ('payout', 'refund') and q.status <> 'successful')`,
  );
  for (const r of rows) {
    try {
      await settleOrder(r.order_id);
    } catch (err) {
      console.error(`settleDue: order ${r.order_id} failed`, err instanceof Error ? err.message : "error");
    }
  }
  return rows.length;
}
