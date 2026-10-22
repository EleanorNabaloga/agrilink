import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "./helpers/db";
import { query } from "@/lib/db";
import { createSessionCookie } from "@/lib/auth/session";
import { GET, POST } from "@/app/api/listings/route";
import { createListing } from "@/lib/listings";

beforeAll(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-chars-long");
});
beforeEach(resetDb);

async function makeUser(role: string | null, phone: string, extra: { name?: string; language?: string } = {}) {
  const r = await query<{ id: string }>(
    "insert into users (phone, role, name, language) values ($1, $2, $3, $4) returning id::text as id",
    [phone, role, extra.name ?? null, extra.language ?? "en"],
  );
  return r.rows[0].id;
}
const cookieFor = async (id: string) => (await createSessionCookie(id)).split(";")[0];
const productId = async (en: string) =>
  (await query<{ id: string }>("select id::text as id from products where name_en = $1", [en])).rows[0].id;
const firstProduct = async () =>
  (await query<{ id: string; unit: string }>("select id::text as id, units[1] as unit from products order by id limit 1")).rows[0];

const post = (cookie: string | undefined, body: unknown) =>
  POST(new Request("http://x/api/listings", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }) as any);
const get = (qs = "", headers: Record<string, string> = {}) =>
  GET(new Request(`http://x/api/listings${qs}`, { headers }) as any);

async function farmerCookie() {
  return cookieFor(await makeUser("farmer", "+256771000001", { name: "Amina" }));
}

describe("POST /api/listings", () => {
  it("lets a farmer post", async () => {
    const p = await firstProduct();
    const res = await post(await farmerCookie(), {
      productId: p.id, quantity: 100, unit: p.unit, pricePerUnit: 2500, district: " Mbale ", description: "Fresh",
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(typeof id).toBe("string");
    const { rows } = await query("select * from listings where id = $1", [id]);
    expect(rows[0]).toMatchObject({ quantity_available: 100, district: "Mbale", status: "active", photo: null });
    expect(String(rows[0].posted_by)).toBe(String(rows[0].farmer_id));
  });

  it("refuses a buyer (403) and signed-out (401)", async () => {
    const p = await firstProduct();
    const body = { productId: p.id, quantity: 1, unit: p.unit, pricePerUnit: 100, district: "Mbale" };
    const buyer = await cookieFor(await makeUser("buyer", "+256771000002"));
    expect((await post(buyer, body)).status).toBe(403);
    expect((await post(undefined, body)).status).toBe(401);
  });

  it("refuses bad input with 400 and a translated key", async () => {
    const p = await firstProduct();
    const c = await farmerCookie();
    const ok = { productId: p.id, quantity: 5, unit: p.unit, pricePerUnit: 100, district: "Mbale" };
    const bads: [object, string][] = [
      [{ ...ok, unit: "furlong" }, "listing.err.unit"],
      [{ ...ok, productId: "999999" }, "listing.err.product"],
      [{ ...ok, quantity: 0 }, "listing.err.quantity"],
      [{ ...ok, quantity: 1.5 }, "listing.err.quantity"],
      [{ ...ok, pricePerUnit: -1 }, "listing.err.price"],
      [{ ...ok, district: "x" }, "listing.err.district"],
      [{ ...ok, description: "a".repeat(501) }, "listing.err.description"],
    ];
    for (const [b, key] of bads) {
      const res = await post(c, b);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(key);
    }
    expect((await query("select 1 from listings")).rows).toHaveLength(0);
  });

  const form = async (p: { id: string; unit: string }) => {
    const fd = new FormData();
    const fields = { productId: p.id, quantity: "5", unit: p.unit, pricePerUnit: "100", district: "Mbale" };
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it("refuses a non-image photo upload", async () => {
    const fd = await form(await firstProduct());
    fd.set("photo", new File(["hello"], "a.txt", { type: "text/plain" }));
    const res = await POST(new Request("http://x/api/listings", { method: "POST", headers: { cookie: await farmerCookie() }, body: fd }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("listing.err.photo");
  });

  it("accepts a multipart post without a photo", async () => {
    const fd = await form(await firstProduct());
    const res = await POST(new Request("http://x/api/listings", { method: "POST", headers: { cookie: await farmerCookie() }, body: fd }) as any);
    expect(res.status).toBe(201);
  });
});

describe("GET /api/listings", () => {
  async function seed() {
    const farmer = await makeUser("farmer", "+256771000001", { name: "Amina" });
    const maize = await productId("Maize");
    const beans = await productId("Beans");
    const unit = async (id: string) => (await query<{ u: string }>("select units[1] as u from products where id = $1", [id])).rows[0].u;
    const mk = async (pid: string, district: string, qty = 10) =>
      createListing(farmer, { productId: pid, quantity: qty, unit: await unit(pid), pricePerUnit: 1000, district }, farmer);
    return { farmer, maize, beans, mk };
  }

  it("is public and never exposes phone numbers", async () => {
    const { mk } = await seed();
    await mk(await productId("Maize"), "Mbale");
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("+256");
    expect(text).not.toContain("phone");
    expect(body.listings[0]).toMatchObject({ productName: "Maize", farmerName: "Amina", district: "Mbale", quantity: 10, pricePerUnit: 1000 });
    expect(Object.keys(body.listings[0])).toEqual(expect.arrayContaining(
      ["id", "productId", "productName", "quantity", "unit", "pricePerUnit", "district", "description", "photo", "farmerName", "createdAt"]));
  });

  it("filters by product and district (case-insensitive), alone and combined", async () => {
    const { mk, maize, beans } = await seed();
    await mk(maize, "Mbale");
    await mk(maize, "Gulu");
    await mk(beans, "Mbale");
    const names = async (qs: string) => (await (await get(qs)).json()).listings.map((l: any) => `${l.productName}/${l.district}`).sort();
    expect(await names("")).toHaveLength(3);
    expect(await names(`?product=${maize}`)).toEqual(["Maize/Gulu", "Maize/Mbale"]);
    expect(await names("?district=mbale")).toEqual(["Beans/Mbale", "Maize/Mbale"]);
    expect(await names(`?product=${beans}&district=MBALE`)).toEqual(["Beans/Mbale"]);
    expect(await names(`?product=${beans}&district=Gulu`)).toEqual([]);
  });

  it("hides sold-out, withdrawn and zero-quantity listings; newest first", async () => {
    const { mk, maize } = await seed();
    const a = await mk(maize, "A1");
    const b = await mk(maize, "B1");
    const c = await mk(maize, "C1");
    const d = await mk(maize, "D1");
    const e = await mk(maize, "E1");
    await query("update listings set status = 'sold_out' where id = $1", [b]);
    await query("update listings set status = 'withdrawn' where id = $1", [c]);
    await query("update listings set quantity_available = 0 where id = $1", [d]);
    await query("update listings set created_at = now() - interval '1 day' where id = $1", [a]);
    const { listings } = await (await get()).json();
    expect(listings.map((l: any) => l.id)).toEqual([e, a]);
  });

  it("caps at 50", async () => {
    const { mk, maize } = await seed();
    for (let i = 0; i < 52; i++) await mk(maize, "Mbale");
    expect((await (await get()).json()).listings).toHaveLength(50);
  });

  it("returns product names in the reader's language", async () => {
    const { mk, maize } = await seed();
    await mk(maize, "Mbale");
    const name = async (col: string) => (await query<{ n: string }>(`select ${col} as n from products where id = $1`, [maize])).rows[0].n;
    const lgUser = await cookieFor(await makeUser("buyer", "+256771000009", { language: "lg" }));
    expect((await (await get("", { cookie: lgUser })).json()).listings[0].productName).toBe(await name("name_lg"));
    expect((await (await get("", { "accept-language": "sw-KE,sw;q=0.9" })).json()).listings[0].productName).toBe(await name("name_sw"));
    expect((await (await get("", { cookie: "lang=lg" })).json()).listings[0].productName).toBe(await name("name_lg"));
    expect((await (await get()).json()).listings[0].productName).toBe("Maize");
  });
});
