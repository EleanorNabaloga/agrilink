import { cookies, headers } from "next/headers";
import { pickLang } from "@/lib/i18n";
import SignInForm from "./SignInForm";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const lang = pickLang((await headers()).get("accept-language"), (await cookies()).get("lang")?.value);
  return <SignInForm initialLang={lang} />;
}
