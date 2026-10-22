export const fakeSmsOutbox: { to: string; text: string }[] = [];

export function clearFakeSms(): void {
  fakeSmsOutbox.length = 0;
}

export async function sendFake(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  fakeSmsOutbox.push({ to, text });
  if (process.env.NODE_ENV !== "test") console.info(`[fake sms] to ${to}: ${text}`);
  return { ok: true };
}
