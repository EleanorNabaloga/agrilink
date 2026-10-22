import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { withTransaction } from "@/lib/db";
import { normalizeUgPhone } from "@/lib/phone";
import { sendSms } from "@/lib/sms";
import type { Lang } from "@/lib/i18n";

const CODE_MINUTES = 10;
const MAX_REQUESTS = 3;
const REQUEST_WINDOW_MINUTES = 15;
const MAX_ATTEMPTS = 5;

function hashCode(phone: string, code: string): string {
  const secret = process.env.OTP_SECRET;
  if (!secret) throw new Error("OTP_SECRET is not set");
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

export async function requestOtp(
  phoneInput: string,
  lang: Lang,
): Promise<{ ok: true } | { ok: false; reason: "bad_phone" | "too_many" }> {
  const phone = normalizeUgPhone(phoneInput);
  if (!phone) return { ok: false, reason: "bad_phone" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = hashCode(phone, code);

  // Count and record under a per-phone lock so parallel requests cannot all slip under the limit.
  const allowed = await withTransaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`otp:${phone}`]);
    const { rows } = await tx.query<{ n: number }>(
      `select count(*)::int as n from otp_requests
        where phone = $1 and created_at > now() - make_interval(mins => $2::int)`,
      [phone, REQUEST_WINDOW_MINUTES],
    );
    if (rows[0].n >= MAX_REQUESTS) return false;
    await tx.query("insert into otp_requests (phone) values ($1)", [phone]);
    await tx.query(
      `insert into otp_codes (phone, code_hash, expires_at, attempts, lang)
       values ($1, $2, now() + make_interval(mins => $3::int), 0, $4)
       on conflict (phone) do update
         set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
             attempts = 0, lang = excluded.lang`,
      [phone, hash, CODE_MINUTES, lang],
    );
    return true;
  });
  if (!allowed) return { ok: false, reason: "too_many" };

  await sendSms(phone, lang, "sms.otp", { code });
  return { ok: true };
}

type VerifyResult =
  | { ok: true; userId: string; isNew: boolean }
  | { ok: false; reason: "wrong_code" | "expired" | "too_many_tries" };

export async function verifyOtp(phoneInput: string, code: string): Promise<VerifyResult> {
  const phone = normalizeUgPhone(phoneInput);
  if (!phone) return { ok: false, reason: "expired" };

  return withTransaction<VerifyResult>(async (tx) => {
    const { rows } = await tx.query<{ code_hash: string; attempts: number; expired: boolean; lang: Lang }>(
      `select code_hash, attempts, lang, expires_at <= now() as expired
         from otp_codes where phone = $1 for update`,
      [phone],
    );
    const row = rows[0];
    if (!row || row.expired) return { ok: false, reason: "expired" };
    if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_tries" };

    const given = Buffer.from(hashCode(phone, code.trim()), "hex");
    const stored = Buffer.from(row.code_hash, "hex");
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
      await tx.query("update otp_codes set attempts = attempts + 1 where phone = $1", [phone]);
      return { ok: false, reason: "wrong_code" };
    }

    await tx.query("delete from otp_codes where phone = $1", [phone]);
    await tx.query(
      `insert into users (phone, language, payout_phone, payout_confirmed_at)
       values ($1, $2, $1, now())
       on conflict (phone) do nothing`,
      [phone, row.lang],
    );
    const u = await tx.query<{ id: string; role: string | null }>(
      "select id::text as id, role from users where phone = $1",
      [phone],
    );
    return { ok: true, userId: u.rows[0].id, isNew: u.rows[0].role === null };
  });
}
