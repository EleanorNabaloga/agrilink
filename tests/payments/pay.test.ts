import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../helpers/db";
import { query } from "@/lib/db";
import { createSessionCookie } from "@/lib/auth/session";
import { applyEvent, createOrder } from "@/lib/orders/apply";
import { createListing } from "@/lib/listings";
import { POST as pay } from "@/app/api/orders/[id]/pay/route";
import { POST as webhook } from "@/app/api/webhooks/flutterwave/route";
import { confirmCharge, getProvider } from "@/lib/payments";
import { completeCharge, resetFake, setNextCharge } from "@/lib/payments/fake";

const HASH = "test-webhook-hash-1234";

beforeAll(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-chars-long");
  vi.stubEnv("FLW_WEBHOOK_HASH", HASH);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetFake();
  await resetDb();
});

async function makeUser(role: string, phone: string) {
  const r = await query<{ id: string }>(
    "insert into users (phone, role, name) values ($1, $2, 'T') returning id::text as id",
    [phone, role],
  );
  return r.rows[0].id;
}
async function newOrder(buyerPhone = "+256771000002", qty = 4) {
  const farmer = await makeUser("farmer", "+256771000001");
  const buyer = await makeUser("buyer", buyerPhone);
  const p = (await query<{ id: string; unit: string }>("select id::text as id, units[1] as unit from products order by id limit 1")).rows[0];
  const listing = await createListing(farmer, { productId: p.id, quantity: 10, unit: p.unit, pricePerUnit: 1000, district: "Mbale" }, farmer);
  const r = await createOrder(buyer, listing, qty);
  if (!r.ok) throw new Error("setup");
  return { farmer, buyer, orderId: r.orderId, listing };
}
const state = async (id: string) => (await query("select state from orders where id = $1", [id])).rows[0].state as string;
const charge = async (id: string) => (await query("select * from payments where order_id = $1 and kind = 'charge'", [id])).rows[0];
const payments = async (id: string, kind: string) => (await query("select * from payments where order_id = $1 and kind = $2", [id, kind])).rows;
const cookieFor = async (id: string) => (await createSessionCookie(id)).split(";")[0];

async function doPay(buyer: string, orderId: string, body: unknown = {}) {
  return pay(
    new Request(`http://x/api/orders/${orderId}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor(buyer) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orderId }) },
  );
}
const hook = (body: unknown, hash: string | null = HASH) =>
  webhook(
    new Request("http://x/api/webhooks/flutterwave", {
      method: "POST",
      headers: { "content-type": "application/json", ...(hash ? { "verif-hash": hash } : {}) },
      body: JSON.stringify(body),
    }),
  );
const evt = (orderId: string) => ({ event: "charge.completed", data: { tx_ref: `${orderId}-charge`, status: "successful", amount: 1 } });

describe("POST /api/orders/[id]/pay", () => {
  it("moves to awaiting_payment and records a pending charge row for the full total", async () => {
    const { buyer, orderId } = await newOrder();
    const res = await doPay(buyer, orderId);
    expect(res.status).toBe(200);
    expect(await state(orderId)).toBe("awaiting_payment");
    const c = await charge(orderId);
    expect(c).toMatchObject({ reference: `${orderId}-charge`, amount: "4120", status: "pending" });
    expect(c.provider_ref).toMatch(/^fake-/);
  });

  it("charges an Airtel number with network AIRTEL", async () => {
    const { buyer, orderId } = await newOrder("+256701000003");
    const spy = vi.spyOn(getProvider(), "startCharge");
    expect((await doPay(buyer, orderId)).status).toBe(200);
    expect(spy).toHaveBeenCalledWith({
      reference: `${orderId}-charge`,
      amount: 4120,
      phone: "+256701000003",
      network: "AIRTEL",
      email: "256701000003@buyers.agrilink.ug",
    });
  });

  it("rejects an unsupported network with 400 and changes nothing", async () => {
    const { buyer, orderId } = await newOrder("+256411000003");
    const res = await doPay(buyer, orderId);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pay.err.network");
    expect(await state(orderId)).toBe("ordered");
    expect(await charge(orderId)).toBeUndefined();
  });

  it("a declined charge cancels the order and returns 409", async () => {
    const { buyer, orderId, listing } = await newOrder();
    setNextCharge("failed");
    const res = await doPay(buyer, orderId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("pay.err.failed");
    expect(await state(orderId)).toBe("cancelled");
    expect((await query("select quantity_available from listings where id = $1", [listing])).rows[0].quantity_available).toBe(10);
  });

  it("a network error leaves the order awaiting_payment and returns 502", async () => {
    const { buyer, orderId } = await newOrder();
    setNextCharge("throw");
    const res = await doPay(buyer, orderId);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("pay.err.unreachable");
    expect(await state(orderId)).toBe("awaiting_payment");
    expect((await charge(orderId)).provider_ref).toBeNull();
  });

  it("another buyer cannot pay for the order", async () => {
    const { orderId } = await newOrder();
    const other = await makeUser("buyer", "+256771000009");
    expect((await doPay(other, orderId)).status).toBe(404);
    expect(await state(orderId)).toBe("ordered");
  });

  it("paying twice is refused and a replayed actionId does not charge again", async () => {
    const { buyer, orderId } = await newOrder();
    const spy = vi.spyOn(getProvider(), "startCharge");
    expect((await doPay(buyer, orderId, { actionId: "a-1" })).status).toBe(200);
    expect((await doPay(buyer, orderId, { actionId: "a-1" })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await doPay(buyer, orderId)).status).toBe(409);
    expect(await payments(orderId, "charge")).toHaveLength(1);
  });
});

describe("POST /api/webhooks/flutterwave", () => {
  async function paying() {
    const o = await newOrder();
    await doPay(o.buyer, o.orderId);
    return o;
  }

  it("rejects a wrong hash with 401 and changes nothing", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`);
    expect((await hook(evt(orderId), "wrong-hash-of-same-len")).status).toBe(401);
    expect((await hook(evt(orderId), "short")).status).toBe(401);
    expect((await hook(evt(orderId), null)).status).toBe(401);
    expect(await state(orderId)).toBe("awaiting_payment");
  });

  it("rejects everything when FLW_WEBHOOK_HASH is not set", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`);
    vi.stubEnv("FLW_WEBHOOK_HASH", "");
    expect((await hook(evt(orderId), "")).status).toBe(401);
    expect((await hook(evt(orderId))).status).toBe(401);
    vi.stubEnv("FLW_WEBHOOK_HASH", HASH);
    expect(await state(orderId)).toBe("awaiting_payment");
  });

  it("confirms a verified charge: paid, charge row successful with raw", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`);
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("paid");
    const c = await charge(orderId);
    expect(c.status).toBe("successful");
    expect(c.raw.verify.amount).toBe(4120);
  });

  it("ignores the body's claimed status: unverified (pending) charge changes nothing", async () => {
    const { orderId } = await paying();
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("awaiting_payment");
    expect((await charge(orderId)).status).toBe("pending");
  });

  it("wrong amount: order stays awaiting_payment, charge row stuck", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`, { amount: 100 });
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("awaiting_payment");
    const c = await charge(orderId);
    expect(c.status).toBe("stuck");
    expect(c.raw.verify.amount).toBe(100);
  });

  it("wrong currency: not confirmed, charge row stuck", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`, { currency: "KES" });
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("awaiting_payment");
    expect((await charge(orderId)).status).toBe("stuck");
  });

  it("a tx_ref naming another order, with a wrong amount, cannot confirm either order", async () => {
    const a = await paying();
    const farmer2 = a.farmer;
    const buyer2 = await makeUser("buyer", "+256771000010");
    const r = await createOrder(buyer2, a.listing, 1);
    if (!r.ok) throw new Error("setup");
    await doPay(buyer2, r.orderId);
    // Order B's charge succeeded for B's total, but the webhook names order A.
    completeCharge(`${r.orderId}-charge`);
    completeCharge(`${a.orderId}-charge`, { amount: 1030 });
    expect((await hook(evt(a.orderId))).status).toBe(200);
    expect(await state(a.orderId)).toBe("awaiting_payment");
    expect(await state(r.orderId)).toBe("awaiting_payment");
    expect(farmer2).toBeTruthy();
  });

  it("ignores an unrecognised or unknown tx_ref with 200", async () => {
    const { orderId } = await paying();
    for (const tx_ref of ["garbage", "999999-charge", "1-payout", `${orderId}-charge-x`]) {
      expect((await hook({ data: { tx_ref } })).status).toBe(200);
    }
    expect((await hook({})).status).toBe(200);
    expect(await state(orderId)).toBe("awaiting_payment");
  });

  it("a verified failure cancels the order", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`, { status: "failed" });
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("cancelled");
  });

  it("is idempotent: a replayed webhook changes nothing", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`);
    expect((await hook(evt(orderId))).status).toBe(200);
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("paid");
    const ev = await query("select * from order_events where order_id = $1 and to_state = 'paid'", [orderId]);
    expect(ev.rows).toHaveLength(1);
  });

  it("a webhook after the payment window cancelled the order moves it to refunding with a full refund", async () => {
    const { orderId } = await paying();
    await query("update orders set deadline_at = now() - interval '1 minute' where id = $1", [orderId]);
    expect((await applyEvent(orderId, { type: "payment_timeout" }, { kind: "system" })).ok).toBe(true);
    expect(await state(orderId)).toBe("cancelled");
    completeCharge(`${orderId}-charge`);
    expect((await hook(evt(orderId))).status).toBe(200);
    expect(await state(orderId)).toBe("refunding");
    const refunds = await payments(orderId, "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe("4120");
    expect((await charge(orderId)).status).toBe("successful");
  });

  it("concurrent webhooks and confirmCharge make exactly one paid transition", async () => {
    const { orderId } = await paying();
    completeCharge(`${orderId}-charge`);
    const results = await Promise.all([
      confirmCharge(orderId),
      confirmCharge(orderId),
      hook(evt(orderId)).then((r) => r.status),
      confirmCharge(orderId),
    ]);
    expect(results.filter((r) => r === "confirmed")).toHaveLength(1);
    expect(await state(orderId)).toBe("paid");
    const ev = await query("select * from order_events where order_id = $1 and to_state = 'paid'", [orderId]);
    expect(ev.rows).toHaveLength(1);
  });
});
