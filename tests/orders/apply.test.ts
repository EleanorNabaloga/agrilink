import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../helpers/db";
import { query, withTransaction } from "@/lib/db";
import { createSessionCookie } from "@/lib/auth/session";
import { applyEvent, createOrder } from "@/lib/orders/apply";
import { withAction } from "@/lib/actions";
import { createListing } from "@/lib/listings";
import { POST } from "@/app/api/orders/route";
import * as notify from "@/lib/notify";

beforeAll(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-chars-long");
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

async function makeUser(role: string, phone: string) {
  const r = await query<{ id: string }>(
    "insert into users (phone, role, name) values ($1, $2, 'T') returning id::text as id",
    [phone, role],
  );
  return r.rows[0].id;
}
async function seed(qty = 10) {
  const farmer = await makeUser("farmer", "+256771000001");
  const buyer = await makeUser("buyer", "+256771000002");
  const p = (await query<{ id: string; unit: string }>("select id::text as id, units[1] as unit from products order by id limit 1")).rows[0];
  const listing = await createListing(farmer, { productId: p.id, quantity: qty, unit: p.unit, pricePerUnit: 1000, district: "Mbale" }, farmer);
  return { farmer, buyer, listing };
}
const listingRow = async (id: string) =>
  (await query("select quantity_available, status from listings where id = $1", [id])).rows[0];
const events = async (orderId: string) =>
  (await query("select * from order_events where order_id = $1 order by id", [orderId])).rows;

const BUYER = (id: string) => ({ kind: "buyer" as const, userId: id });
const FARMER = (id: string) => ({ kind: "farmer" as const, userId: id });
const SYSTEM = { kind: "system" as const };

async function newOrder(qty = 4) {
  const s = await seed();
  const r = await createOrder(s.buyer, s.listing, qty);
  if (!r.ok) throw new Error("setup");
  return { ...s, orderId: r.orderId };
}

describe("createOrder", () => {
  it("reserves stock, stores amounts and a payment deadline", async () => {
    const { buyer, listing } = await seed();
    const before = Date.now();
    const r = await createOrder(buyer, listing, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = (await query("select * from orders where id = $1", [r.orderId])).rows[0];
    expect(o).toMatchObject({ state: "ordered", quantity: 4, unit_price: "1000", subtotal: "4000", commission: "120", total: "4120" });
    expect(Number(o.commission_percent)).toBe(3);
    const mins = (new Date(o.deadline_at).getTime() - before) / 60_000;
    expect(mins).toBeGreaterThan(29);
    expect(mins).toBeLessThan(31);
    expect(await listingRow(listing)).toMatchObject({ quantity_available: 6, status: "active" });
  });

  it("refuses own listing, too much, and unavailable listings", async () => {
    const { farmer, buyer, listing } = await seed();
    expect(await createOrder(farmer, listing, 1)).toEqual({ ok: false, reason: "own_listing" });
    expect(await createOrder(buyer, listing, 11)).toEqual({ ok: false, reason: "not_enough" });
    await query("update listings set status = 'withdrawn' where id = $1", [listing]);
    expect(await createOrder(buyer, listing, 1)).toEqual({ ok: false, reason: "listing_unavailable" });
    await query("update listings set status = 'sold_out' where id = $1", [listing]);
    expect(await createOrder(buyer, listing, 1)).toEqual({ ok: false, reason: "listing_unavailable" });
    expect((await query("select 1 from orders")).rows).toHaveLength(0);
  });

  it("marks the listing sold_out when the last bag goes", async () => {
    const { buyer, listing } = await seed();
    expect((await createOrder(buyer, listing, 10)).ok).toBe(true);
    expect(await listingRow(listing)).toMatchObject({ quantity_available: 0, status: "sold_out" });
  });

  it("two concurrent orders for the last 10 bags: one wins, one not_enough", async () => {
    for (let run = 0; run < 3; run++) {
      await resetDb();
      const { buyer, listing } = await seed();
      const results = await Promise.all([createOrder(buyer, listing, 10), createOrder(buyer, listing, 10)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "not_enough")).toHaveLength(1);
      expect(await listingRow(listing)).toMatchObject({ quantity_available: 0, status: "sold_out" });
      expect((await query("select 1 from orders")).rows).toHaveLength(1);
    }
  });
});

describe("applyEvent", () => {
  it("applies an allowed event: state, deadline, history, notify", async () => {
    const { orderId, buyer } = await newOrder();
    const spy = vi.spyOn(notify, "notifyOrderEvent");
    const r = await applyEvent(orderId, { type: "start_payment" }, BUYER(buyer));
    expect(r).toEqual({ ok: true, state: "awaiting_payment", effects: [] });
    const o = (await query("select state, deadline_at from orders where id = $1", [orderId])).rows[0];
    expect(o.state).toBe("awaiting_payment");
    expect(o.deadline_at).not.toBeNull();
    const ev = await events(orderId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_state: "ordered", to_state: "awaiting_payment", actor: buyer });
    expect(spy).toHaveBeenCalledWith(orderId, "awaiting_payment");
  });

  it("changes nothing when refused, and does not notify", async () => {
    const { orderId, buyer } = await newOrder();
    const spy = vi.spyOn(notify, "notifyOrderEvent");
    const before = (await query("select * from orders where id = $1", [orderId])).rows[0];
    expect(await applyEvent(orderId, { type: "buyer_confirmed" }, BUYER(buyer))).toEqual({ ok: false, reason: "not_allowed" });
    expect(await applyEvent(orderId, { type: "start_payment" }, SYSTEM)).toEqual({ ok: false, reason: "wrong_actor" });
    expect((await query("select * from orders where id = $1", [orderId])).rows[0]).toEqual(before);
    expect(await events(orderId)).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing order", async () => {
    expect(await applyEvent("999999", { type: "start_payment" }, SYSTEM)).toEqual({ ok: false, reason: "not_found" });
    expect(await applyEvent("abc", { type: "start_payment" }, SYSTEM)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a notify failure never undoes the change", async () => {
    const { orderId, buyer } = await newOrder();
    vi.spyOn(notify, "notifyOrderEvent").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await applyEvent(orderId, { type: "start_payment" }, BUYER(buyer));
    expect(r.ok).toBe(true);
    expect((await query("select state from orders where id = $1", [orderId])).rows[0].state).toBe("awaiting_payment");
  });

  it("with opts.tx it uses the caller's transaction and does not notify", async () => {
    const { orderId, buyer } = await newOrder();
    const spy = vi.spyOn(notify, "notifyOrderEvent");
    await expect(
      withTransaction(async (tx) => {
        const r = await applyEvent(orderId, { type: "start_payment" }, BUYER(buyer), { tx });
        expect(r.ok).toBe(true);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await query("select state from orders where id = $1", [orderId])).rows[0].state).toBe("ordered");
    expect(await events(orderId)).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("release_stock returns the quantity and revives only sold_out listings", async () => {
    const { buyer, listing } = await seed();
    const r = await createOrder(buyer, listing, 10);
    if (!r.ok) throw new Error("setup");
    expect(await listingRow(listing)).toMatchObject({ quantity_available: 0, status: "sold_out" });
    await applyEvent(r.orderId, { type: "start_payment" }, BUYER(buyer));
    const out = await applyEvent(r.orderId, { type: "charge_failed" }, SYSTEM);
    expect(out).toEqual({ ok: true, state: "cancelled", effects: [{ kind: "release_stock" }] });
    expect(await listingRow(listing)).toMatchObject({ quantity_available: 10, status: "active" });

    // a withdrawn listing is never revived
    const r2 = await createOrder(buyer, listing, 3);
    if (!r2.ok) throw new Error("setup");
    await query("update listings set status = 'withdrawn' where id = $1", [listing]);
    await applyEvent(r2.orderId, { type: "start_payment" }, BUYER(buyer));
    await applyEvent(r2.orderId, { type: "charge_failed" }, SYSTEM);
    expect(await listingRow(listing)).toMatchObject({ quantity_available: 10, status: "withdrawn" });
  });

  it("writes transporter details, dispute note and payment rows", async () => {
    const { orderId, buyer, farmer } = await newOrder();
    const ok = async (e: any, a: any) => expect((await applyEvent(orderId, e, a)).ok).toBe(true);
    await ok({ type: "start_payment" }, BUYER(buyer));
    await ok({ type: "charge_confirmed" }, SYSTEM);
    await ok({ type: "farmer_sent", transporterName: "Moses", transporterPhone: "+256700000001" }, FARMER(farmer));
    expect((await query("select transporter_name n, transporter_phone p from orders where id = $1", [orderId])).rows[0]).toEqual({ n: "Moses", p: "+256700000001" });
    await ok({ type: "farmer_delivered" }, FARMER(farmer));
    await ok({ type: "buyer_disputed", note: "Rotten" }, BUYER(buyer));
    expect((await events(orderId)).at(-1)).toMatchObject({ to_state: "disputed", note: "Rotten" });
    const admin = await makeUser("admin", "+256771000009");
    const res = await applyEvent(orderId, { type: "admin_resolve", decision: "split", farmerAmount: 3000 }, { kind: "admin", userId: admin });
    expect(res).toMatchObject({ ok: true, state: "releasing" });
    const eff = (res as any).effects as { kind: string; amount: number }[];
    const refund = eff.find((e) => e.kind === "refund")!.amount;
    expect(eff.find((e) => e.kind === "payout")!.amount).toBe(3000);
    const pays = (await query("select kind, amount::int a, reference, status from payments where order_id = $1 order by kind", [orderId])).rows;
    expect(pays).toEqual([
      { kind: "payout", a: 3000, reference: `${orderId}-payout-1`, status: "pending" },
      { kind: "refund", a: refund, reference: `${orderId}-refund-1`, status: "pending" },
    ]);
  });

  it("fails the transaction if a payment reference already exists", async () => {
    const { orderId, buyer, farmer } = await newOrder();
    await applyEvent(orderId, { type: "start_payment" }, BUYER(buyer));
    await applyEvent(orderId, { type: "charge_confirmed" }, SYSTEM);
    await applyEvent(orderId, { type: "farmer_sent" }, FARMER(farmer));
    await applyEvent(orderId, { type: "farmer_delivered" }, FARMER(farmer));
    await query("insert into payments (order_id, kind, amount, reference) values ($1, 'payout', 1, $2)", [orderId, `${orderId}-payout-1`]);
    await expect(applyEvent(orderId, { type: "buyer_confirmed" }, BUYER(buyer))).rejects.toThrow();
    expect((await query("select state from orders where id = $1", [orderId])).rows[0].state).toBe("delivered");
    expect(await events(orderId)).toHaveLength(4);
  });

  it("20 concurrent charge_confirmed: exactly one wins, one history row", async () => {
    for (let run = 0; run < 3; run++) {
      await resetDb();
      const { orderId, buyer } = await newOrder();
      await applyEvent(orderId, { type: "start_payment" }, BUYER(buyer));
      const results = await Promise.all(Array.from({ length: 20 }, () => applyEvent(orderId, { type: "charge_confirmed" }, SYSTEM)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "not_allowed")).toHaveLength(19);
      expect((await query("select state from orders where id = $1", [orderId])).rows[0].state).toBe("paid");
      expect((await events(orderId)).filter((e) => e.to_state === "paid")).toHaveLength(1);
    }
  });
});

describe("withAction", () => {
  it("runs fn directly without an actionId", async () => {
    const fn = vi.fn(async () => 1);
    await withAction(undefined, "1", "x", fn);
    await withAction(undefined, "1", "x", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns the first result for a repeated actionId, even concurrently", async () => {
    const u = await makeUser("buyer", "+256771000003");
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { n: fn.mock.calls.length };
    });
    const rs = await Promise.all([1, 2, 3].map(() => withAction("a-1", u, "x", fn)));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(rs).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
    expect(await withAction("a-1", u, "x", fn)).toEqual({ n: 1 });
  });

  it("refuses another user's actionId with 409 and does not leak the result", async () => {
    const u1 = await makeUser("buyer", "+256771000003");
    const u2 = await makeUser("buyer", "+256771000004");
    await withAction("a-2", u1, "x", async () => ({ secret: 1 }));
    await expect(withAction("a-2", u2, "x", async () => ({ other: 1 }))).rejects.toMatchObject({ status: 409 });
  });

  it("does not store a result when fn throws, so a retry runs again", async () => {
    const u = await makeUser("buyer", "+256771000003");
    await expect(withAction("a-3", u, "x", async () => { throw new Error("no"); })).rejects.toThrow("no");
    expect(await withAction("a-3", u, "x", async () => "ok")).toBe("ok");
  });
});

describe("POST /api/orders", () => {
  const post = (cookie: string | undefined, body: unknown) =>
    POST(new Request("http://x/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }) as any);
  const cookieFor = async (id: string) => (await createSessionCookie(id)).split(";")[0];

  it("creates an order (201) and rejects bad input, wrong role, signed out", async () => {
    const { buyer, farmer, listing } = await seed();
    const c = await cookieFor(buyer);
    const res = await post(c, { listingId: listing, quantity: 2 });
    expect(res.status).toBe(201);
    expect(typeof (await res.json()).orderId).toBe("string");
    expect((await post(c, { listingId: listing, quantity: 0 })).status).toBe(400);
    expect((await post(c, { listingId: listing, quantity: 1.5 })).status).toBe(400);
    expect((await post(c, { quantity: 1 })).status).toBe(400);
    expect((await post(await cookieFor(farmer), { listingId: listing, quantity: 1 })).status).toBe(403);
    expect((await post(undefined, { listingId: listing, quantity: 1 })).status).toBe(401);
  });

  it("maps refusals to 409 with translated keys", async () => {
    const { buyer, listing } = await seed();
    const c = await cookieFor(buyer);
    const res = await post(c, { listingId: listing, quantity: 11 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("order.err.not_enough");
    expect((await (await post(c, { listingId: "999999", quantity: 1 })).json()).error).toBe("order.err.listing_unavailable");
    expect((await post(c, { listingId: "abc", quantity: 1 })).status).toBe(400);
  });

  it("two concurrent POSTs with the same actionId create one order", async () => {
    for (let run = 0; run < 3; run++) {
      await resetDb();
      const { buyer, listing } = await seed();
      const c = await cookieFor(buyer);
      const body = { listingId: listing, quantity: 2, actionId: "act-1" };
      const [a, b] = await Promise.all([post(c, body), post(c, body)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect((await a.json()).orderId).toBe((await b.json()).orderId);
      expect((await query("select 1 from orders")).rows).toHaveLength(1);
      expect(await listingRow(listing)).toMatchObject({ quantity_available: 8 });
    }
  });
});
