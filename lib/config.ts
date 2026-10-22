function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

export const PAYMENT_WINDOW_MIN = 30;
export const SEND_WINDOW_DAYS = 7;
export const CONFIRM_WINDOW_DAYS = 3;
export const PAYOUT_MAX_ATTEMPTS = 3;
export const PAYOUT_RETRY_MINUTES = 60;

export const config = {
  commissionPercent: num("COMMISSION_PERCENT", 3),
  providerFeePercent: num("PROVIDER_FEE_PERCENT", 0),
  paymentProvider: pick("PAYMENT_PROVIDER", ["fake", "flutterwave"] as const, "fake"),
  smsProvider: pick("SMS_PROVIDER", ["fake", "africastalking"] as const, "fake"),
  PAYMENT_WINDOW_MIN,
  SEND_WINDOW_DAYS,
  CONFIRM_WINDOW_DAYS,
  PAYOUT_MAX_ATTEMPTS,
  PAYOUT_RETRY_MINUTES,
};
