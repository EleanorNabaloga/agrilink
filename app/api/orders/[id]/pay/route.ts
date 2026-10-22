import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRoute, HttpError, requireUser } from "@/lib/auth/guard";
import { withAction } from "@/lib/actions";
import { query } from "@/lib/db";
import { applyEvent } from "@/lib/orders/apply";
import { getProvider } from "@/lib/payments";
import { networkOf } from "@/lib/phone";

const Body = z.object({ actionId: z.string().min(1).max(100).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const user = await requireUser(req, ["buyer"]);
    const { id } = await params;
    if (!/^\d+$/.test(id)) throw new HttpError(404, "pay.err.not_found");
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "error.bad_request");

    // The buyer pays from their own account phone. Checked before any state change.
    const network = networkOf(user.phone);
    if (!network) throw new HttpError(400, "pay.err.network");

    const reference = `${id}-charge`;
    let fresh = false;
    const started = await withAction(parsed.data.actionId, user.id, "pay_order", async (tx) => {
      fresh = true;
      const { rows } = await tx.query<{ buyer_id: string; total: string }>(
        "select buyer_id::text as buyer_id, total::text as total from orders where id = $1",
        [id],
      );
      if (!rows[0] || rows[0].buyer_id !== user.id) return { ok: false as const, reason: "not_found" };
      const r = await applyEvent(id, { type: "start_payment" }, { kind: "buyer", userId: user.id }, { tx });
      if (!r.ok) return { ok: false as const, reason: r.reason === "not_found" ? "not_found" : "not_payable" };
      // Recorded in the same transaction as the state change, so a charge never exists unrecorded.
      await tx.query(
        "insert into payments (order_id, kind, amount, reference, status) values ($1, 'charge', $2, $3, 'pending')",
        [id, rows[0].total, reference],
      );
      return { ok: true as const, amount: Number(rows[0].total) };
    });
    if (!started.ok) throw new HttpError(started.reason === "not_found" ? 404 : 409, `pay.err.${started.reason}`);
    // A replayed actionId must not charge the buyer's phone a second time.
    if (!fresh) return NextResponse.json({ status: "pending" });

    // The money call happens only after the order state is committed.
    let res;
    try {
      res = await getProvider().startCharge({
        reference,
        amount: started.amount,
        phone: user.phone,
        network,
        email: `${user.phone.replace(/\D/g, "")}@buyers.agrilink.ug`,
      });
    } catch (err) {
      // Unknown outcome: the prompt may still arrive. Leave the order awaiting payment.
      console.error(`startCharge ${reference} threw`, err instanceof Error ? err.message : "error");
      throw new HttpError(502, "pay.err.unreachable");
    }
    if (res.status === "failed") {
      console.warn(`startCharge ${reference} declined`);
      await applyEvent(id, { type: "charge_failed" }, { kind: "system" });
      throw new HttpError(409, "pay.err.failed");
    }
    if (res.providerRef) {
      await query("update payments set provider_ref = $2, updated_at = now() where reference = $1", [reference, res.providerRef]);
    }
    return NextResponse.json({ status: "pending" });
  });
}
