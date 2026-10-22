/** Normalise a Ugandan mobile number to E.164 "+256XXXXXXXXX", or null. */
export function normalizeUgPhone(input: string): string | null {
  const s = input.replace(/[\s\-().]/g, "");
  let national: string | null = null;
  if (/^\+256\d{9}$/.test(s)) national = s.slice(4);
  else if (/^256\d{9}$/.test(s)) national = s.slice(3);
  else if (/^0\d{9}$/.test(s)) national = s.slice(1);
  else if (/^\d{9}$/.test(s)) national = s;
  return national ? `+256${national}` : null;
}

const MTN = ["76", "77", "78", "79", "39"];
const AIRTEL = ["70", "74", "75", "20"];

export function networkOf(e164: string): "MTN" | "AIRTEL" | null {
  const m = /^\+256(\d{2})\d{7}$/.exec(e164);
  if (!m) return null;
  if (MTN.includes(m[1])) return "MTN";
  if (AIRTEL.includes(m[1])) return "AIRTEL";
  return null;
}
