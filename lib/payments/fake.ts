import type { PaymentProvider } from "./types";
import { checkWebhookHash } from "./webhook-hash";

type Charge = { amount: number; currency: string; status: "successful" | "pending" | "failed"; providerRef: string };
type FakeState = {
  nextCharge: "pending" | "failed" | "throw";
  charges: Map<string, Charge>;
  transfers: Map<string, "successful" | "pending" | "failed">;
  failTransfers: number;
  pendingTransfers: number;
  seq: number;
};

// Kept on globalThis so the routes and the tests share one instance. In-memory, per process.
const g = globalThis as unknown as { __agrilinkFakePay?: FakeState };
function st(): FakeState {
  return (g.__agrilinkFakePay ??= {
    nextCharge: "pending",
    charges: new Map(),
    transfers: new Map(),
    failTransfers: 0,
    pendingTransfers: 0,
    seq: 0,
  });
}

export function setNextCharge(mode: "pending" | "failed" | "throw"): void {
  st().nextCharge = mode;
}
/** Decide what verifyCharge returns for `reference` (default: successful, the charged amount, UGX). */
export function completeCharge(
  reference: string,
  o: { amount?: number; currency?: string; status?: "successful" | "pending" | "failed" } = {},
): void {
  const c = st().charges.get(reference);
  if (!c) throw new Error(`fake: no charge ${reference}`);
  c.status = o.status ?? "successful";
  if (o.amount !== undefined) c.amount = o.amount;
  if (o.currency !== undefined) c.currency = o.currency;
}
/** The next n transfers fail. */
export function failTransfers(n: number): void {
  st().failTransfers = n;
}
/** The next n transfers are accepted but stay pending until completeTransfer is called. */
export function pendingTransfers(n: number): void {
  st().pendingTransfers = n;
}
/** Decide what verifyTransfer returns for `reference`. */
export function completeTransfer(reference: string, status: "successful" | "failed" | "pending" = "successful"): void {
  st().transfers.set(reference, status);
}
export function resetFake(): void {
  g.__agrilinkFakePay = undefined;
}

export const fakeProvider: PaymentProvider = {
  async startCharge(p) {
    const s = st();
    const mode = s.nextCharge;
    s.nextCharge = "pending";
    if (mode === "throw") throw new Error("fake: network down");
    if (mode === "failed") return { status: "failed", error: "fake: declined" };
    const providerRef = `fake-${++s.seq}`;
    s.charges.set(p.reference, { amount: p.amount, currency: "UGX", status: "pending", providerRef });
    return { status: "pending", providerRef };
  },
  async verifyCharge(reference) {
    const c = st().charges.get(reference);
    if (!c) return { status: "pending", amount: 0, currency: "UGX" };
    return { status: c.status, amount: c.amount, currency: c.currency, providerRef: c.providerRef };
  },
  async transfer(p) {
    const s = st();
    if (s.failTransfers > 0) {
      s.failTransfers--;
      s.transfers.set(p.reference, "failed");
      return { status: "failed", error: "fake: transfer failed" };
    }
    if (s.pendingTransfers > 0) {
      s.pendingTransfers--;
      s.transfers.set(p.reference, "pending");
      return { status: "pending", providerRef: `fake-t-${++s.seq}` };
    }
    s.transfers.set(p.reference, "successful");
    return { status: "successful", providerRef: `fake-t-${++s.seq}` };
  },
  async verifyTransfer(reference) {
    return { status: st().transfers.get(reference) ?? "pending" };
  },
  async refund() {
    return { status: "successful" };
  },
  verifyWebhook: checkWebhookHash,
};
