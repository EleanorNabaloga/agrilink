import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSms } from "@/lib/sms";
import { fakeSmsOutbox, clearFakeSms } from "@/lib/sms/fake";
import { sendAfricasTalking } from "@/lib/sms/africastalking";

beforeEach(() => clearFakeSms());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fake provider", () => {
  it("records the text rendered in the recipient's language", async () => {
    expect(await sendSms("+256700000001", "lg", "sms.otp", { code: "123456" })).toEqual({ ok: true });
    expect(fakeSmsOutbox).toHaveLength(1);
    expect(fakeSmsOutbox[0].to).toBe("+256700000001");
    expect(fakeSmsOutbox[0].text).toContain("Koodi ya AgriLink: 123456");
  });

  it("clearFakeSms empties the outbox", async () => {
    await sendSms("+256700000001", "en", "sms.otp", { code: "1" });
    clearFakeSms();
    expect(fakeSmsOutbox).toHaveLength(0);
  });

  it("throws when the text does not fit one SMS", async () => {
    await expect(sendSms("+256700000001", "en", "sms.otp", { code: "9".repeat(200) })).rejects.toThrow(
      /SMS "sms\.otp" \(en\) is \d+ chars, does not fit one SMS/,
    );
    expect(fakeSmsOutbox).toHaveLength(0);
  });
});

describe("Africa's Talking adapter", () => {
  beforeEach(() => {
    vi.stubEnv("AT_USERNAME", "agri");
    vi.stubEnv("AT_API_KEY", "secret-key");
    vi.stubEnv("AT_SENDER_ID", "AgriLink");
  });
  const okBody = { SMSMessageData: { Recipients: [{ status: "Success" }] } };

  it("POSTs form fields and apiKey header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => okBody });
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendAfricasTalking("+256700000001", "hello")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.africastalking.com/version1/messaging");
    expect(init.method).toBe("POST");
    expect(init.headers.apiKey).toBe("secret-key");
    expect(init.headers.Accept).toBe("application/json");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      username: "agri",
      to: "+256700000001",
      message: "hello",
      from: "AgriLink",
    });
  });

  it("omits from when no sender id", async () => {
    vi.stubEnv("AT_SENDER_ID", "");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => okBody });
    vi.stubGlobal("fetch", fetchMock);
    await sendAfricasTalking("+256700000001", "hello");
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body as string).has("from")).toBe(false);
  });

  it("returns ok:false on non-2xx without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const r = await sendAfricasTalking("+256700000001", "hello");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("401");
    expect(JSON.stringify(r)).not.toContain("secret-key");
  });

  it("returns ok:false when a recipient failed", async () => {
    const body = { SMSMessageData: { Recipients: [{ status: "InvalidPhoneNumber" }] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => body }));
    expect(await sendAfricasTalking("+256700000001", "hello")).toEqual({ ok: false, error: "InvalidPhoneNumber" });
  });

  it("returns ok:false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await sendAfricasTalking("+256700000001", "hello")).toEqual({ ok: false, error: "boom" });
  });
});
