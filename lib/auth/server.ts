import { cookies, headers } from "next/headers";
import { getUser, type User } from "@/lib/auth/session";
import { pickLang, type Lang } from "@/lib/i18n";

/** For server components: the signed-in user (or null) and the language to render in. */
export async function pageContext(): Promise<{ user: User | null; lang: Lang }> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const user = await getUser(new Request("http://page.local/", { headers: { cookie: jar.toString() } }));
  const lang = user?.language ?? pickLang(h.get("accept-language"), jar.get("lang")?.value);
  return { user, lang };
}
