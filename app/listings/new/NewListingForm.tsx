"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";

type Product = { id: string; name: string; units: string[] };

const inputCls = "w-full rounded-xl border-2 border-emerald-300 bg-white px-4 py-4 text-xl focus:border-emerald-600 focus:outline-none";
const btnCls = "w-full rounded-xl bg-emerald-600 px-4 py-4 text-xl font-semibold text-white active:bg-emerald-800 disabled:opacity-50";
const labelCls = "mb-1 block text-lg font-medium text-gray-800";

export default function NewListingForm({ lang, products, defaultDistrict }: { lang: Lang; products: Product[]; defaultDistrict: string }) {
  const router = useRouter();
  const [productId, setProductId] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const units = products.find((p) => p.id === productId)?.units ?? [];

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/listings", { method: "POST", body: new FormData(e.currentTarget) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" && data.error.startsWith("listing.err.") ? data.error : "listing.err.generic");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("listing.err.generic");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="mb-4 text-3xl font-bold text-emerald-700">{t(lang, "listing.new.title")}</h1>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className={labelCls} htmlFor="productId">{t(lang, "listing.product")}</label>
          <select id="productId" name="productId" required value={productId} className={inputCls}
            onChange={(e) => { setProductId(e.target.value); setUnit(""); }}>
            <option value="">{t(lang, "listing.choose")}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="quantity">{t(lang, "listing.quantity")}</label>
          <input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} step={1} required className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="unit">{t(lang, "listing.unit")}</label>
          <select id="unit" name="unit" required value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
            <option value="" />
            {units.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="pricePerUnit">{t(lang, "listing.price")}</label>
          <input id="pricePerUnit" name="pricePerUnit" type="number" inputMode="numeric" min={1} step={1} required className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="district">{t(lang, "listing.district")}</label>
          <input id="district" name="district" required minLength={2} maxLength={60} defaultValue={defaultDistrict} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="description">{t(lang, "listing.description")}</label>
          <textarea id="description" name="description" maxLength={500} rows={3} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="photo">{t(lang, "listing.photo")}</label>
          <input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" className="w-full text-lg" />
        </div>
        {error ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-lg text-red-800">{t(lang, error)}</p> : null}
        <button type="submit" disabled={busy} className={btnCls}>{busy ? t(lang, "listing.posting") : t(lang, "listing.post")}</button>
      </form>
    </main>
  );
}
