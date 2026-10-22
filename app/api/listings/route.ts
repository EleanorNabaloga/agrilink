import { NextResponse } from "next/server";
import { handleRoute, HttpError, requireUser } from "@/lib/auth/guard";
import { getUser } from "@/lib/auth/session";
import { pickLang, type Lang } from "@/lib/i18n";
import { browseListings, createListing, uploadPhoto, type ListingInput } from "@/lib/listings";

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Public: active listings with stock, newest first. Never includes phone numbers. */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const user = await getUser(req);
    const lang: Lang = user?.language ?? pickLang(req.headers.get("accept-language"), cookieValue(req, "lang"));
    const url = new URL(req.url);
    const listings = await browseListings(lang, {
      product: url.searchParams.get("product"),
      district: url.searchParams.get("district"),
    });
    return NextResponse.json({ listings });
  });
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser(req, ["farmer"]);
    let input: ListingInput;
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const fd = await req.formData().catch(() => null);
      if (!fd) throw new HttpError(400, "error.bad_request");
      const str = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : undefined);
      const photo = fd.get("photo");
      input = {
        productId: str("productId") ?? "",
        quantity: Number(str("quantity")),
        unit: str("unit") ?? "",
        pricePerUnit: Number(str("pricePerUnit")),
        district: str("district") ?? "",
        description: str("description") || undefined,
        photoUrl: await uploadPhoto(typeof photo === "string" ? null : photo),
      };
    } else {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") throw new HttpError(400, "error.bad_request");
      input = { ...(body as ListingInput), productId: String((body as any).productId ?? "") };
    }
    const id = await createListing(user.id, input, user.id);
    return NextResponse.json({ id }, { status: 201 });
  });
}
