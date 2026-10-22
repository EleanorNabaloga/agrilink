import { config, PAYMENT_WINDOW_MIN } from "@/lib/config";
import { withTransaction, type Tx } from "@/lib/db";
import { computeAmounts } from "@/lib/money";
import { notifyOrderEvent } from "@/lib/notify";
import {
  transition,
  type Actor,
  type Effect,
  type OrderEvent,
  type OrderState,
  type TransitionError,
} from "@/lib/orders/rules";

const isId = (s: string) => /^\d+$/.test(s);

export type CreateOrderResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: "bad_quantity" | "not_enough" | "own_listing" | "listing_unavailable" };

/** Reserve stock and create an order. The listing row lock serialises competing buyers. */
export async function createOrder(
  buyerId: string,
  listingId: string,
  quantity: number,
  opts?: { tx?: Tx },
): Promise<CreateOrderResult> {
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, reason: "bad_quantity" };
  if (!isId(listingId)) return { ok: false, reason: "listing_unavailable" };
  const run = async (tx: Tx): Promise<CreateOrderResult> => {
    const { rows } = await tx.query<{ farmer_id: string; quantity_available: number; price_per_unit: string; status: string }>(
      `select farmer_id::text as farmer_id, quantity_available, price_per_unit::text as price_per_unit, status
         from listings where id = $1 for update`,
      [listingId],
    );
    const l = rows[0];
    // A listing that sold out through orders (stock 0) reads as "not enough"; withdrawn, or
    // sold_out while stock remains (set by hand), is unavailable.
    if (!l || l.status === "withdrawn" || (l.status === "sold_out" && l.quantity_available > 0)) {
      return { ok: false, reason: "listing_unavailable" };
    }
    if (l.farmer_id === buyerId) return { ok: false, reason: "own_listing" };
    if (quantity > l.quantity_available) return { ok: false, reason: "not_enough" };

    const a = computeAmounts(Number(l.price_per_unit), quantity, config.commissionPercent, config.providerFeePercent);
    const left = l.quantity_available - quantity;
    await tx.query("update listings set quantity_available = $2, status = $3 where id = $1", [
      listingId,
      left,
      left === 0 ? "sold_out" : "active",
    ]);
    const ins = await tx.query<{ id: string }>(
      `insert into orders (listing_id, buyer_id, farmer_id, quantity, unit_price, subtotal,
                           commission_percent, commission, provider_fee, total, state, deadline_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ordered', now() + make_interval(mins => $11))
       returning id::text as id`,
      [listingId, buyerId, l.farmer_id, quantity, a.unitPrice, a.subtotal, a.commissionPercent, a.commission, a.providerFee, a.total, PAYMENT_WINDOW_MIN],
    );
    return { ok: true, orderId: ins.rows[0].id };
  };
  return opts?.tx ? run(opts.tx) : withTransaction(run);
}

export type ApplyResult =
  | { ok: true; state: OrderState; effects: Effect[] }
  | { ok: false; reason: TransitionError | "not_found" };

type OrderRow = {
  state: OrderState;
  deadline_at: Date | null;
  listing_id: string;
  quantity: number;
  unit_price: string;
  subtotal: string;
  commission_percent: string;
  commission: string;
  provider_fee: string;
  total: string;
};

async function applyInTx(tx: Tx, orderId: string, event: OrderEvent, actor: Actor): Promise<ApplyResult> {
  // The order row is locked first; the listing row is only ever locked after it.
  const { rows } = await tx.query<OrderRow>(
    `select state, deadline_at, listing_id::text as listing_id, quantity, unit_price::text as unit_price,
            subtotal::text as subtotal, commission_percent::text as commission_percent,
            commission::text as commission, provider_fee::text as provider_fee, total::text as total
       from orders where id = $1 for update`,
    [orderId],
  );
  const o = rows[0];
  if (!o) return { ok: false, reason: "not_found" };

  const result = transition(
    {
      state: o.state,
      deadlineAt: o.deadline_at,
      amounts: {
        unitPrice: Number(o.unit_price),
        quantity: o.quantity,
        subtotal: Number(o.subtotal),
        commissionPercent: Number(o.commission_percent),
        commission: Number(o.commission),
        providerFee: Number(o.provider_fee),
        total: Number(o.total),
      },
    },
    event,
    actor,
    new Date(),
  );
  if (!result.ok) return { ok: false, reason: result.reason };

  const transporter = event.type === "farmer_sent" ? event : null;
  await tx.query(
    `update orders set state = $2, deadline_at = $3,
            transporter_name = coalesce($4, transporter_name),
            transporter_phone = coalesce($5, transporter_phone)
      where id = $1`,
    [orderId, result.to, result.deadlineAt, transporter?.transporterName ?? null, transporter?.transporterPhone ?? null],
  );
  await tx.query(
    "insert into order_events (order_id, from_state, to_state, actor, note) values ($1, $2, $3, $4, $5)",
    [
      orderId,
      o.state,
      result.to,
      actor.kind === "system" ? "system" : (actor.userId ?? actor.kind),
      event.type === "buyer_disputed" ? event.note : null,
    ],
  );
  for (const e of result.effects) {
    if (e.kind === "release_stock") {
      await tx.query("select 1 from listings where id = $1 for update", [o.listing_id]);
      await tx.query(
        `update listings set quantity_available = quantity_available + $2,
                status = case when status = 'sold_out' then 'active' else status end
          where id = $1`,
        [o.listing_id, o.quantity],
      );
    } else {
      // A plain insert: an existing reference means a double effect, so the transaction must fail.
      await tx.query("insert into payments (order_id, kind, amount, reference, status) values ($1, $2, $3, $4, 'pending')", [
        orderId,
        e.kind,
        e.amount,
        `${orderId}-${e.kind}-1`,
      ]);
    }
  }
  return { ok: true, state: result.to, effects: result.effects };
}

/**
 * Apply one event to an order under a row lock. With `opts.tx` the caller owns the transaction;
 * either way the notification runs after the commit (errors are logged, never thrown).
 */
export async function applyEvent(
  orderId: string,
  event: OrderEvent,
  actor: Actor,
  opts?: { tx?: Tx },
): Promise<ApplyResult> {
  if (!isId(orderId)) return { ok: false, reason: "not_found" };
  const run = async (tx: Tx) => {
    const res = await applyInTx(tx, orderId, event, actor);
    if (res.ok) tx.afterCommit(() => notifyOrderEvent(orderId, res.state));
    return res;
  };
  return opts?.tx ? run(opts.tx) : withTransaction(run);
}
