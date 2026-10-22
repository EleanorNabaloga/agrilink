import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { handleRoute, HttpError, requireUser } from "@/lib/auth/guard";
import { LANGS } from "@/lib/i18n";

const Body = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  district: z.string().trim().min(1).max(100).optional(),
  language: z.enum(LANGS).optional(),
  role: z.enum(["farmer", "buyer"]).optional(),
});

export async function GET(req: Request) {
  return handleRoute(async () => NextResponse.json({ user: await requireUser(req) }));
}

export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser(req);
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "error.bad_request");
    const { name, district, language, role } = body.data;

    // The role can be chosen once. "role is null" in the update makes that hold against double submits.
    if (role) {
      const set = await query("update users set role = $2 where id = $1 and role is null returning id", [user.id, role]);
      if (set.rows.length === 0) throw new HttpError(409, "error.role_already_set");
    }
    await query(
      `update users set name = coalesce($2, name), district = coalesce($3, district),
                        language = coalesce($4, language) where id = $1`,
      [user.id, name ?? null, district ?? null, language ?? null],
    );
    return NextResponse.json({ ok: true });
  });
}
