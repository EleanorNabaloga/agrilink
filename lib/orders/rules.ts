import { CONFIRM_WINDOW_DAYS, PAYMENT_WINDOW_MIN, SEND_WINDOW_DAYS } from "@/lib/config";
import { splitAmounts, type Amounts } from "@/lib/money";

export type OrderState =
  | "ordered"
  | "awaiting_payment"
  | "paid"
  | "in_transit"
  | "delivered"
  | "disputed"
  | "releasing"
  | "refunding"
  | "completed"
  | "refunded"
  | "cancelled";

export type OrderEvent =
  | { type: "start_payment" }
  | { type: "charge_confirmed" }
  | { type: "charge_failed" }
  | { type: "payment_timeout" }
  | { type: "farmer_sent"; transporterName?: string; transporterPhone?: string }
  | { type: "farmer_delivered" }
  | { type: "buyer_confirmed" }
  | { type: "auto_release" }
  | { type: "buyer_disputed"; note: string }
  | { type: "buyer_cancel_not_sent" }
  | { type: "admin_resolve"; decision: "pay_farmer" | "refund_buyer" | "split"; farmerAmount?: number }
  | { type: "settlement_done"; farmerPaid: boolean };

export type Actor = { kind: "buyer" | "farmer" | "admin" | "system"; userId?: string };

export type OrderSnapshot = { state: OrderState; deadlineAt: Date | null; amounts: Amounts };

export type Effect =
  | { kind: "payout"; amount: number }
  | { kind: "refund"; amount: number }
  | { kind: "release_stock" };

export type TransitionError =
  | "not_allowed"
  | "wrong_actor"
  | "deadline_not_reached"
  | "deadline_passed"
  | "bad_amount";

export type TransitionResult =
  | { ok: true; to: OrderState; deadlineAt: Date | null; effects: Effect[] }
  | { ok: false; reason: TransitionError };

type Row = {
  actor: Actor["kind"];
  // Returns an error, or the outcome of the transition.
  apply: (
    order: OrderSnapshot,
    event: OrderEvent,
    now: Date,
  ) => TransitionResult;
};

const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

const go = (to: OrderState, deadlineAt: Date | null = null, effects: Effect[] = []): TransitionResult => ({
  ok: true,
  to,
  deadlineAt,
  effects,
});
const fail = (reason: TransitionError): TransitionResult => ({ ok: false, reason });

// now > deadline (a missing deadline never counts as passed)
const isPast = (order: OrderSnapshot, now: Date) =>
  order.deadlineAt !== null && now.getTime() > order.deadlineAt.getTime();

const payoutSubtotal = (o: OrderSnapshot): Effect[] => [{ kind: "payout", amount: o.amounts.subtotal }];
const refundTotal = (o: OrderSnapshot): Effect => ({ kind: "refund", amount: o.amounts.total });

function resolveKey(event: OrderEvent): string {
  switch (event.type) {
    case "admin_resolve":
      return `admin_resolve:${event.decision}`;
    case "settlement_done":
      return `settlement_done:${event.farmerPaid}`;
    default:
      return event.type;
  }
}

const TABLE: Partial<Record<OrderState, Record<string, Row>>> = {
  ordered: {
    start_payment: {
      actor: "buyer",
      apply: (_o, _e, now) => go("awaiting_payment", addMinutes(now, PAYMENT_WINDOW_MIN)),
    },
    // An order never paid for within its window gives its stock back.
    payment_timeout: {
      actor: "system",
      apply: (o, _e, now) =>
        isPast(o, now) ? go("cancelled", null, [{ kind: "release_stock" }]) : fail("deadline_not_reached"),
    },
  },
  awaiting_payment: {
    charge_confirmed: {
      actor: "system",
      apply: (_o, _e, now) => go("paid", addDays(now, SEND_WINDOW_DAYS)),
    },
    charge_failed: {
      actor: "system",
      apply: () => go("cancelled", null, [{ kind: "release_stock" }]),
    },
    payment_timeout: {
      actor: "system",
      apply: (o, _e, now) =>
        isPast(o, now) ? go("cancelled", null, [{ kind: "release_stock" }]) : fail("deadline_not_reached"),
    },
  },
  cancelled: {
    // A late charge landing on an already cancelled order is refunded in full.
    charge_confirmed: {
      actor: "system",
      apply: (o) => go("refunding", null, [refundTotal(o)]),
    },
  },
  paid: {
    farmer_sent: { actor: "farmer", apply: () => go("in_transit") },
    buyer_cancel_not_sent: {
      actor: "buyer",
      apply: (o, _e, now) =>
        isPast(o, now)
          ? go("refunding", null, [refundTotal(o), { kind: "release_stock" }])
          : fail("deadline_not_reached"),
    },
  },
  in_transit: {
    farmer_delivered: {
      actor: "farmer",
      apply: (_o, _e, now) => go("delivered", addDays(now, CONFIRM_WINDOW_DAYS)),
    },
  },
  delivered: {
    buyer_confirmed: { actor: "buyer", apply: (o) => go("releasing", null, payoutSubtotal(o)) },
    auto_release: {
      actor: "system",
      apply: (o, _e, now) =>
        isPast(o, now) ? go("releasing", null, payoutSubtotal(o)) : fail("deadline_not_reached"),
    },
    buyer_disputed: {
      actor: "buyer",
      apply: (o, _e, now) => (isPast(o, now) ? fail("deadline_passed") : go("disputed")),
    },
  },
  disputed: {
    "admin_resolve:pay_farmer": {
      actor: "admin",
      apply: (o) => go("releasing", null, payoutSubtotal(o)),
    },
    "admin_resolve:refund_buyer": {
      actor: "admin",
      apply: (o) => go("refunding", null, [refundTotal(o)]),
    },
    "admin_resolve:split": {
      actor: "admin",
      apply: (o, e) => {
        const farmerAmount = e.type === "admin_resolve" ? e.farmerAmount : undefined;
        try {
          const s = splitAmounts(o.amounts, farmerAmount as number);
          return go("releasing", null, [
            { kind: "payout", amount: s.farmer },
            { kind: "refund", amount: s.buyerRefund },
          ]);
        } catch {
          return fail("bad_amount");
        }
      },
    },
  },
  releasing: {
    "settlement_done:true": { actor: "system", apply: () => go("completed") },
  },
  refunding: {
    "settlement_done:false": { actor: "system", apply: () => go("refunded") },
  },
};

export function transition(
  order: OrderSnapshot,
  event: OrderEvent,
  actor: Actor,
  now: Date,
): TransitionResult {
  const row = TABLE[order.state]?.[resolveKey(event)];
  if (!row) return fail("not_allowed");
  if (actor.kind !== row.actor) return fail("wrong_actor");
  const result = row.apply(order, event, now);
  if (!result.ok) return result;
  // A 0 UGX payout or refund would be rejected by the provider, so never emit one.
  return {
    ...result,
    effects: result.effects.filter((e) => e.kind === "release_stock" || e.amount > 0),
  };
}

/** The system event that is due right now, if any. */
export function nextDeadlineEvent(order: OrderSnapshot, now: Date): OrderEvent | null {
  if (!isPast(order, now)) return null;
  if (order.state === "awaiting_payment" || order.state === "ordered") return { type: "payment_timeout" };
  if (order.state === "delivered") return { type: "auto_release" };
  return null;
}
