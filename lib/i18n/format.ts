import { t, type Lang } from "./index";

export function formatUGX(amount: number): string {
  return `${Math.round(amount).toLocaleString("en-US")} UGX`;
}

function kampalaParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Kampala", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: Number(get("day")), month: Number(get("month")), hour: get("hour"), minute: get("minute") };
}

/** "29 Oct" */
export function formatDate(lang: Lang, d: Date): string {
  const p = kampalaParts(d);
  return `${p.day} ${t(lang, `month.${p.month}`)}`;
}

/** "25 Oct 14:00" in Africa/Kampala time */
export function formatDateTime(lang: Lang, d: Date): string {
  const p = kampalaParts(d);
  return `${formatDate(lang, d)} ${p.hour}:${p.minute}`;
}
