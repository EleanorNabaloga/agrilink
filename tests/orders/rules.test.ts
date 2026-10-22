import { describe, expect, test } from "vitest";
import { computeAmounts } from "@/lib/money";
import {
  nextDeadlineEvent,
  transition,
  type Actor,
  type OrderEvent,
  type OrderState,
} from "@/lib/orders/rules";

const AMOUNTS = computeAmounts(50000, 20, 3, 0); // subtotal 1,000,000, commission 30,000
const now = new Date("2026-03-10T09:00:00.000Z");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const addMin = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

const BUYER: Actor = { kind: "buyer", userId: "b1" };
const FARMER: Actor = { kind: "farmer", userId: "f1" };
const ADMIN: Actor = { kind: "admin", userId: "a1" };
const SYSTEM: Actor = { kind: "system" };

function snap(state: OrderState, deadlineAt: Date | null = null) {
  return { state, deadlineAt, amounts: AMOUNTS };
}

describe("transition table", () => {
  test("ordered -> start_payment", () => {
    expect(transition(snap("ordered"), { type: "start_payment" }, BUYER, now)).toEqual({
      ok: true, to: "awaiting_payment", deadlineAt: addMin(now, 30), effects: [],
    });
  });
  test("awaiting_payment -> charge_confirmed", () => {
    expect(transition(snap("awaiting_payment", addMin(now, 10)), { type: "charge_confirmed" }, SYSTEM, now)).toEqual({
      ok: true, to: "paid", deadlineAt: addDays(now, 7), effects: [],
    });
  });
  test("awaiting_payment -> charge_failed", () => {
    expect(transition(snap("awaiting_payment", addMin(now, 10)), { type: "charge_failed" }, SYSTEM, now)).toEqual({
      ok: true, to: "cancelled", deadlineAt: null, effects: [{ kind: "release_stock" }],
    });
  });
  test("awaiting_payment -> payment_timeout after deadline", () => {
    expect(transition(snap("awaiting_payment", addMin(now, -1)), { type: "payment_timeout" }, SYSTEM, now)).toEqual({
      ok: true, to: "cancelled", deadlineAt: null, effects: [{ kind: "release_stock" }],
    });
  });
  test("payment_timeout refused before deadline", () => {
    expect(transition(snap("awaiting_payment", addMin(now, 1)), { type: "payment_timeout" }, SYSTEM, now))
      .toEqual({ ok: false, reason: "deadline_not_reached" });
  });
  test("cancelled -> charge_confirmed", () => {
    expect(transition(snap("cancelled"), { type: "charge_confirmed" }, SYSTEM, now)).toEqual({
      ok: true, to: "refunding", deadlineAt: null, effects: [{ kind: "refund", amount: AMOUNTS.total }],
    });
  });
  test("paid -> farmer_sent", () => {
    expect(transition(snap("paid", addDays(now, 3)), { type: "farmer_sent", transporterName: "Moses" }, FARMER, now)).toEqual({
      ok: true, to: "in_transit", deadlineAt: null, effects: [],
    });
  });
  test("paid -> buyer_cancel_not_sent after deadline", () => {
    expect(transition(snap("paid", addMin(now, -1)), { type: "buyer_cancel_not_sent" }, BUYER, now)).toEqual({
      ok: true, to: "refunding", deadlineAt: null,
      effects: [{ kind: "refund", amount: AMOUNTS.total }, { kind: "release_stock" }],
    });
  });
  test("buyer_cancel_not_sent refused before deadline", () => {
    expect(transition(snap("paid", addDays(now, 1)), { type: "buyer_cancel_not_sent" }, BUYER, now))
      .toEqual({ ok: false, reason: "deadline_not_reached" });
  });
  test("in_transit -> farmer_delivered", () => {
    expect(transition(snap("in_transit"), { type: "farmer_delivered" }, FARMER, now)).toEqual({
      ok: true, to: "delivered", deadlineAt: addDays(now, 3), effects: [],
    });
  });
  test("delivered -> buyer_confirmed", () => {
    expect(transition(snap("delivered", addDays(now, 1)), { type: "buyer_confirmed" }, BUYER, now)).toEqual({
      ok: true, to: "releasing", deadlineAt: null, effects: [{ kind: "payout", amount: AMOUNTS.subtotal }],
    });
  });
  test("delivered -> auto_release after deadline", () => {
    expect(transition(snap("delivered", addMin(now, -1)), { type: "auto_release" }, SYSTEM, now)).toEqual({
      ok: true, to: "releasing", deadlineAt: null, effects: [{ kind: "payout", amount: AMOUNTS.subtotal }],
    });
  });
  test("delivered -> buyer_disputed within deadline (inclusive)", () => {
    expect(transition(snap("delivered", now), { type: "buyer_disputed", note: "bad" }, BUYER, now)).toEqual({
      ok: true, to: "disputed", deadlineAt: null, effects: [],
    });
  });
  test("disputed -> pay_farmer", () => {
    expect(transition(snap("disputed"), { type: "admin_resolve", decision: "pay_farmer" }, ADMIN, now)).toEqual({
      ok: true, to: "releasing", deadlineAt: null, effects: [{ kind: "payout", amount: AMOUNTS.subtotal }],
    });
  });
  test("disputed -> refund_buyer", () => {
    expect(transition(snap("disputed"), { type: "admin_resolve", decision: "refund_buyer" }, ADMIN, now)).toEqual({
      ok: true, to: "refunding", deadlineAt: null, effects: [{ kind: "refund", amount: AMOUNTS.total }],
    });
  });
  test("disputed -> split", () => {
    expect(transition(snap("disputed"), { type: "admin_resolve", decision: "split", farmerAmount: 400000 }, ADMIN, now))
      .toMatchObject({ ok: true, to: "releasing", deadlineAt: null });
  });
  test("split with invalid amount is bad_amount", () => {
    for (const farmerAmount of [undefined, -1, 1.5, AMOUNTS.subtotal + 1]) {
      expect(transition(snap("disputed"), { type: "admin_resolve", decision: "split", farmerAmount }, ADMIN, now))
        .toEqual({ ok: false, reason: "bad_amount" });
    }
  });
  test("releasing -> completed", () => {
    expect(transition(snap("releasing"), { type: "settlement_done", farmerPaid: true }, SYSTEM, now)).toEqual({
      ok: true, to: "completed", deadlineAt: null, effects: [],
    });
  });
  test("refunding -> refunded", () => {
    expect(transition(snap("refunding"), { type: "settlement_done", farmerPaid: false }, SYSTEM, now)).toEqual({
      ok: true, to: "refunded", deadlineAt: null, effects: [],
    });
  });
  test("settlement_done with the wrong farmerPaid flag is not allowed", () => {
    expect(transition(snap("releasing"), { type: "settlement_done", farmerPaid: false }, SYSTEM, now))
      .toEqual({ ok: false, reason: "not_allowed" });
    expect(transition(snap("refunding"), { type: "settlement_done", farmerPaid: true }, SYSTEM, now))
      .toEqual({ ok: false, reason: "not_allowed" });
  });
  test("every row refuses a wrong actor", () => {
    const cases: [OrderState, OrderEvent, Actor][] = [
      ["ordered", { type: "start_payment" }, FARMER],
      ["awaiting_payment", { type: "charge_confirmed" }, BUYER],
      ["awaiting_payment", { type: "charge_failed" }, ADMIN],
      ["awaiting_payment", { type: "payment_timeout" }, BUYER],
      ["cancelled", { type: "charge_confirmed" }, BUYER],
      ["paid", { type: "farmer_sent" }, BUYER],
      ["paid", { type: "buyer_cancel_not_sent" }, FARMER],
      ["in_transit", { type: "farmer_delivered" }, BUYER],
      ["delivered", { type: "buyer_confirmed" }, SYSTEM],
      ["delivered", { type: "auto_release" }, BUYER],
      ["delivered", { type: "buyer_disputed", note: "x" }, FARMER],
      ["disputed", { type: "admin_resolve", decision: "pay_farmer" }, BUYER],
      ["releasing", { type: "settlement_done", farmerPaid: true }, ADMIN],
      ["refunding", { type: "settlement_done", farmerPaid: false }, BUYER],
    ];
    for (const [state, event, actor] of cases) {
      expect(transition(snap(state, addDays(now, -9)), event, actor, now), `${state}/${event.type}`)
        .toEqual({ ok: false, reason: "wrong_actor" });
    }
  });
  test("terminal states and unlisted pairs are not_allowed", () => {
    for (const s of ["completed", "refunded"] as OrderState[]) {
      expect(transition(snap(s), { type: "start_payment" }, BUYER, now)).toEqual({ ok: false, reason: "not_allowed" });
    }
    expect(transition(snap("ordered"), { type: "buyer_confirmed" }, BUYER, now)).toEqual({ ok: false, reason: "not_allowed" });
  });
});

describe("named cases", () => {
  test("charge confirmed after timeout cancellation refunds in full", () => {
    const r = transition(snap("cancelled"), { type: "charge_confirmed" }, SYSTEM, now);
    expect(r).toMatchObject({ ok: true, to: "refunding", effects: [{ kind: "refund", amount: AMOUNTS.total }] });
  });
  test("cannot dispute after 3 days", () => {
    const order = snap("delivered", addDays(now, -3.01));
    expect(transition(order, { type: "buyer_disputed", note: "x" }, BUYER, now)).toEqual({ ok: false, reason: "deadline_passed" });
  });
  test("auto release refused before deadline", () => {
    expect(transition(snap("delivered", addDays(now, 1)), { type: "auto_release" }, SYSTEM, now))
      .toEqual({ ok: false, reason: "deadline_not_reached" });
  });
  test("farmer cannot confirm on the buyer's behalf", () => {
    expect(transition(snap("delivered", addDays(now, 1)), { type: "buyer_confirmed" }, FARMER, now))
      .toEqual({ ok: false, reason: "wrong_actor" });
  });
  test("cannot pay twice", () => {
    expect(transition(snap("paid", addDays(now, 7)), { type: "charge_confirmed" }, SYSTEM, now))
      .toEqual({ ok: false, reason: "not_allowed" });
  });
  test("split payout and refund add up with commission", () => {
    const r = transition(snap("disputed"), { type: "admin_resolve", decision: "split", farmerAmount: 1000000 }, ADMIN, now);
    expect(r).toMatchObject({
      ok: true,
      to: "releasing",
      effects: [
        { kind: "payout", amount: 1000000 },
        { kind: "refund", amount: AMOUNTS.total - 1000000 - 30000 },
      ],
    });
  });
  test("nextDeadlineEvent picks payment_timeout and auto_release only when due", () => {
    expect(nextDeadlineEvent(snap("awaiting_payment", addMin(now, -1)), now)).toEqual({ type: "payment_timeout" });
    expect(nextDeadlineEvent(snap("awaiting_payment", addMin(now, 1)), now)).toBeNull();
    expect(nextDeadlineEvent(snap("delivered", addMin(now, -1)), now)).toEqual({ type: "auto_release" });
    expect(nextDeadlineEvent(snap("paid", addDays(now, -1)), now)).toBeNull();
  });
});
