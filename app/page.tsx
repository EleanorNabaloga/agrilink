import Link from "next/link";
import { query } from "@/lib/db";
import { pageContext } from "@/lib/auth/server";
import { t } from "@/lib/i18n";
import { formatUGX } from "@/lib/i18n/format";
import { browseListings } from "@/lib/listings";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const inputCls = "w-full rounded-xl border-2 border-emerald-300 bg-white px-4 py-3 text-lg focus:border-emerald-600 focus:outline-none";
const btnCls = "block w-full rounded-xl bg-emerald-600 px-4 py-4 text-center text-xl font-semibold text-white active:bg-emerald-800";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const product = first(sp.product);
  const district = first(sp.district).trim();
  const { user, lang } = await pageContext();
  const [listings, products] = await Promise.all([
    browseListings(lang, { product, district }),
    query<{ id: string; name: string }>(`select id::text as id, name_${lang} as name from products order by name_en`),
  ]);

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-3xl font-bold text-emerald-700">AgriLink</h1>

      {user?.role === "farmer" ? (
        <Link href="/listings/new" className={btnCls}>{t(lang, "listing.sell")}</Link>
      ) : !user ? (
        <Link href="/signin" className={btnCls}>{t(lang, "listing.signin")}</Link>
      ) : null}

      <form method="get" className="space-y-3">
        <select name="product" defaultValue={product} aria-label={t(lang, "listing.product")} className={inputCls}>
          <option value="">{t(lang, "listing.all_products")}</option>
          {products.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input name="district" defaultValue={district} placeholder={t(lang, "listing.all_districts")}
          aria-label={t(lang, "listing.district")} className={inputCls} />
        <button type="submit" className={btnCls}>{t(lang, "listing.search")}</button>
      </form>

      {listings.length === 0 ? (
        <p className="py-8 text-center text-lg text-gray-600">{t(lang, "listing.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {listings.map((l) => (
            <li key={l.id} className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm">
              {l.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.photo} alt={l.productName} className="h-40 w-full object-cover" />
              ) : null}
              <div className="space-y-1 p-4">
                <h2 className="text-2xl font-bold text-emerald-800">{l.productName}</h2>
                <p className="text-lg">{l.quantity.toLocaleString("en-US")} {l.unit}</p>
                <p className="text-xl font-semibold">
                  {formatUGX(l.pricePerUnit)} {t(lang, "listing.per", { unit: l.unit })}
                </p>
                <p className="text-gray-700">{l.district}</p>
                {l.farmerName ? <p className="text-gray-700">{t(lang, "listing.farmer")}: {l.farmerName}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
