import { config } from "@/lib/config";
import { t, type Lang } from "@/lib/i18n";
import { fitsOneSms } from "./fit";
import { sendFake } from "./fake";
import { sendAfricasTalking } from "./africastalking";

/** Render a template in the recipient's language and send it. Throws if the text would not fit one SMS. */
export async function sendSms(
  to: string,
  lang: Lang,
  key: string,
  vars?: Record<string, string | number>,
): Promise<{ ok: boolean; error?: string }> {
  const text = t(lang, key, vars);
  if (!fitsOneSms(text)) {
    throw new Error(`SMS "${key}" (${lang}) is ${[...text].length} chars, does not fit one SMS`);
  }
  return config.smsProvider === "africastalking" ? sendAfricasTalking(to, text) : sendFake(to, text);
}
