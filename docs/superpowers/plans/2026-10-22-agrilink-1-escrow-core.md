# AgriLink Plan 1: Foundation and Escrow Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static AgriLink demo with a working marketplace where farmers list produce, buyers pay by mobile money into escrow, and money is released to farmers after delivery, in English, Luganda, Kiswahili and Runyankole.

**Architecture:** Next.js 14 (App Router, TypeScript) on Vercel with Neon Postgres via `pg`. Pure modules decide money and order rules; one module applies them inside a locked transaction; adapters wrap Flutterwave and Africa's Talking (each with a fake for development and tests). Calls to outside services happen after the transaction commits, driven by rows in a `payments` table, so retries never double-pay.

**Tech Stack:** Next.js 14.2, React 18, TypeScript, `pg`, `jose` (sessions), `zod` (input validation), Vitest, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-10-22-agrilink-escrow-design.md`

**Later plans (not here):** Plan 2 voice notes and Sunbird transcription (spec §8); Plan 3 AI features (§11); Plan 4 offline and sync (§12). This plan leaves hooks for them: `voice_note_id` columns exist but stay null; every user action route accepts an optional `actionId` and records it in `synced_actions` (needed by Plan 4).

## Global Constraints

- Money is whole Uganda shillings (integers) everywhere. No floats in amounts, no decimals in the database (`bigint`).
- Commission: `COMMISSION_PERCENT` env, default `3`, may be `0`; stored on each order at creation. Commission = `Math.round(subtotal × percent / 100)`.
- Provider fee: `PROVIDER_FEE_PERCENT` env (Flutterwave's UGX mobile money rate at launch; `0` in development), fee = `Math.ceil(subtotal × percent / 100)`, stored on the order.
- Buyer pays subtotal + commission + provider fee. Farmer receives exactly the subtotal.
- Time limits: pay within **30 minutes**; farmer must mark sent within **7 days** of payment; buyer has **3 days** after delivery to confirm or dispute. Deadlines are judged in **server time** and stored on the order when its state is entered.
- Payout/refund retries: **3 attempts over 3 hours**, then flagged for admin.
- Phones stored as E.164 `+256XXXXXXXXX`. MTN prefixes 76, 77, 78, 79, 39; Airtel 70, 74, 75, 20.
- Sign-in codes: 6 digits, valid 10 minutes, at most 5 tries, at most 3 codes per phone per 15 minutes. Sessions last **30 days**.
- Languages `en`, `lg`, `sw`, `nyn`. No user-facing text written directly in pages: every string comes from `lib/i18n/strings/<lang>.ts`; missing keys fall back to English. Admin pages are English only.
- SMS text must fit one SMS: 160 characters if all GSM-7, else 70.
- Only `lib/orders/apply.ts` changes an order's state. Outside services are never called inside a database transaction.
- Secrets only from environment variables: `DATABASE_URL`, `TEST_DATABASE_URL`, `SESSION_SECRET`, `OTP_SECRET`, `CRON_SECRET`, `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH`, `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `PAYMENT_PROVIDER` (`fake`|`flutterwave`), `SMS_PROVIDER` (`fake`|`africastalking`).
- Visual style: keep the existing emerald-green look (Tailwind `emerald-600/700` primary).

## Review Focus

1. **Payment confirmed after the order was cancelled for timeout** (buyer approved the prompt at minute 31): money was taken, so the order must go to `refunding` with a full refund, never stay `cancelled` with money held. Test in Task 3 and Task 9.
2. **Flutterwave webhook and the scheduled job confirming the same charge at once:** exactly one `paid` transition, one farmer SMS. Test in Task 9.
3. **Two buyers ordering the last bags at the same moment:** quantity reserved inside the lock; the second gets "not enough left", stock never goes negative. Test in Task 8.
4. **Phone typed in local formats** (`0772 123456`, `772123456`, `+256 772-123-456`, `256772123456`): all normalise to the same account; foreign or malformed numbers are refused with a message. Test in Task 4.
5. **The scheduled job not running for a day** (Vercel cron missed or plan limits): overdue deadlines are also applied when an order is opened or acted on, so nothing waits on the job. Test in Task 11.

---

## File Structure

```
app/
  layout.tsx, globals.css               shell, language from cookie, bell
  page.tsx                              browse listings
  signin/page.tsx
  listings/new/page.tsx
  orders/page.tsx                       my orders (farmer + buyer), "coming to me"
  orders/[id]/page.tsx                  order page: steps, actions, messages
  notifications/page.tsx, following/page.tsx, settings/page.tsx
  admin/(disputes|payouts|orders|listings|products)/page.tsx
  api/auth/(request|verify|signout)/route.ts
  api/listings/route.ts, api/orders/route.ts
  api/orders/[id]/(pay|send|deliver|confirm|dispute|cancel|messages)/route.ts
  api/webhooks/flutterwave/route.ts
  api/cron/tick/route.ts
  api/notifications/route.ts, api/follows/route.ts, api/me/route.ts
  api/admin/...                         one route per admin action
lib/
  config.ts                             env values with defaults
  db.ts                                 pool, query, withTransaction
  money.ts                              amounts, split
  phone.ts                              normalise, network
  orders/rules.ts                       states, events, transition (pure)
  orders/apply.ts                       applyEvent (locked transaction)
  orders/deadlines.ts                   applyDueDeadlines(orderId)
  payments/types.ts, fake.ts, flutterwave.ts, index.ts
  payments/settle.ts                    process pending payment rows
  sms/index.ts, fake.ts, africastalking.ts, fit.ts
  auth/otp.ts, session.ts, guard.ts
  i18n/index.ts, format.ts, strings/{en,lg,sw,nyn}.ts
  notify.ts
  listings.ts                           createListing (used by farmers and admins)
  actions.ts                            synced_actions idempotency wrapper
components/Bell.tsx                     unread notifications count
db/migrations/001_init.sql, db/seed/products.sql
scripts/migrate.mjs
tests/                                  mirrors lib/ and app/api
vercel.json
```

Remove `index.html`, `server.js`, `data.json` (Task 1).

---

### Task 1: Project scaffold, database and test setup

**Files:**
- Delete: `index.html`, `server.js`, `data.json`
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `lib/config.ts`, `lib/db.ts`, `db/migrations/001_init.sql`, `db/seed/products.sql`, `scripts/migrate.mjs`, `tests/helpers/db.ts`, `tests/db.test.ts`, `.env.example`, `README.md` (rewrite)

**Interfaces:**
- Produces: `query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>`; `withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>` where `Tx = { query: typeof query }`; `config` object (`commissionPercent`, `providerFeePercent`, `paymentProvider`, `smsProvider`, deadline constants `PAYMENT_WINDOW_MIN=30`, `SEND_WINDOW_DAYS=7`, `CONFIRM_WINDOW_DAYS=3`, `PAYOUT_MAX_ATTEMPTS=3`, `PAYOUT_RETRY_MINUTES=60`); test helper `resetDb(): Promise<void>` (drops and re-runs migrations + seed on `TEST_DATABASE_URL`).

- [ ] **Step 1:** Delete the demo files; create the Next.js 14 TypeScript app with Tailwind, Vitest, `pg`, `jose`, `zod`. Scripts: `dev`, `build`, `start`, `test` (`vitest run`), `migrate` (`node scripts/migrate.mjs`).
- [ ] **Step 2:** Write `db/migrations/001_init.sql` with every table in spec §6 (`users` incl. `language`, `otp_codes`, `products` with `name_en/name_lg/name_sw/name_nyn` and `units text[]`, `listings`, `orders`, `order_events`, `payments`, `messages`, `voice_notes`, `follows`, `notifications`, `synced_actions`). Money columns `bigint`. `orders.state` is `text` with a CHECK listing the 11 states of spec §2. `payments.reference` UNIQUE. `order_events` has no UPDATE path (append only). `notifications` stores `title_key`, `body_key`, `vars jsonb` (rendered in the reader's language at view time). Seed 12 common products (maize, beans, coffee, matooke, cassava, rice, groundnuts, sorghum, millet, soya, Irish potatoes, sweet potatoes) with names in all four languages and units.
- [ ] **Step 3: Write the failing test** `tests/db.test.ts`:

```ts
test("migrations create all tables and seed products", async () => {
  await resetDb();
  const { rows } = await query<{ n: string }>("select count(*) n from products");
  expect(Number(rows[0].n)).toBe(12);
});
test("withTransaction rolls back on error", async () => {
  await resetDb();
  await expect(withTransaction(async (tx) => {
    await tx.query("insert into users (phone, role, language) values ('+256772000001','buyer','en')");
    throw new Error("boom");
  })).rejects.toThrow("boom");
  const { rows } = await query("select * from users");
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 4:** Run `npm test -- tests/db.test.ts`. Expected: FAIL (`lib/db` missing).
- [ ] **Step 5:** Implement `lib/config.ts`, `lib/db.ts` (one `pg.Pool` per process, cached on `globalThis`), `scripts/migrate.mjs` (runs `db/migrations/*.sql` in order, records them in a `schema_migrations` table), `tests/helpers/db.ts`.
- [ ] **Step 6:** Run `npm test`. Expected: PASS. Run `npm run build`. Expected: success.
- [ ] **Step 7:** Rewrite `README.md`: what AgriLink is, env vars from Global Constraints, `npm run migrate`, `npm test` (needs `TEST_DATABASE_URL`, a separate Neon branch).
- [ ] **Step 8: Commit** `git commit -m "Scaffold Next.js app, schema and test setup"`

---

### Task 2: Money

**Files:** Create `lib/money.ts`, `tests/money.test.ts`

**Interfaces:**
- Produces:
  - `type Amounts = { unitPrice: number; quantity: number; subtotal: number; commissionPercent: number; commission: number; providerFee: number; total: number }`
  - `computeAmounts(unitPrice: number, quantity: number, commissionPercent: number, providerFeePercent: number): Amounts` — throws `RangeError` unless `unitPrice` and `quantity` are positive integers and percents are ≥ 0.
  - `splitAmounts(a: Amounts, farmerAmount: number): { farmer: number; commission: number; buyerRefund: number }` — throws `RangeError` unless `0 ≤ farmerAmount ≤ a.subtotal` and integer.

- [ ] **Step 1: Write the failing tests:**

```ts
test("buyer pays price + 3% + fee, all whole shillings", () => {
  expect(computeAmounts(60000, 50, 3, 1.5)).toEqual({ unitPrice: 60000, quantity: 50, subtotal: 3000000,
    commissionPercent: 3, commission: 90000, providerFee: 45000, total: 3135000 });
});
test("commission rounds to nearest shilling, fee rounds up", () => {
  const a = computeAmounts(333, 1, 3, 1.5);   // 9.99 -> 10, 4.995 -> 5
  expect([a.commission, a.providerFee, a.total]).toEqual([10, 5, 348]);
});
test("zero commission allowed", () => { expect(computeAmounts(1000, 2, 0, 0).total).toBe(2000); });
test("rejects fractional or non-positive inputs", () => {
  expect(() => computeAmounts(1000.5, 1, 3, 0)).toThrow(RangeError);
  expect(() => computeAmounts(1000, 0, 3, 0)).toThrow(RangeError);
});
test("split parts always add up to the total paid", () => {
  const a = computeAmounts(60000, 50, 3, 1.5);
  for (const f of [0, 1, 1234567, 3000000]) {
    const s = splitAmounts(a, f);
    expect(s.farmer + s.commission + s.buyerRefund).toBe(a.total);
    expect(s.commission).toBe(Math.round(f * 3 / 100));
  }
});
test("split refuses more than the subtotal", () => {
  expect(() => splitAmounts(computeAmounts(100, 1, 3, 0), 101)).toThrow(RangeError);
});
```

- [ ] **Step 2:** Run `npm test -- tests/money.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/money.ts`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add money calculations"`

---

### Task 3: Order rules (pure)

**Files:** Create `lib/orders/rules.ts`, `tests/orders/rules.test.ts`

**Interfaces:**
- Consumes: `config` deadline constants; `Amounts`, `splitAmounts` (Task 2).
- Produces:
  - `type OrderState = "ordered" | "awaiting_payment" | "paid" | "in_transit" | "delivered" | "disputed" | "releasing" | "refunding" | "completed" | "refunded" | "cancelled"`
  - `type OrderEvent =`
    `| { type: "start_payment" } | { type: "charge_confirmed" } | { type: "charge_failed" } | { type: "payment_timeout" }`
    `| { type: "farmer_sent"; transporterName?: string; transporterPhone?: string } | { type: "farmer_delivered" }`
    `| { type: "buyer_confirmed" } | { type: "auto_release" } | { type: "buyer_disputed"; note: string }`
    `| { type: "buyer_cancel_not_sent" }`
    `| { type: "admin_resolve"; decision: "pay_farmer" | "refund_buyer" | "split"; farmerAmount?: number }`
    `| { type: "settlement_done"; farmerPaid: boolean }`
  - `type Actor = { kind: "buyer" | "farmer" | "admin" | "system"; userId?: string }`
  - `type OrderSnapshot = { state: OrderState; deadlineAt: Date | null; amounts: Amounts }`
  - `type Effect = { kind: "payout"; amount: number } | { kind: "refund"; amount: number } | { kind: "release_stock" }`
  - `type TransitionResult = { ok: true; to: OrderState; deadlineAt: Date | null; effects: Effect[] } | { ok: false; reason: TransitionError }`
  - `type TransitionError = "not_allowed" | "wrong_actor" | "deadline_not_reached" | "deadline_passed" | "bad_amount"`
  - `transition(order: OrderSnapshot, event: OrderEvent, actor: Actor, now: Date): TransitionResult`
  - `nextDeadlineEvent(order: OrderSnapshot, now: Date): OrderEvent | null` — the system event due now (`payment_timeout` in `awaiting_payment`, `auto_release` in `delivered`), else null.

Transition table (everything else is `not_allowed`):

| From | Event | Actor | Condition | To | Deadline | Effects |
|---|---|---|---|---|---|---|
| ordered | start_payment | buyer | | awaiting_payment | now+30 min | |
| awaiting_payment | charge_confirmed | system | | paid | now+7 d | |
| awaiting_payment | charge_failed | system | | cancelled | null | release_stock |
| awaiting_payment | payment_timeout | system | now > deadline | cancelled | null | release_stock |
| cancelled | charge_confirmed | system | | refunding | null | refund total |
| paid | farmer_sent | farmer | | in_transit | null | |
| paid | buyer_cancel_not_sent | buyer | now > deadline | refunding | null | refund total, release_stock |
| in_transit | farmer_delivered | farmer | | delivered | now+3 d | |
| delivered | buyer_confirmed | buyer | | releasing | null | payout subtotal |
| delivered | auto_release | system | now > deadline | releasing | null | payout subtotal |
| delivered | buyer_disputed | buyer | now ≤ deadline | disputed | null | |
| disputed | admin_resolve pay_farmer | admin | | releasing | null | payout subtotal |
| disputed | admin_resolve refund_buyer | admin | | refunding | null | refund total |
| disputed | admin_resolve split | admin | farmerAmount valid | releasing | null | payout F, refund buyerRefund |
| releasing | settlement_done farmerPaid=true | system | | completed | null | |
| refunding | settlement_done farmerPaid=false | system | | refunded | null | |

- [ ] **Step 1: Write the failing tests** — one test per table row asserting `to`, deadline and effects, plus:

```ts
test("charge confirmed after timeout cancellation refunds in full", () => {
  const r = transition(snap("cancelled"), { type: "charge_confirmed" }, SYSTEM, now);
  expect(r).toMatchObject({ ok: true, to: "refunding", effects: [{ kind: "refund", amount: AMOUNTS.total }] });
});
test("cannot dispute after 3 days", () => {
  const order = snap("delivered", addDays(now, -3.01));        // deadline already passed
  expect(transition(order, { type: "buyer_disputed", note: "x" }, BUYER, now)).toEqual({ ok: false, reason: "deadline_passed" });
});
test("auto release refused before deadline", () => {
  expect(transition(snap("delivered", addDays(now, 1)), { type: "auto_release" }, SYSTEM, now))
    .toEqual({ ok: false, reason: "deadline_not_reached" });
});
test("farmer cannot confirm on the buyer's behalf", () => {
  expect(transition(snap("delivered", addDays(now, 1)), { type: "buyer_confirmed" }, FARMER, now))
    .toEqual({ ok: false, reason: "wrong_actor" });
});
test("cannot pay twice", () => {
  expect(transition(snap("paid", addDays(now, 7)), { type: "charge_confirmed" }, SYSTEM, now))
    .toEqual({ ok: false, reason: "not_allowed" });
});
test("split payout and refund add up with commission", () => {
  const r = transition(snap("disputed"), { type: "admin_resolve", decision: "split", farmerAmount: 1000000 }, ADMIN, now);
  // effects payout 1000000 and refund AMOUNTS.total - 1000000 - 30000
});
test("nextDeadlineEvent picks payment_timeout and auto_release only when due", () => { /* 4 cases */ });
```

- [ ] **Step 2:** Run `npm test -- tests/orders/rules.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/orders/rules.ts` as a lookup over the table above.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add order rules"`

---

### Task 4: Phone numbers, languages and formatting

**Files:** Create `lib/phone.ts`, `lib/i18n/index.ts`, `lib/i18n/format.ts`, `lib/i18n/strings/{en,lg,sw,nyn}.ts`, `lib/sms/fit.ts`, `tests/phone.test.ts`, `tests/i18n.test.ts`

**Interfaces:**
- Produces:
  - `normalizeUgPhone(input: string): string | null` → `"+256772123456"` or null.
  - `networkOf(e164: string): "MTN" | "AIRTEL" | null`
  - `LANGS = ["en", "lg", "sw", "nyn"] as const; type Lang = typeof LANGS[number]`
  - `t(lang: Lang, key: string, vars?: Record<string, string | number>): string` — `{name}` placeholders; missing key → English; missing in English → the key.
  - `formatUGX(amount: number): string` → `"1,200,000 UGX"`
  - `formatDate(lang: Lang, d: Date): string` → `"29 Oct"` style using `month.1`…`month.12` keys
  - `formatDateTime(lang: Lang, d: Date): string` → `"25 Oct 14:00"` (Africa/Kampala time)
  - `pickLang(acceptLanguage: string | null, cookie: string | undefined): Lang`
  - `fitsOneSms(text: string): boolean` — GSM-7 → ≤160, else ≤70.

- [ ] **Step 1: Write the failing tests:**

```ts
test.each(["0772 123456", "772123456", "+256 772-123-456", "256772123456"])("%s normalises", (s) =>
  expect(normalizeUgPhone(s)).toBe("+256772123456"));
test.each(["0712", "+254712345678", "abc", "07721234567"])("%s refused", (s) => expect(normalizeUgPhone(s)).toBeNull());
test("networks", () => {
  expect(networkOf("+256772123456")).toBe("MTN"); expect(networkOf("+256752123456")).toBe("AIRTEL");
  expect(networkOf("+256712123456")).toBeNull();
});
test("every language has every English key with the same placeholders", () => { /* loop over STRINGS */ });
test("every sms.* string fits one SMS in every language with sample values", () => {
  // vars: { amount: "99,999,999 UGX", product: "Irish potatoes", order: "AL-000123", date: "25 Oct 14:00" }
});
test("formatUGX", () => expect(formatUGX(1200000)).toBe("1,200,000 UGX"));
test("missing key falls back to English", () => { /* temporarily missing lg key */ });
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Strings files start with the keys needed by Tasks 5–14 (each later task adds its keys to all four files). Luganda, Kiswahili and Runyankole files carry the header comment `// DRAFT: native speaker review required before launch (spec §15).`
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add phone, language and formatting helpers"`

---

### Task 5: SMS

**Files:** Create `lib/sms/index.ts`, `lib/sms/fake.ts`, `lib/sms/africastalking.ts`, `tests/sms.test.ts`

**Interfaces:**
- Consumes: `t`, `fitsOneSms` (Task 4), `config.smsProvider`.
- Produces: `sendSms(to: string, lang: Lang, key: string, vars?: Record<string, string | number>): Promise<{ ok: boolean; error?: string }>`; fake exposes `fakeSmsOutbox: { to: string; text: string }[]` and `clearFakeSms()`.

- [ ] **Step 1: Write the failing tests:** fake records rendered text in the recipient's language; a text that does not fit one SMS throws at send time (guards against untested templates); Africa's Talking adapter builds a POST to `https://api.africastalking.com/version1/messaging` with form fields `username`, `to`, `message`, `from` and header `apiKey` (assert on a mocked `fetch`), and returns `{ ok: false }` on non-2xx without throwing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; `sendSms` picks the adapter from `config.smsProvider`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add SMS sending"`

---

### Task 6: Sign-in

**Files:** Create `lib/auth/otp.ts`, `lib/auth/session.ts`, `lib/auth/guard.ts`, `app/api/auth/request/route.ts`, `app/api/auth/verify/route.ts`, `app/api/auth/signout/route.ts`, `app/api/me/route.ts`, `app/signin/page.tsx`, `tests/auth.test.ts`

**Interfaces:**
- Consumes: `normalizeUgPhone`, `sendSms`, `query`.
- Produces:
  - `requestOtp(phoneInput: string, lang: Lang): Promise<{ ok: true } | { ok: false; reason: "bad_phone" | "too_many" }>`
  - `verifyOtp(phoneInput: string, code: string): Promise<{ ok: true; userId: string; isNew: boolean } | { ok: false; reason: "wrong_code" | "expired" | "too_many_tries" }>`
  - `createSessionCookie(userId: string): Promise<string>` (cookie `al_session`, httpOnly, secure, sameSite lax, 30 days, signed with `SESSION_SECRET` via `jose`)
  - `getUser(req: Request | NextRequest): Promise<User | null>` where `User = { id: string; phone: string; name: string | null; role: "farmer" | "buyer" | "admin" | "agent"; district: string | null; language: Lang; payoutPhone: string | null }`
  - `requireUser(req, roles?: User["role"][]): Promise<User>` — throws `HttpError(401|403)`; route handlers turn `HttpError` into a JSON response.
  - `PATCH /api/me` sets `name`, `role` (farmer|buyer, first time only), `district`, `language`.

- [ ] **Step 1: Write the failing tests:** code stored only as an HMAC (`OTP_SECRET`) hash; correct code within 10 min signs in and creates the user once; wrong code 5 times locks that code; 4th request within 15 min returns `too_many`; expired code refused; the SMS goes out in the requested language; the same phone in two formats is one user (Review Focus 4); a user cannot change role from farmer to buyer after it is set.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the modules and routes; sign-in page: phone → code → (first time) farmer/buyer, name, district, all text via `t`.
- [ ] **Step 4:** Run tests. Expected: PASS. Manually: `npm run dev` with `SMS_PROVIDER=fake`, sign in using the code printed in the server log.
- [ ] **Step 5: Commit** `git commit -m "Add phone sign-in"`

---

### Task 7: Products and listings

**Files:** Create `app/api/listings/route.ts`, `app/page.tsx` (browse), `app/listings/new/page.tsx`, `tests/listings.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `query`, `t`, `formatUGX`.
- Produces:
  - `GET /api/listings?product=<id>&district=<name>` → active listings with product name in the reader's language.
  - `POST /api/listings` (farmer) body `{ productId, quantity, unit, pricePerUnit, district, description?, photoUrl? }` → `{ id }`. Validated with `zod`: quantity and price positive integers, unit in the product's `units`.
  - `createListing(farmerId: string, input: ListingInput, postedBy: string): Promise<string>` in `lib/listings.ts` (reused by the admin task).

- [ ] **Step 1: Write the failing tests:** farmer can post; buyer cannot (403); bad unit refused; browse filters by product and district; sold-out and withdrawn listings hidden; product names come back in Luganda for a Luganda reader.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Photo upload stores to Vercel Blob (`@vercel/blob`, public) and saves the URL; skip if no file.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add product catalogue and listings"`

---

### Task 8: Apply order events (locked) and create orders

**Files:** Create `lib/orders/apply.ts`, `lib/actions.ts`, `app/api/orders/route.ts`, `tests/orders/apply.test.ts`

**Interfaces:**
- Consumes: `transition` (Task 3), `computeAmounts` (Task 2), `withTransaction`.
- Produces:
  - `createOrder(buyerId: string, listingId: string, quantity: number): Promise<{ ok: true; orderId: string } | { ok: false; reason: "not_enough" | "own_listing" | "listing_unavailable" }>` — locks the listing row, reserves quantity, stores amounts (commission and fee percents from `config`), state `ordered`.
  - `applyEvent(orderId: string, event: OrderEvent, actor: Actor, opts?: { tx?: Tx }): Promise<{ ok: true; state: OrderState } | { ok: false; reason: TransitionError | "not_found" }>` — `SELECT … FOR UPDATE`, `transition(…, new Date())`, update order (`state`, `deadline_at`, transporter fields), insert `order_events`, insert one `payments` row per payout/refund effect (`status 'pending'`, `reference = <orderId>-<kind>-1`), restore listing quantity on `release_stock`, queue notifications via `notifyOrderEvent` (Task 12; until then a no-op import). Never calls outside services.
  - `withAction<T>(actionId: string | undefined, userId: string, action: string, fn: () => Promise<T>): Promise<T>` — if `actionId` was seen, return the stored result; otherwise run and store (`synced_actions`).
  - `POST /api/orders` (buyer) `{ listingId, quantity, actionId? }`.

- [ ] **Step 1: Write the failing tests:** an allowed event updates state, deadline and history; a refused event changes nothing; 20 concurrent `applyEvent(charge_confirmed)` on one order produce exactly one `paid` and one history row (Review Focus 2); two concurrent orders for the last 10 bags (each 10) → one succeeds, one `not_enough`, stock 0 (Review Focus 3); buyer cannot order own listing; `release_stock` returns the quantity; the same `actionId` twice returns the first result and creates one order.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Apply order events under a row lock; create orders"`

---

### Task 9: Payments (Flutterwave and fake), paying and the webhook

**Files:** Create `lib/payments/types.ts`, `lib/payments/fake.ts`, `lib/payments/flutterwave.ts`, `lib/payments/index.ts`, `app/api/orders/[id]/pay/route.ts`, `app/api/webhooks/flutterwave/route.ts`, `tests/payments/flutterwave.test.ts`, `tests/payments/pay.test.ts`

**Interfaces:**
- Consumes: `applyEvent`, `networkOf`, `config`.
- Produces:

```ts
export interface PaymentProvider {
  startCharge(p: { reference: string; amount: number; phone: string; network: "MTN" | "AIRTEL"; email: string }):
    Promise<{ status: "pending" | "failed"; providerRef?: string; error?: string }>;
  verifyCharge(reference: string):
    Promise<{ status: "successful" | "pending" | "failed"; amount: number; currency: string; providerRef?: string }>;
  transfer(p: { reference: string; amount: number; phone: string; narration: string }):
    Promise<{ status: "pending" | "successful" | "failed"; providerRef?: string; error?: string }>;
  verifyTransfer(reference: string): Promise<{ status: "successful" | "pending" | "failed" }>;
  refund(p: { reference: string; chargeProviderRef: string; amount: number }):
    Promise<{ status: "pending" | "successful" | "failed"; error?: string }>;
  verifyWebhook(headers: Headers): boolean;
}
export function getProvider(): PaymentProvider;
```

  Fake provider: in-memory, controllable from tests (`fake.setNextCharge("failed")`, `fake.completeCharge(ref)`, `fake.failTransfers(n)`), always `UGX`.
  `POST /api/orders/[id]/pay` (buyer): `applyEvent(start_payment)`, then `startCharge` with `reference = <orderId>-charge`, `email = <phone digits>@buyers.agrilink.ug` (Flutterwave requires an email). On `failed` → `applyEvent(charge_failed)`.
  Webhook: if `verifyWebhook` fails → 401. Else take `tx_ref`, call `verifyCharge`; only if `status === "successful"`, `currency === "UGX"` and `amount === order.total` → `applyEvent(charge_confirmed)`; a successful charge with the wrong amount is logged and flagged for admin, never confirmed. Always 200 after processing so Flutterwave stops retrying.

- [ ] **Step 1: Verify the Flutterwave API shapes** against Flutterwave's current v3 documentation and record them in a comment at the top of `lib/payments/flutterwave.ts`: mobile money charge `POST /v3/charges?type=mobile_money_uganda` (`tx_ref`, `amount`, `currency: "UGX"`, `email`, `phone_number`, `network`); verify `GET /v3/transactions/verify_by_reference?tx_ref=`; transfer `POST /v3/transfers` (`account_bank: "MPS"`, `account_number`, `amount`, `currency`, `reference`, `narration`); transfer status `GET /v3/transfers?reference=` ; refund `POST /v3/transactions/{id}/refund` (`amount`); webhook header `verif-hash` equals `FLW_WEBHOOK_HASH`. If any differ, use the documented shape and update this plan's comment.
- [ ] **Step 2: Write the failing tests:** adapter request bodies and headers (mocked `fetch`, `Authorization: Bearer FLW_SECRET_KEY`); webhook with wrong hash → 401 and no state change; webhook with right hash but `verifyCharge` amount ≠ total → order stays `awaiting_payment`; good webhook → `paid` and farmer SMS; webhook arriving after timeout cancellation → `refunding` (Review Focus 1); Airtel number charged with `network: "AIRTEL"`; unsupported network → 400 with translated message.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Add Flutterwave payments, paying and webhook"`

---

### Task 10: Payouts and refunds

**Files:** Create `lib/payments/settle.ts`, `tests/payments/settle.test.ts`

**Interfaces:**
- Consumes: `getProvider`, `applyEvent`, `query`.
- Produces: `settleOrder(orderId: string): Promise<void>` — for each `payments` row of the order with status `pending` or `retry_due`: call `transfer` (payout, to the farmer's `payout_phone`) or `refund` (to the original charge); on success mark `successful`; on failure increment `attempts`, set `next_attempt_at = now + 60 min`, and after attempt 3 set status `stuck` and notify admins. When no payout/refund rows remain unfinished, `applyEvent(settlement_done, { farmerPaid })` where `farmerPaid` = any successful payout. Each attempt uses reference `<orderId>-<kind>-<attempt>`. Before re-attempting a payout whose previous attempt is `pending` at Flutterwave, call `verifyTransfer` first so a slow success is not paid twice.
  Called right after `applyEvent` returns effects (in the route) and by the scheduled job.

- [ ] **Step 1: Write the failing tests:** confirmed order → payout of exactly the subtotal to the farmer's payout phone → `completed`; split → payout F and refund rest → `completed`; refund-only → `refunded`; transfer fails twice then succeeds → 3 attempts, `completed`; fails 3 times → `stuck`, admin notified, order stays `releasing`; previous attempt still pending at provider and then reported successful → no second transfer.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add payouts and refunds with safe retries"`

---

### Task 11: Order actions, deadlines and the scheduled job

**Files:** Create `lib/orders/deadlines.ts`, `app/api/orders/[id]/{send,deliver,confirm,dispute,cancel}/route.ts`, `app/api/cron/tick/route.ts`, `vercel.json`, `tests/orders/actions.test.ts`, `tests/cron.test.ts`

**Interfaces:**
- Consumes: `applyEvent`, `nextDeadlineEvent`, `settleOrder`, `getProvider().verifyCharge`, `withAction`.
- Produces:
  - `applyDueDeadlines(orderId: string): Promise<void>` — applies `nextDeadlineEvent` if due, then `settleOrder` if needed. Called at the start of every order read and action (Review Focus 5).
  - Action routes: each `requireUser`, checks the user is this order's buyer/farmer, wraps in `withAction(body.actionId, …)`, calls `applyEvent`, then `settleOrder` when effects were produced. Refusals return `{ error: <translated text> }` with status 409.
    - `send` (farmer) body `{ transporterName?, transporterPhone? }`; `deliver` (farmer); `confirm` (buyer); `dispute` (buyer) body `{ note }` (required, ≤ 1000 chars); `cancel` (buyer, only after the 7-day send deadline).
  - `GET /api/cron/tick` — requires `Authorization: Bearer ${CRON_SECRET}`; for every order with a passed `deadline_at` in `awaiting_payment` or `delivered`: `applyDueDeadlines`; for every `awaiting_payment` order older than 2 minutes: `verifyCharge` and confirm if successful (lost webhook); for every payment with `status = 'retry_due'` and `next_attempt_at ≤ now`: `settleOrder`. Returns counts.
  - `vercel.json` cron `{"path": "/api/cron/tick", "schedule": "*/15 * * * *"}`. README notes this needs a Vercel Pro plan; on Hobby use an external scheduler hitting the same URL with the secret.

- [ ] **Step 1: Write the failing tests:** each action by the right person moves the order; by the wrong person → 403; dispute after 3 days → 409 with translated reason; cancel before 7 days → 409; cron without secret → 401; cron cancels an unpaid order after 30 min and releases stock; cron recovers a paid order whose webhook never came; cron auto-releases after 3 days; opening an overdue `delivered` order via `GET /api/orders/[id]` auto-releases it without cron (Review Focus 5).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add order actions, deadlines and scheduled job"`

---

### Task 12: Notifications and following

**Files:** Create `lib/notify.ts`, `app/api/notifications/route.ts`, `app/api/follows/route.ts`, `app/notifications/page.tsx`, `app/following/page.tsx`, `components/Bell.tsx`, `tests/notify.test.ts`

**Interfaces:**
- Consumes: `sendSms`, `t`, `query`.
- Produces:
  - `notify(userId: string, kind: string, titleKey: string, bodyKey: string, vars: Record<string, string | number>, link: string, opts: { sms: boolean }): Promise<void>` — always stores an in-app row (keys + vars); sends SMS in the user's language when `opts.sms`.
  - `notifyOrderEvent(orderId: string, to: OrderState): Promise<void>` — table: `paid` → farmer (SMS); `in_transit` → buyer (SMS); `delivered` → buyer (SMS, includes the 3-day end time); `disputed` → farmer and admins (SMS); `completed` → farmer "money sent" (SMS); `refunded` → buyer (SMS); `cancelled` → buyer (in-app only).
  - `notifyFollowers(kind: "new_listing" | "new_product" | "new_price", productId: string | null, district: string | null, vars): Promise<void>` — in-app for matching followers (product match; district match if the follow has one; `new_product` goes to everyone); SMS only where the follow has `sms_enabled`.
  - `GET /api/notifications` (rendered in the reader's language, newest first, unread count); `POST /api/notifications/read`; `GET/PUT /api/follows`.
  - Wire `notifyOrderEvent` into `applyEvent` (after commit) and `notifyFollowers("new_listing")` into `createListing`.

- [ ] **Step 1: Write the failing tests:** each state in the table notifies the right people, with SMS only where listed; notification text renders in the reader's current language even if they changed language after it was created; follower in another district not notified when the follow names a district; follower with SMS off gets in-app only; new product reaches everyone in-app.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, including the bell (unread count) in `app/layout.tsx`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add notifications and following"`

---

### Task 13: Order pages and messages

**Files:** Create `app/orders/page.tsx`, `app/orders/[id]/page.tsx`, `app/api/orders/[id]/route.ts`, `app/api/orders/[id]/messages/route.ts`, `app/settings/page.tsx`, `tests/orders/pages.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `GET /api/orders/[id]` (buyer, farmer of that order, or admin): order, amounts, history, messages; runs `applyDueDeadlines` first. Other users → 404 (not 403, so order ids are not confirmable).
  - `GET /api/orders?view=mine|coming` — `coming` = buyer's orders in `in_transit`.
  - `POST /api/orders/[id]/messages` `{ text, actionId? }` (buyer or farmer of the order; ≤ 1000 chars); notifies the other party in-app.
  - Order page: steps in plain words (e.g. `t("order.paid.farmer", { date })` → "Paid. Money is safe with AgriLink. Send by 29 Oct."), one main button for the next action, price breakdown for buyers (price, AgriLink 3%, mobile money fee, total), messages, "I received it" / "Report a problem" after delivery.
  - Settings: name, district, language, payout number (changing it sends a code to the new number and only saves after it is confirmed).

- [ ] **Step 1: Write the failing tests:** a stranger gets 404 for someone else's order; messages only between the order's buyer and farmer; payout number change requires the code sent to the new number; "coming to me" lists only the buyer's in-transit orders.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement routes and pages (all text via `t`, mobile-first, large buttons).
- [ ] **Step 4:** Run. Expected: PASS. Manually click through a full order on `npm run dev` with both fakes, as farmer and buyer in two browsers.
- [ ] **Step 5: Commit** `git commit -m "Add order pages, messages and settings"`

---

### Task 14: Admin

**Files:** Create `app/admin/{disputes,payouts,orders,listings,products}/page.tsx`, `app/api/admin/{resolve,retry,orders,listings,products}/route.ts`, `tests/admin.test.ts`

**Interfaces:**
- Consumes: `applyEvent`, `settleOrder`, `createListing`, `notifyFollowers`, `requireUser(req, ["admin"])` (listings also allow `agent`).
- Produces:
  - `POST /api/admin/resolve` `{ orderId, decision, farmerAmount? }` → `applyEvent(admin_resolve)` then `settleOrder`.
  - `POST /api/admin/retry` `{ paymentId }` → resets a `stuck` row to `retry_due` with attempts 0 and calls `settleOrder`.
  - `GET /api/admin/orders?q=` search by order id or phone; full history.
  - `POST /api/admin/listings` `{ farmerPhone, …ListingInput }` → sends a code to the farmer; `POST /api/admin/listings/confirm` `{ farmerPhone, code }` creates the farmer account if needed and the listing with `posted_by` = the admin/agent; payouts always go to the farmer's own number.
  - `POST /api/admin/products` `{ name_en, name_lg?, name_sw?, name_nyn?, units }` → `notifyFollowers("new_product")`.
  - Every admin action writes an `order_events` row (or an audit row for products/listings) with the admin's id.

- [ ] **Step 1: Write the failing tests:** non-admin gets 403 on every admin route; agent can post listings but cannot resolve disputes; resolve split with F above the subtotal → 400; listing for a farmer is not created until the farmer's code is confirmed; new product notifies everyone.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (English only).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add admin pages"`

---

### Task 15: End-to-end checks and launch runbook

**Files:** Create `tests/e2e/escrow.test.ts`, `docs/runbook-flutterwave-sandbox.md`

**Interfaces:**
- Consumes: all routes, fake providers.

- [ ] **Step 1: Write the end-to-end tests** calling the route handlers in sequence with fake payment and SMS providers (no mocks of our own modules):
  - happy path: sign in farmer and buyer → list 50 bags at 60,000 → buyer orders 50 → pays → webhook → farmer sent → delivered → buyer confirms → farmer paid exactly 3,000,000; buyer charged 3,000,000 + 90,000 + fee; SMS in each user's language
  - payment declined → cancelled, stock back to 50
  - webhook lost → cron recovers
  - payout fails 3 times → stuck → admin retry → completed
  - dispute → each admin decision (pay, refund, split 1,000,000)
  - farmer never sends → after 7 days buyer cancels → refunded in full
  - buyer silent → after 3 days cron auto-releases
- [ ] **Step 2:** Run `npm test`. Expected: all PASS. Run `npm run build`. Expected: success.
- [ ] **Step 3:** Write `docs/runbook-flutterwave-sandbox.md`: set `PAYMENT_PROVIDER=flutterwave` with test keys, point the Flutterwave webhook at the deployed `/api/webhooks/flutterwave`, run the happy path and a refund with Flutterwave's test mobile money numbers, and the checklist from spec §15 that must be done before live keys are used.
- [ ] **Step 4: Commit** `git commit -m "Add end-to-end escrow tests and sandbox runbook"`
