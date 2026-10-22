const URL = "https://api.africastalking.com/version1/messaging";

export async function sendAfricasTalking(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;
  if (!username || !apiKey) return { ok: false, error: "Africa's Talking is not configured" };
  const form = new URLSearchParams({ username, to, message: text });
  const sender = process.env.AT_SENDER_ID;
  if (sender) form.set("from", sender);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        apiKey,
      },
      body: form.toString(),
    });
    if (!res.ok) return { ok: false, error: `Africa's Talking returned HTTP ${res.status}` };
    const body = (await res.json()) as { SMSMessageData?: { Recipients?: { status?: string }[] } };
    const status = body?.SMSMessageData?.Recipients?.[0]?.status;
    if (status !== "Success") return { ok: false, error: status ?? "No recipient status returned" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
