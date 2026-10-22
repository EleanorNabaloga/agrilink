import { config } from "@/lib/config";
import { query, withTransaction } from "@/lib/db";
import { applyEvent } from "@/lib/orders/apply";
import { fakeProvider } from "./fake";
import { flutterwaveProvider } from "./flutterwave";
import type { PaymentProvider } from "./types";

export type { PaymentProvider } from "./types";

export function getProvider(): PaymentProvider {
  return config.paymentProvider === "flutterwave" ? flutterwaveProvider : fakeProvider;
}

const SYSTEM = { kind: "system" as const };

export type ConfirmResult = "confirmed" | "pending" | "failed" | "mismatch" | "ignored";

/**
 * Ask the provider what really happened to an order's charge and apply it. The provider's answer is
 * the only source of truth; webhook bodies are never trusted. Shared by the webhook and the
 * scheduled job. Safe to call any number of times, also concurrently: the order row lock inside
 * applyEvent lets exactly one caller make the paid transition.
 *  - "confirmed": successful, right amount and currency, order moved on (paid, or refunding if it was cancelled)
 *  - "pending":   provider has no final answer yet
 *  - "failed":    provider says it failed and the order was cancelled
 *  - "mismatch":  successful but wrong amount or currency; charge row marked stuck, order untouched
 *  - "ignored":   unknown order or charge, or nothing left to do (already confirmed)
 */
export async function confirmCharge(orderId: string): Promise<ConfirmResult> {
  if (!/^\d{1,18}$/.test(orderId)) return "ignored";
  const reference = `${orderId}-charge`;
  const { rows } = await query<{ total: string; status: string }>(
    `select o.total::text as total, p.status
       from orders o join payments p on p.order_id = o.id and p.kind = 'charge' and p.reference = $2
      where o.id = $1`,
    [orderId, reference],
  );
  const row = rows[0];
  if (!row) {
    console.warn(`confirmCharge: no order or charge row for ${reference}`);
    return "ignored";
  }
  if (row.status === "successful") return "ignored";

  const v = await getProvider().verifyCharge(reference);
  if (v.status === "pending") return "pending";

  if (v.status === "failed") {
    const r = await applyEvent(orderId, { type: "charge_failed" }, SYSTEM);
    return r.ok ? "failed" : "ignored";
  }

  const raw = JSON.stringify({ verify: v });
  if (v.currency !== "UGX" || Number(v.amount) !== Number(row.total)) {
    console.error(
      `PAYMENT MISMATCH ${reference}: got ${v.amount} ${v.currency}, expected ${row.total} UGX. Marked stuck for admin.`,
    );
    await query(
      `update payments set status = 'stuck', provider_ref = coalesce($2, provider_ref), raw = $3::jsonb, updated_at = now()
        where reference = $1 and status = 'pending'`,
      [reference, v.providerRef ?? null, raw],
    );
    return "mismatch";
  }

  return withTransaction(async (tx) => {
    // applyEvent locks the order row first; a concurrent confirmation waits here and then finds the
    // order already moved on, so only one caller gets ok.
    const r = await applyEvent(orderId, { type: "charge_confirmed" }, SYSTEM, { tx });
    if (!r.ok) return "ignored" as const;
    await tx.query(
      `update payments set status = 'successful', provider_ref = coalesce($2, provider_ref), raw = $3::jsonb, updated_at = now()
        where reference = $1`,
      [reference, v.providerRef ?? null, raw],
    );
    return "confirmed" as const;
  });
}
