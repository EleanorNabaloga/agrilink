import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyOtp } from "@/lib/auth/otp";
import { createSessionCookie } from "@/lib/auth/session";
import { handleRoute, HttpError } from "@/lib/auth/guard";

const Body = z.object({ phone: z.string().max(40), code: z.string().max(12) });

export async function POST(req: Request) {
  return handleRoute(async () => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "signin.err.wrong_code");
    const res = await verifyOtp(body.data.phone, body.data.code);
    if (!res.ok) throw new HttpError(res.reason === "too_many_tries" ? 429 : 400, `signin.err.${res.reason}`);
    const out = NextResponse.json({ ok: true, isNew: res.isNew });
    out.headers.append("set-cookie", await createSessionCookie(res.userId));
    return out;
  });
}
