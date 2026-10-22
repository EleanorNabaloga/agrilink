import { NextResponse } from "next/server";
import { z } from "zod";
import { requestOtp } from "@/lib/auth/otp";
import { handleRoute, HttpError } from "@/lib/auth/guard";
import { LANGS } from "@/lib/i18n";

const Body = z.object({ phone: z.string().max(40), lang: z.enum(LANGS).default("en") });

export async function POST(req: Request) {
  return handleRoute(async () => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "signin.err.bad_phone");
    const res = await requestOtp(body.data.phone, body.data.lang);
    if (!res.ok) throw new HttpError(res.reason === "too_many" ? 429 : 400, `signin.err.${res.reason}`);
    return NextResponse.json({ ok: true });
  });
}
