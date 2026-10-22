import { SignJWT, jwtVerify } from "jose";
import { query } from "@/lib/db";
import { LANGS, type Lang } from "@/lib/i18n";

export const SESSION_COOKIE = "al_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

/** `role` is null until a new user picks farmer or buyer. */
export type User = {
  id: string;
  phone: string;
  name: string | null;
  role: "farmer" | "buyer" | "admin" | "agent" | null;
  district: string | null;
  language: Lang;
  payoutPhone: string | null;
};

function secretKey(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

function cookieAttrs(maxAge: number): string {
  const lax = process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development";
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${lax ? "" : "; Secure"}`;
}

/** The full `Set-Cookie` header value that signs `userId` in for 30 days. */
export async function createSessionCookie(userId: string): Promise<string> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(secretKey());
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs(SESSION_SECONDS)}`;
}

/** The `Set-Cookie` header value that clears the session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(0)}`;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The signed-in user (re-read from the database each call), or null. */
export async function getUser(req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  let id: string | undefined;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    id = payload.sub;
  } catch {
    return null;
  }
  if (!id || !/^\d+$/.test(id)) return null;
  const { rows } = await query(
    `select id::text as id, phone, name, role, district, language, payout_phone
       from users where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    phone: r.phone,
    name: r.name,
    role: r.role,
    district: r.district,
    language: (LANGS as readonly string[]).includes(r.language) ? r.language : "en",
    payoutPhone: r.payout_phone,
  };
}
