import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { resetDb } from "./helpers/db";
import { query } from "@/lib/db";
import { fakeSmsOutbox, clearFakeSms } from "@/lib/sms/fake";
import { requestOtp, verifyOtp } from "@/lib/auth/otp";
import { createSessionCookie, getUser } from "@/lib/auth/session";
import { requireUser, HttpError } from "@/lib/auth/guard";
import { PATCH } from "@/app/api/me/route";
import { POST as verifyRoute } from "@/app/api/auth/verify/route";

const PHONE = "+256771234567";

beforeAll(() => {
  vi.stubEnv("OTP_SECRET", "test-otp-secret");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-chars-long");
});

beforeEach(async () => {
  await resetDb();
  clearFakeSms();
});
afterEach(() => vi.useRealTimers());

const lastCode = () => /(\d{6})/.exec(fakeSmsOutbox[fakeSmsOutbox.length - 1].text)![1];
const wrong = (c: string) => (c === "000000" ? "111111" : "000000");

async function cookieFor(userId: string) {
  const setCookie = await createSessionCookie(userId);
  return setCookie.split(";")[0];
}
const reqWith = (cookie?: string) => new Request("http://x/api", { headers: cookie ? { cookie } : {} });

async function makeUser(role: string | null, phone = PHONE) {
  const r = await query<{ id: string }>(
    "insert into users (phone, role) values ($1, $2) returning id::text as id",
    [phone, role],
  );
  return r.rows[0].id;
}

describe("requestOtp", () => {
  it("rejects a bad phone", async () => {
    expect(await requestOtp("12345", "en")).toEqual({ ok: false, reason: "bad_phone" });
  });

  it("stores only an HMAC of the code", async () => {
    expect(await requestOtp("0771234567", "en")).toEqual({ ok: true });
    const code = lastCode();
    const { rows } = await query("select * from otp_codes where phone = $1", [PHONE]);
    expect(rows[0].code_hash).toBe(createHmac("sha256", "test-otp-secret").update(`${PHONE}:${code}`).digest("hex"));
    expect(JSON.stringify(rows[0])).not.toContain(code);
  });

  it("sends the SMS in the requested language", async () => {
    await requestOtp(PHONE, "lg");
    expect(fakeSmsOutbox[0].to).toBe(PHONE);
    expect(fakeSmsOutbox[0].text).toContain("Koodi ya AgriLink");
  });

  it("allows 3 codes in 15 minutes and refuses the 4th", async () => {
    for (let i = 0; i < 3; i++) expect(await requestOtp(PHONE, "en")).toEqual({ ok: true });
    expect(await requestOtp(PHONE, "en")).toEqual({ ok: false, reason: "too_many" });
    expect(fakeSmsOutbox).toHaveLength(3);
  });

  it("allows another code once the window has passed", async () => {
    for (let i = 0; i < 3; i++) await requestOtp(PHONE, "en");
    await query("update otp_requests set created_at = now() - interval '16 minutes'");
    expect(await requestOtp(PHONE, "en")).toEqual({ ok: true });
  });

  it("a new request replaces the old code", async () => {
    await requestOtp(PHONE, "en");
    const first = lastCode();
    await requestOtp(PHONE, "en");
    const second = lastCode();
    if (first !== second) expect(await verifyOtp(PHONE, first)).toMatchObject({ ok: false });
    expect(await verifyOtp(PHONE, second)).toMatchObject({ ok: true });
  });
});

describe("verifyOtp", () => {
  it("signs in with the right code, creates the user once, and uses the code once", async () => {
    await requestOtp("0771234567", "sw");
    const code = lastCode();
    const res = await verifyOtp("0771234567", code);
    expect(res).toMatchObject({ ok: true, isNew: true });
    const { rows } = await query("select * from users");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: PHONE, role: null, language: "sw", payout_phone: PHONE });
    expect(rows[0].payout_confirmed_at).not.toBeNull();
    expect(await verifyOtp(PHONE, code)).toEqual({ ok: false, reason: "expired" });

    await requestOtp(PHONE, "en");
    const again = await verifyOtp(PHONE, lastCode());
    expect(again).toMatchObject({ ok: true, isNew: true, userId: (res as any).userId });
    expect((await query("select 1 from users")).rows).toHaveLength(1);
  });

  it("the same phone in two formats is one user", async () => {
    await requestOtp("0771234567", "en");
    await verifyOtp("0771234567", lastCode());
    await requestOtp("+256 771 234 567", "en");
    await verifyOtp("256771234567", lastCode());
    expect((await query("select 1 from users")).rows).toHaveLength(1);
  });

  it("isNew is false once a role is set", async () => {
    await makeUser("farmer");
    await requestOtp(PHONE, "en");
    expect(await verifyOtp(PHONE, lastCode())).toMatchObject({ ok: true, isNew: false });
  });

  it("refuses an expired code", async () => {
    await requestOtp(PHONE, "en");
    const code = lastCode();
    await query("update otp_codes set expires_at = now() - interval '1 second'");
    expect(await verifyOtp(PHONE, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses when no code was requested or phone is bad", async () => {
    expect(await verifyOtp(PHONE, "123456")).toEqual({ ok: false, reason: "expired" });
    expect(await verifyOtp("abc", "123456")).toEqual({ ok: false, reason: "expired" });
  });

  it("locks the code after 5 wrong tries, even for the right code", async () => {
    await requestOtp(PHONE, "en");
    const code = lastCode();
    for (let i = 0; i < 5; i++) {
      expect(await verifyOtp(PHONE, wrong(code))).toEqual({ ok: false, reason: "wrong_code" });
    }
    expect(await verifyOtp(PHONE, code)).toEqual({ ok: false, reason: "too_many_tries" });
    expect((await query("select 1 from users")).rows).toHaveLength(0);
  });
});

describe("session", () => {
  it("sets a cookie with the right flags", async () => {
    const c = await createSessionCookie("7");
    expect(c).toMatch(/^al_session=[^;]+/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Max-Age=2592000/);
    expect(c).not.toMatch(/Secure/i); // NODE_ENV is "test"
    vi.stubEnv("NODE_ENV", "production");
    expect(await createSessionCookie("7")).toMatch(/Secure/i);
    vi.stubEnv("NODE_ENV", "test");
  });

  it("getUser reads the user fresh; bad tokens mean signed out", async () => {
    const id = await makeUser("farmer");
    const cookie = await cookieFor(id);
    const u = await getUser(reqWith(cookie));
    expect(u).toMatchObject({ id, phone: PHONE, role: "farmer", language: "en", name: null });
    await query("update users set language = 'lg' where id = $1", [id]);
    expect((await getUser(reqWith(cookie)))!.language).toBe("lg");
    expect(await getUser(reqWith())).toBeNull();
    expect(await getUser(reqWith("al_session=garbage"))).toBeNull();
    expect(await getUser(reqWith(cookie.slice(0, -3) + "xxx"))).toBeNull();
  });

  it("an expired token means signed out", async () => {
    const id = await makeUser("farmer");
    vi.useFakeTimers({ toFake: ["Date"] });
    const cookie = await cookieFor(id);
    vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
    expect(await getUser(reqWith(cookie))).toBeNull();
  });
});

describe("requireUser", () => {
  it("401 without a session", async () => {
    await expect(requireUser(reqWith())).rejects.toMatchObject({ status: 401 });
  });
  it("403 for the wrong role and for a user with no role yet", async () => {
    const farmer = await cookieFor(await makeUser("farmer"));
    await expect(requireUser(reqWith(farmer), ["buyer"])).rejects.toBeInstanceOf(HttpError);
    await expect(requireUser(reqWith(farmer), ["buyer"])).rejects.toMatchObject({ status: 403 });
    expect((await requireUser(reqWith(farmer), ["farmer"])).role).toBe("farmer");
    const fresh = await cookieFor(await makeUser(null, "+256772000000"));
    await expect(requireUser(reqWith(fresh), ["farmer", "buyer"])).rejects.toMatchObject({ status: 403 });
    expect((await requireUser(reqWith(fresh))).role).toBeNull();
  });
});

describe("PATCH /api/me", () => {
  const patch = (cookie: string | undefined, body: unknown) =>
    PATCH(new Request("http://x/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }) as any);

  it("sets the role once; farmer cannot become buyer", async () => {
    const cookie = await cookieFor(await makeUser(null));
    expect((await patch(cookie, { role: "farmer", name: "Amina", district: "Mbale", language: "lg" })).status).toBe(200);
    const { rows } = await query("select * from users");
    expect(rows[0]).toMatchObject({ role: "farmer", name: "Amina", district: "Mbale", language: "lg" });
    const res = await patch(cookie, { role: "buyer" });
    expect(res.status).toBe(409);
    expect((await query("select role from users")).rows[0].role).toBe("farmer");
  });

  it("refuses admin/agent as a role and unknown languages", async () => {
    const cookie = await cookieFor(await makeUser(null));
    expect((await patch(cookie, { role: "admin" })).status).toBe(400);
    expect((await patch(cookie, { language: "fr" })).status).toBe(400);
    expect((await query("select role from users")).rows[0].role).toBeNull();
  });

  it("updates name without touching a set role; 401 when signed out", async () => {
    const cookie = await cookieFor(await makeUser("buyer"));
    expect((await patch(cookie, { name: "Joe" })).status).toBe(200);
    expect((await query("select name, role from users")).rows[0]).toMatchObject({ name: "Joe", role: "buyer" });
    expect((await patch(undefined, { name: "x" })).status).toBe(401);
  });
});

describe("POST /api/auth/verify", () => {
  it("sets the session cookie and translates errors", async () => {
    await requestOtp(PHONE, "en");
    const post = (code: string) =>
      verifyRoute(new Request("http://x/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: PHONE, code }),
      }) as any);
    const bad = await post(wrong(lastCode()));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("signin.err.wrong_code");
    const ok = await post(lastCode());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^al_session=/);
    expect((await ok.json()).isNew).toBe(true);
  });
});
