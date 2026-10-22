import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flutterwaveProvider as flw } from "@/lib/payments/flutterwave";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FLW_SECRET_KEY", "FLWSECK_TEST-abc");
  vi.stubEnv("FLW_WEBHOOK_HASH", "hash-123");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const reply = (json: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(json), { status }));
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: url as string, init: init as RequestInit, body: init.body ? JSON.parse(init.body as string) : undefined };
};

describe("Flutterwave adapter requests", () => {
  it("startCharge posts the mobile money body with a Bearer key", async () => {
    reply({ status: "success", data: { id: 77, flw_ref: "F1", status: "pending" } });
    const r = await flw.startCharge({ reference: "5-charge", amount: 4120, phone: "+256771000002", network: "MTN", email: "a@b.ug" });
    const { url, init, body } = lastCall();
    expect(url).toBe("https://api.flutterwave.com/v3/charges?type=mobile_money_uganda");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer FLWSECK_TEST-abc");
    expect(body).toEqual({ tx_ref: "5-charge", amount: 4120, currency: "UGX", email: "a@b.ug", phone_number: "256771000002", network: "MTN" });
    expect(r).toEqual({ status: "pending", providerRef: "77" });
  });

  it("startCharge maps an error answer to failed and a 5xx to a thrown error", async () => {
    reply({ status: "error", message: "Invalid phone" }, 400);
    expect(await flw.startCharge({ reference: "5-charge", amount: 1, phone: "+256701000001", network: "AIRTEL", email: "a@b.ug" })).toEqual({
      status: "failed",
      error: "Invalid phone",
    });
    expect(lastCall().body.network).toBe("AIRTEL");
    reply({}, 503);
    await expect(
      flw.startCharge({ reference: "5-charge", amount: 1, phone: "+256701000001", network: "AIRTEL", email: "a@b.ug" }),
    ).rejects.toThrow();
  });

  it("verifyCharge reads status, amount and currency", async () => {
    reply({ status: "success", data: { id: 9, status: "successful", amount: 4120, currency: "UGX" } });
    expect(await flw.verifyCharge("5-charge")).toEqual({ status: "successful", amount: 4120, currency: "UGX", providerRef: "9" });
    const { url, init } = lastCall();
    expect(url).toBe("https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=5-charge");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer FLWSECK_TEST-abc");
  });

  it("verifyCharge treats not-found as pending", async () => {
    reply({ status: "error", message: "No transaction was found" }, 404);
    expect((await flw.verifyCharge("5-charge")).status).toBe("pending");
  });

  it("transfer posts the MPS body", async () => {
    reply({ status: "success", data: { id: 3, status: "NEW" } });
    const r = await flw.transfer({ reference: "5-payout-1", amount: 3880, phone: "+256771000001", narration: "AgriLink order 5" });
    const { url, body } = lastCall();
    expect(url).toBe("https://api.flutterwave.com/v3/transfers");
    expect(body).toMatchObject({
      account_bank: "MPS",
      account_number: "256771000001",
      amount: 3880,
      currency: "UGX",
      reference: "5-payout-1",
      narration: "AgriLink order 5",
    });
    expect(r).toEqual({ status: "pending", providerRef: "3" });
  });

  it("verifyTransfer queries by reference", async () => {
    reply({ status: "success", data: [{ status: "SUCCESSFUL" }] });
    expect(await flw.verifyTransfer("5-payout-1")).toEqual({ status: "successful" });
    expect(lastCall().url).toBe("https://api.flutterwave.com/v3/transfers?reference=5-payout-1");
  });

  it("refund posts the amount to the transaction", async () => {
    reply({ status: "success", data: {} });
    expect(await flw.refund({ reference: "5-refund-1", chargeProviderRef: "77", amount: 4120 })).toEqual({ status: "pending" });
    const { url, body } = lastCall();
    expect(url).toBe("https://api.flutterwave.com/v3/transactions/77/refund");
    expect(body).toEqual({ amount: 4120 });
  });

  it("verifyWebhook compares verif-hash with FLW_WEBHOOK_HASH", () => {
    expect(flw.verifyWebhook(new Headers({ "verif-hash": "hash-123" }))).toBe(true);
    expect(flw.verifyWebhook(new Headers({ "verif-hash": "hash-124" }))).toBe(false);
    expect(flw.verifyWebhook(new Headers({ "verif-hash": "x" }))).toBe(false);
    expect(flw.verifyWebhook(new Headers())).toBe(false);
  });
});
