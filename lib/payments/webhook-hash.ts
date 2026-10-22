import { timingSafeEqual } from "node:crypto";

/**
 * Flutterwave sends the secret hash configured on the dashboard in the `verif-hash` header.
 * Constant-time comparison, equal length checked first. A missing FLW_WEBHOOK_HASH rejects everything.
 */
export function checkWebhookHash(headers: Headers): boolean {
  const expected = process.env.FLW_WEBHOOK_HASH;
  if (!expected) {
    console.error("FLW_WEBHOOK_HASH is not set: rejecting webhook");
    return false;
  }
  const got = headers.get("verif-hash");
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
