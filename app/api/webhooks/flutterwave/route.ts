import { NextResponse } from "next/server";
import { confirmCharge, getProvider } from "@/lib/payments";

/** Flutterwave webhook. Only the hash header is trusted; the body just names the transaction. */
export async function POST(req: Request) {
  if (!getProvider().verifyWebhook(req.headers)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { data?: { tx_ref?: unknown } } | null;
  const txRef = body?.data?.tx_ref;
  const m = typeof txRef === "string" ? /^(\d+)-charge$/.exec(txRef) : null;
  if (!m) {
    console.warn("flutterwave webhook ignored: unrecognised tx_ref");
    return NextResponse.json({ ok: true });
  }
  try {
    const result = await confirmCharge(m[1]);
    console.info(`flutterwave webhook ${txRef}: ${result}`);
  } catch (err) {
    // Could not reach the provider or the database: answer 500 so Flutterwave retries.
    console.error(`flutterwave webhook ${txRef} failed`, err);
    return NextResponse.json({ error: "error.server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
