import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { pageContext } from "@/lib/auth/server";
import { t } from "@/lib/i18n";
import NewListingForm from "./NewListingForm";

export const dynamic = "force-dynamic";

export default async function NewListingPage() {
  const { user, lang } = await pageContext();
  if (!user) redirect("/signin");
  if (user.role !== "farmer") {
    return (
      <main className="mx-auto max-w-md space-y-4 p-4">
        <p className="text-lg">{t(lang, "listing.new.signin")}</p>
        <Link href="/" className="block text-center text-lg font-semibold text-emerald-700 underline">{t(lang, "listing.back")}</Link>
      </main>
    );
  }
  const { rows } = await query<{ id: string; name: string; units: string[] }>(
    `select id::text as id, name_${lang} as name, units from products order by name_en`,
  );
  return <NewListingForm lang={lang} products={rows} defaultDistrict={user.district ?? ""} />;
}
