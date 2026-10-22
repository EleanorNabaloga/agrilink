import { z } from "zod";
import { query } from "@/lib/db";
import { HttpError } from "@/lib/auth/guard";
import { LANGS, type Lang } from "@/lib/i18n";

export type ListingInput = {
  productId: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  district: string;
  description?: string;
  photoUrl?: string;
};

const ListingSchema = z.object({
  productId: z.string().regex(/^\d{1,18}$/, "listing.err.product"),
  quantity: z.number("listing.err.quantity").int("listing.err.quantity").positive("listing.err.quantity").max(2_000_000_000, "listing.err.quantity"),
  unit: z.string("listing.err.unit").min(1, "listing.err.unit"),
  pricePerUnit: z.number("listing.err.price").int("listing.err.price").positive("listing.err.price").max(1_000_000_000_000, "listing.err.price"),
  district: z.string("listing.err.district").trim().min(2, "listing.err.district").max(60, "listing.err.district"),
  description: z.string("listing.err.description").max(500, "listing.err.description").optional(),
  photoUrl: z.string("listing.err.photo").url("listing.err.photo").max(1000, "listing.err.photo").optional(),
});

/** Validate and insert an active listing. `postedBy` is whoever is acting (the farmer, or an agent/admin for them). */
export async function createListing(farmerId: string, input: ListingInput, postedBy: string): Promise<string> {
  const parsed = ListingSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "error.bad_request");
  const v = parsed.data;

  const product = await query<{ units: string[] }>("select units from products where id = $1", [v.productId]);
  if (product.rows.length === 0) throw new HttpError(400, "listing.err.product");
  if (!product.rows[0].units.includes(v.unit)) throw new HttpError(400, "listing.err.unit");

  const { rows } = await query<{ id: string }>(
    `insert into listings (farmer_id, product_id, quantity_available, unit, price_per_unit, district, photo, description, posted_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text as id`,
    [farmerId, v.productId, v.quantity, v.unit, v.pricePerUnit, v.district, v.photoUrl ?? null, v.description?.trim() || null, postedBy],
  );
  // Task 12: notifyFollowers("new_listing", ...) goes here.
  return rows[0].id;
}

const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Upload a listing photo to Vercel Blob. Returns undefined when no file was sent or no blob token is configured. */
export async function uploadPhoto(file: File | null | undefined): Promise<string | undefined> {
  if (!file || file.size === 0) return undefined;
  if (!PHOTO_TYPES[file.type] || file.size > MAX_PHOTO_BYTES) throw new HttpError(400, "listing.err.photo");
  if (!process.env.BLOB_READ_WRITE_TOKEN) return undefined;
  const { put } = await import("@vercel/blob");
  const blob = await put(`listings/${crypto.randomUUID()}.${PHOTO_TYPES[file.type]}`, file, {
    access: "public",
    contentType: file.type,
  });
  return blob.url;
}

const NAME_COL: Record<Lang, string> = { en: "name_en", lg: "name_lg", sw: "name_sw", nyn: "name_nyn" };

export type PublicListing = {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  district: string;
  description: string | null;
  photo: string | null;
  farmerName: string | null;
  createdAt: Date;
};

/** Active listings with stock, newest first, max 50. Public fields only: never a phone number. */
export async function browseListings(
  lang: Lang,
  filters: { product?: string | null; district?: string | null } = {},
): Promise<PublicListing[]> {
  const col = NAME_COL[(LANGS as readonly string[]).includes(lang) ? lang : "en"];
  const where = ["l.status = 'active'", "l.quantity_available > 0"];
  const params: unknown[] = [];
  if (filters.product) {
    if (!/^\d{1,18}$/.test(filters.product)) return [];
    params.push(filters.product);
    where.push(`l.product_id = $${params.length}`);
  }
  const district = filters.district?.trim();
  if (district) {
    params.push(district);
    where.push(`lower(l.district) = lower($${params.length})`);
  }
  const { rows } = await query(
    `select l.id::text as id, l.product_id::text as product_id, p.${col} as product_name,
            l.quantity_available, l.unit, l.price_per_unit, l.district, l.description, l.photo,
            u.name as farmer_name, l.created_at
       from listings l
       join products p on p.id = l.product_id
       join users u on u.id = l.farmer_id
      where ${where.join(" and ")}
      order by l.created_at desc, l.id desc
      limit 50`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    productName: r.product_name,
    quantity: r.quantity_available,
    unit: r.unit,
    pricePerUnit: Number(r.price_per_unit),
    district: r.district,
    description: r.description,
    photo: r.photo,
    farmerName: r.farmer_name,
    createdAt: r.created_at,
  }));
}
