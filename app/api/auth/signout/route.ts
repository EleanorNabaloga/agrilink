import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth/session";

export async function POST() {
  const out = NextResponse.json({ ok: true });
  out.headers.append("set-cookie", clearSessionCookie());
  return out;
}
