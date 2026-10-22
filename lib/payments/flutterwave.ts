/*
 * Flutterwave v3 adapter.
 *
 * API shapes (Step 1 of the task brief). Verification status: developer.flutterwave.com was only
 * partly reachable when this was written. Confirmed from the docs: transfers are
 * POST https://api.flutterwave.com/v3/transfers with a Bearer secret key, account_bank one of
 * {Airtel, MPS, MTN} for Uganda, account_number with the country code (256...), amount, currency
 * UGX, and beneficiary_name (required, added below); a transfer starts as NEW and is confirmed by
 * webhook or the get-transfer endpoint. The charge, verify, refund and webhook-header shapes could
 * NOT be re-checked against the live docs (404s) and are kept as the plan gave them:
 *
 *   charge   POST /v3/charges?type=mobile_money_uganda
 *            { tx_ref, amount, currency: "UGX", email, phone_number, network: "MTN" | "AIRTEL" }
 *            -> { status: "success", data: { id, flw_ref, status: "pending" } }
 *   verify   GET  /v3/transactions/verify_by_reference?tx_ref=<ref>
 *            -> { status: "success", data: { id, status: "successful"|"failed"|..., amount, currency } }
 *   transfer POST /v3/transfers { account_bank: "MPS", account_number, amount, currency: "UGX",
 *            reference, narration, beneficiary_name } -> data.status NEW|PENDING|SUCCESSFUL|FAILED
 *   status   GET  /v3/transfers?reference=<ref> -> data: [ { status } ]
 *   refund   POST /v3/transactions/{id}/refund { amount }
 *   webhook  header `verif-hash` equals the FLW_WEBHOOK_HASH we configured (constant-time compare).
 *
 * Re-check these against the live docs before going live. Never log the secret key or full bodies.
 */
import type { PaymentProvider } from "./types";
import { checkWebhookHash } from "./webhook-hash";

const BASE = "https://api.flutterwave.com/v3";

type Json = Record<string, any>;

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ http: number; json: Json }> {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY is not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  // A server error means "we do not know": throw so callers do not treat it as a decline.
  if (res.status >= 500) throw new Error(`Flutterwave ${method} ${path.split("?")[0]} returned ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as Json;
  return { http: res.status, json };
}

const digits = (phone: string) => phone.replace(/\D/g, "");
const refOf = (d: Json | undefined) =>
  d?.id !== undefined && d?.id !== null ? String(d.id) : d?.flw_ref ? String(d.flw_ref) : undefined;

export const flutterwaveProvider: PaymentProvider = {
  async startCharge(p) {
    const { json } = await call("POST", "/charges?type=mobile_money_uganda", {
      tx_ref: p.reference,
      amount: p.amount,
      currency: "UGX",
      email: p.email,
      phone_number: digits(p.phone),
      network: p.network,
    });
    if (json.status !== "success") return { status: "failed", error: String(json.message ?? "charge failed") };
    if (json.data?.status === "failed") return { status: "failed", error: String(json.data?.processor_response ?? "charge failed") };
    return { status: "pending", providerRef: refOf(json.data) };
  },

  async verifyCharge(reference) {
    const { http, json } = await call("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    // 404 means "no such transaction yet". Anything else besides 200 (e.g. 401 from a bad key) would
    // leave every payment silently pending, so say so loudly (never the key).
    if (http !== 200 && http !== 404) {
      console.error(`Flutterwave verifyCharge ${reference} returned HTTP ${http}: check FLW_SECRET_KEY and the account`);
    }
    const d = json.data as Json | undefined;
    // "No transaction found" and similar errors: nothing to confirm yet.
    if (json.status !== "success" || !d) return { status: "pending", amount: 0, currency: "UGX" };
    const status = d.status === "successful" ? "successful" : d.status === "failed" ? "failed" : "pending";
    return { status, amount: Number(d.amount), currency: String(d.currency), providerRef: refOf(d) };
  },

  async transfer(p) {
    const { json } = await call("POST", "/transfers", {
      account_bank: "MPS",
      account_number: digits(p.phone),
      amount: p.amount,
      currency: "UGX",
      reference: p.reference,
      narration: p.narration,
      beneficiary_name: "AgriLink farmer",
    });
    if (json.status !== "success") return { status: "failed", error: String(json.message ?? "transfer failed") };
    const s = String(json.data?.status ?? "").toUpperCase();
    const providerRef = refOf(json.data);
    if (s === "FAILED") return { status: "failed", providerRef, error: String(json.data?.complete_message ?? "transfer failed") };
    if (s === "SUCCESSFUL") return { status: "successful", providerRef };
    return { status: "pending", providerRef };
  },

  async verifyTransfer(reference) {
    const { json } = await call("GET", `/transfers?reference=${encodeURIComponent(reference)}`);
    const t = Array.isArray(json.data) ? (json.data[0] as Json | undefined) : undefined;
    const s = String(t?.status ?? "").toUpperCase();
    return { status: s === "SUCCESSFUL" ? "successful" : s === "FAILED" ? "failed" : "pending" };
  },

  async refund(p) {
    const { json } = await call("POST", `/transactions/${encodeURIComponent(p.chargeProviderRef)}/refund`, { amount: p.amount });
    if (json.status !== "success") return { status: "failed", error: String(json.message ?? "refund failed") };
    return { status: "pending" };
  },

  verifyWebhook: checkWebhookHash,
};
