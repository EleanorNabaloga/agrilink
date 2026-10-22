import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRoute, HttpError, requireUser } from "@/lib/auth/guard";
import { withAction } from "@/lib/actions";
import { createOrder } from "@/lib/orders/apply";

const Body = z.object({
  listingId: z.string().regex(/^\d+$/),
  quantity: z.number().int().positive(),
  actionId: z.string().min(1).max(100).optional(),
});

export async function POST(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser(req, ["buyer"]);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "error.bad_request");
    const { listingId, quantity, actionId } = parsed.data;
    const result = await withAction(actionId, user.id, "create_order", () => createOrder(user.id, listingId, quantity));
    if (!result.ok) throw new HttpError(409, `order.err.${result.reason}`);
    return NextResponse.json({ orderId: result.orderId }, { status: 201 });
  });
}
