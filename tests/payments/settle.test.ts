import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../helpers/db";
import { query } from "@/lib/db";
import { applyEvent, createOrder } from "@/lib/orders/apply";
import { createListing } from "@/lib/listings";
import { getProvider } from "@/lib/payments";
import { completeTransfer, failTransfers, pendingTransfers, resetFake } from "@/lib/payments/fake";
import { settleDue, settleOrder } from "@/lib/payments/settle";

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetFake();
  await resetDb();
});

const SYSTEM = { kind: "system" as const };
const ADMIN = { kind: "admin" as const, userId: "1" };

async function makeUser(role: string, phone: string, name: string | null = "T") {
  const r = await query<{ id: string }>(
    "insert into users (phone, role, name) values ($1, $2, $3) returning id::text as id",
    [phone, role, name],
  );
  return r.rows[0].id;
}

/** subtotal 4000, commission 120, total 4120. */
async function newOrder() {
  const farmer = await makeUser("farmer", "+256771000001", "Farmer Fay");
  const buyer = await makeUser("buyer", "+256771000002");
  const p = (await query<{ id: string; unit: string }>("select id::text as id, units[1] as unit from products order by id limit 1")).rows[0];
  const listing = await createListing(farmer, { productId: p.id, quantity: 10, unit: p.unit, pricePerUnit: 1000, district: "Mbale" }, farmer);
  const r = await createOrder(buyer, listing, 4);
  if (!r.ok) throw new Error("setup");
  const orderId = r.orderId;
  await applyEvent(orderId, { type: "start_payment" }, { kind: "buyer", userId: buyer });
  await query(
    "insert into payments (order_id, kind, amount, reference, provider_ref, status) values ($1, 'charge', 4120, $2, 'flw-777', 'pending')",
    [orderId, `${orderId}-charge`],
  );
  return { farmer, buyer, orderId };
}
async function toDelivered() {
  const o = await newOrder();
  await applyEvent(o.orderId, { type: "charge_confirmed" }, SYSTEM);
  await applyEvent(o.orderId, { type: "farmer_sent" }, { kind: "farmer", userId: o.farmer });
  await applyEvent(o.orderId, { type: "farmer_delivered" }, { kind: "farmer", userId: o.farmer });
  return o;
}
async function toReleasing() {
  const o = await toDelivered();
  const r = await applyEvent(o.orderId, { type: "buyer_confirmed" }, { kind: "buyer", userId: o.buyer });
  if (!r.ok) throw new Error("setup releasing");
  return o;
}
async function toRefunding() {
  const o = await newOrder();
  await query("update orders set deadline_at = now() - interval '1 minute' where id = $1", [o.orderId]);
  await applyEvent(o.orderId, { type: "payment_timeout" }, SYSTEM);
  await applyEvent(o.orderId, { type: "charge_confirmed" }, SYSTEM);
  return o;
}
const state = async (id: string) => (await query("select state from orders where id = $1", [id])).rows[0].state as string;
const rows = async (id: string, kind: string) =>
  (await query("select * from payments where order_id = $1 and kind = $2 order by id", [id, kind])).rows;
const backdate = (id: string) =>
  query("update payments set next_attempt_at = now() - interval '1 minute' where order_id = $1 and kind <> 'charge'", [id]);

describe("settleOrder", () => {
  it("pays exactly the subtotal to the farmer's payout phone and completes", async () => {
    const { orderId, farmer } = await toReleasing();
    await query("update users set payout_phone = '+256701999888' where id = $1", [farmer]);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      reference: `${orderId}-payout-1`,
      amount: 4000,
      phone: "+256701999888",
      narration: `AgriLink order ${orderId}`,
      beneficiaryName: "Farmer Fay",
    });
    const p = (await rows(orderId, "payout"))[0];
    expect(p).toMatchObject({ status: "successful", attempts: 1, reference: `${orderId}-payout-1` });
    expect(p.provider_ref).toMatch(/^fake-t-/);
    expect(await state(orderId)).toBe("completed");
  });

  it("uses the sign-in phone when there is no payout phone, and the phone as beneficiary when there is no name", async () => {
    const { orderId, farmer } = await toReleasing();
    await query("update users set name = null where id = $1", [farmer]);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    expect(spy.mock.calls[0][0]).toMatchObject({ phone: "+256771000001", beneficiaryName: "+256771000001" });
  });

  it("refund-only order (charge confirmed after cancel) is refunded to the original charge", async () => {
    const { orderId } = await toRefunding();
    expect(await state(orderId)).toBe("refunding");
    const spy = vi.spyOn(getProvider(), "refund");
    await settleOrder(orderId);
    expect(spy).toHaveBeenCalledWith({ reference: `${orderId}-refund-1`, chargeProviderRef: "flw-777", amount: 4120 });
    expect((await rows(orderId, "refund"))[0].status).toBe("successful");
    expect(await state(orderId)).toBe("refunded");
  });

  it("a split pays F and refunds the rest, then completes with both rows successful", async () => {
    const o = await toDelivered();
    await applyEvent(o.orderId, { type: "buyer_disputed", note: "x" }, { kind: "buyer", userId: o.buyer });
    const r = await applyEvent(o.orderId, { type: "admin_resolve", decision: "split", farmerAmount: 1500 }, ADMIN);
    expect(r.ok).toBe(true);
    await settleOrder(o.orderId);
    expect((await rows(o.orderId, "payout"))[0]).toMatchObject({ status: "successful", amount: "1500" });
    expect((await rows(o.orderId, "refund"))[0]).toMatchObject({ status: "successful", amount: "2575" });
    expect(await state(o.orderId)).toBe("completed");
  });

  it("never touches the charge row", async () => {
    const { orderId } = await toReleasing();
    const before = (await rows(orderId, "charge"))[0];
    await settleOrder(orderId);
    expect((await rows(orderId, "charge"))[0]).toEqual(before);
  });

  it("transfer fails twice then succeeds: 3 attempts with distinct references, completed", async () => {
    const { orderId } = await toReleasing();
    failTransfers(2);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "retry_due", attempts: 1 });
    expect(await state(orderId)).toBe("releasing");
    await settleOrder(orderId); // not due yet: nothing happens
    expect(spy).toHaveBeenCalledTimes(1);
    await backdate(orderId);
    await settleOrder(orderId);
    await backdate(orderId);
    await settleOrder(orderId);
    expect(spy.mock.calls.map((c) => c[0].reference)).toEqual([
      `${orderId}-payout-1`,
      `${orderId}-payout-2`,
      `${orderId}-payout-3`,
    ]);
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "successful", attempts: 3 });
    expect(await state(orderId)).toBe("completed");
  });

  it("fails three times: stuck, order stays releasing, no fourth attempt", async () => {
    const { orderId } = await toReleasing();
    failTransfers(10);
    const spy = vi.spyOn(getProvider(), "transfer");
    for (let i = 0; i < 4; i++) {
      await settleOrder(orderId);
      await backdate(orderId);
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "stuck", attempts: 3 });
    expect(await state(orderId)).toBe("releasing");
  });

  it("a thrown provider error is a failed attempt and settleOrder does not throw", async () => {
    const { orderId } = await toReleasing();
    vi.spyOn(getProvider(), "transfer").mockRejectedValueOnce(new Error("network down"));
    await expect(settleOrder(orderId)).resolves.toBeUndefined();
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "retry_due", attempts: 1 });
  });

  it("a farmer with no usable payout phone is stuck immediately with a reason", async () => {
    const { orderId, farmer } = await toReleasing();
    await query("alter table users drop constraint users_phone_check");
    await query("update users set phone = 'junk' where id = $1", [farmer]);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    expect(spy).not.toHaveBeenCalled();
    const p = (await rows(orderId, "payout"))[0];
    expect(p.status).toBe("stuck");
    expect(JSON.stringify(p.raw)).toMatch(/phone/);
    expect(await state(orderId)).toBe("releasing");
  });

  it("a refund whose charge has no provider_ref is stuck immediately", async () => {
    const { orderId } = await toRefunding();
    await query("update payments set provider_ref = null where order_id = $1 and kind = 'charge'", [orderId]);
    const spy = vi.spyOn(getProvider(), "refund");
    await settleOrder(orderId);
    expect(spy).not.toHaveBeenCalled();
    expect((await rows(orderId, "refund"))[0].status).toBe("stuck");
    expect(await state(orderId)).toBe("refunding");
  });

  it("two concurrent settleOrder calls make exactly one transfer", async () => {
    const { orderId } = await toReleasing();
    const spy = vi.spyOn(getProvider(), "transfer");
    await Promise.all([settleOrder(orderId), settleOrder(orderId), settleOrder(orderId)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await state(orderId)).toBe("completed");
  });

  it("transfer pending, then verifyTransfer says successful: no second transfer, completed", async () => {
    const { orderId } = await toReleasing();
    pendingTransfers(1);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(await state(orderId)).toBe("releasing");
    // Still pending at the provider: not sent again.
    await backdate(orderId);
    await settleOrder(orderId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "pending", attempts: 1 });
    // Now it lands.
    completeTransfer(`${orderId}-payout-1`, "successful");
    await backdate(orderId);
    await settleOrder(orderId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await rows(orderId, "payout"))[0]).toMatchObject({ status: "successful", attempts: 1 });
    expect(await state(orderId)).toBe("completed");
  });

  it("a pending transfer that later turns out failed is retried under a new reference", async () => {
    const { orderId } = await toReleasing();
    pendingTransfers(1);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    completeTransfer(`${orderId}-payout-1`, "failed");
    await backdate(orderId);
    await settleOrder(orderId);
    expect(spy.mock.calls.map((c) => c[0].reference)).toEqual([`${orderId}-payout-1`, `${orderId}-payout-2`]);
    expect(await state(orderId)).toBe("completed");
  });

  it("settling an already completed order does nothing", async () => {
    const { orderId } = await toReleasing();
    await settleOrder(orderId);
    const spy = vi.spyOn(getProvider(), "transfer");
    await settleOrder(orderId);
    expect(spy).not.toHaveBeenCalled();
    expect(await state(orderId)).toBe("completed");
  });
});

describe("settleDue", () => {
  it("settles every order with eligible rows and returns how many", async () => {
    const a = await toReleasing();
    expect(await settleDue()).toBe(1);
    expect(await state(a.orderId)).toBe("completed");
    expect(await settleDue()).toBe(0);
  });
});
