# AgriLink escrow marketplace: design

Date: 2026-10-22
Status: approved in conversation, awaiting written review

## 1. Purpose

AgriLink connects Ugandan farmers to buyers. Real farmers and buyers will use it soon, so money, identity and records must be handled for real, not simulated.

The full product has three parts, built as separate projects in this order:

1. **Escrow marketplace (this document).** Buyers pay through mobile money, AgriLink holds the money until delivery, then pays the farmer.
2. **Market prices (later).** Prices per product per market, from the public WFP/FAO Uganda dataset (monthly) plus prices entered by admins (fresher). Anyone can browse and compare.
3. **Full listings and growth features (later).** Richer listings, paid price alerts, featured listings, partner data fees, more languages.

This project includes a minimal listing (enough for a buyer to order something) that project 3 extends.

### What the user said vs. what is assumed

Said by the product owner:
- Real users soon; prices from both a public dataset and admins (project 2).
- Keep escrow payments, built for Flutterwave.
- Release rule: buyer confirms, or automatic release 3 days after delivery; disputes go to an admin.
- Sign-in by phone number and SMS code.
- Next.js + Neon Postgres + Vercel.
- Voice notes for farmers who cannot type: on listings, on delivery and disputes, in order messages, with transcription by Sunbird AI.
- AgriLink earns a 3% commission, paid by the buyer on top of the price.
- AI features: speak a listing, fair price suggestion, dispute summary for admins, help assistant (section 11).
- Notifications for goods in transit, and for listings, products and prices added by admins. In-app for everything, SMS for order updates.
- Multilingual from launch: English, Luganda, Kiswahili and Runyankole (section 10).

Assumed (to be corrected if wrong):
- Uganda only, prices in whole Uganda shillings (UGX).
- Most users are on Android phones with slow or intermittent data.
- Admin pages are English only; everything farmers and buyers see or receive is translated.

### Success criteria

- A buyer can pay for a listing with MTN or Airtel mobile money, and the farmer is paid exactly the listed price after delivery, with no manual steps in the normal case.
- No order can ever pay a farmer twice, pay without a confirmed charge, or lose track of held money.
- A farmer who cannot type can list produce, explain a delivery and answer a dispute by voice.
- Buyers see what is in transit to them; followers hear about new listings and products.
- Every order has a complete, unchangeable history an admin can read.

## 2. Order life cycle

An order moves through fixed states. Every change is written to the order history with the actor and time.

| State | Meaning | Leaves by |
|---|---|---|
| `ordered` | Buyer chose a listing and quantity. Price, fee and total are fixed now. Listing quantity is reserved. | Payment started → `awaiting_payment` |
| `awaiting_payment` | Flutterwave has sent the buyer a mobile money prompt. | Charge confirmed → `paid`. Failed, declined or 30 minutes passed → `cancelled` (quantity released, nothing charged). |
| `paid` | Money is held. Farmer notified by SMS. | Farmer taps "I've sent it" → `in_transit`. Not sent within 7 days of payment → buyer may cancel → `refunding`. |
| `in_transit` | Produce has left the farmer. Optional transporter name, phone, voice note. Buyer notified. | Farmer taps "Delivered" → `delivered`. |
| `delivered` | Buyer notified: confirm or report a problem within 3 days. | Buyer confirms, or 3 days pass → `releasing`. Buyer reports a problem within 3 days → `disputed`. |
| `disputed` | Money frozen. Both sides can add text or voice. | Admin decides: pay farmer → `releasing`; refund buyer → `refunding`; split → `releasing` and `refunding` for the two parts. |
| `releasing` | Payout to the farmer's mobile money number in progress. | Transfer confirmed → `completed`. Failed 3 times over 3 hours → stays `releasing`, flagged for admin. |
| `refunding` | Refund to the buyer in progress. | Refund confirmed → `refunded`. Repeated failure → flagged for admin. |
| `completed`, `refunded`, `cancelled` | Final. | None. |

Rules:
- Only the order rules module may change a state. Any transition not in this table is refused.
- Deadlines (30 minutes, 7 days, 3 days) are stored on the order when the state is entered, so later changes to settings do not alter existing orders.

## 3. Money

- **Buyer pays:** listed price + AgriLink commission (3%) + Flutterwave's mobile money fee. The breakdown is shown before the buyer approves.
- **Farmer receives:** exactly the listed price, to the payout number confirmed on their account.
- **AgriLink keeps:** the 3%, settled to AgriLink's own account.
- **Refunds:** the buyer receives back everything they paid. Flutterwave does not return its fee on a refund, so AgriLink covers it from commission income.
- **Split decisions:** the admin enters the amount for the farmer (F, between 0 and the subtotal). AgriLink keeps commission only on F: `round(F × commission percent / 100)`. The buyer is refunded the rest: `total paid − F − commission on F`. The three parts always add up to the total paid.
- **Commission setting:** one configuration value (`COMMISSION_PERCENT`, default 3, may be 0). Stored on each order at creation.
- All amounts are whole shillings (integers). No decimals anywhere in money handling.

## 4. Safety of money

- **One change at a time per order.** Every state change runs in a database transaction that locks the order row (`SELECT … FOR UPDATE`), then re-checks the state. If a webhook and the hourly job arrive together, the second one sees the order has moved and does nothing.
- **Webhooks are checked twice.** A Flutterwave webhook is accepted only if its `verif-hash` header matches our secret, and the charge is then confirmed by calling Flutterwave's verify endpoint. The amount and currency must match the order exactly.
- **No double payouts.** Each payout and refund uses a unique reference (`order id + kind + attempt`), so a repeated request is ignored by Flutterwave.
- **No lost payments.** The hourly job asks Flutterwave about every order still `awaiting_payment`, so a missed webhook cannot strand a paid order.
- **Every money movement is recorded** in a payments table with the provider's reference and raw response.

## 5. Parts of the system

| Part | One job | Depends on |
|---|---|---|
| `lib/orders` (order rules) | Allowed transitions, deadlines, amounts. Pure functions, plus one function that applies a transition inside a locked transaction. | database |
| `lib/payments` | Charge buyer, verify charge, pay farmer, refund buyer. One interface with two implementations: `flutterwave` and `fake` (for development and tests). | Flutterwave API |
| `lib/sms` | Send sign-in codes and order SMS through Africa's Talking. A fake that logs messages in development. | Africa's Talking |
| `lib/voice` | Store recordings privately, create short-lived playback links, request transcription and translation from Sunbird AI. | Vercel Blob, Sunbird AI |
| `lib/auth` | Phone + SMS code sign-in, sessions in a signed cookie, roles: `farmer`, `buyer`, `admin`, `agent`. | `lib/sms`, database |
| `lib/ai` | Calls Claude for listing extraction, price explanations, dispute summaries and the help assistant. Server only; per-user daily limits; falls back cleanly when unavailable. | Anthropic API, database |
| `lib/notify` | Create in-app notifications; decide which also go by SMS; follower matching for new listings, products and prices. | `lib/sms`, database |
| Scheduled job (`/api/cron/tick`, hourly via Vercel Cron) | Cancel unpaid orders after 30 minutes, check `awaiting_payment` orders with Flutterwave, auto-release after 3 days, retry payouts and refunds, retry SMS and transcriptions. | all of the above |
| Admin pages | Disputes, stuck payouts and refunds, order lookup and history, post listings for farmers, manage the product catalogue. | all of the above |

## 6. Data (Neon Postgres)

- `users`: id, phone (unique, E.164), name, role, district, language (`en`, `lg`, `sw`, `nyn`), payout phone, payout confirmed at, created at.
- `otp_codes`: phone, code hash, expires at, attempts.
- `products`: id, names in each language, unit options, picture, added by, added at.
- `listings`: id, farmer id, product id, quantity available, unit, price per unit (UGX), district, photo, text description, voice note id, posted by (farmer or admin/agent), status (`active`, `sold_out`, `withdrawn`).
- `orders`: id, listing id, buyer id, farmer id, quantity, unit price, subtotal, commission percent, commission, provider fee, total, state, state deadline, transporter name, transporter phone, created at.
- `order_events` (append only): order id, from state, to state, actor id or `system`, note, voice note id, created at.
- `payments`: id, order id, kind (`charge`, `payout`, `refund`), amount, provider reference (unique), status, attempts, raw response, created at, updated at.
- `messages`: id, order id, sender id, text, voice note id, created at.
- `voice_notes`: id, owner id, storage key, duration seconds, transcript, detected language, translations (one per launch language, filled as listeners need them), transcription status, created at.
- `follows`: user id, product id, district (optional), sms enabled.
- `notifications`: id, user id, kind, title, body, link, read at, sms status, created at.

## 7. Screens

Phone first: large buttons, short text, works on slow connections.

- **Language picker:** on the first screen and in settings: English, Luganda, Kiswahili, Runyankole.
- **Sign in:** phone number → SMS code → (first time) farmer or buyer, name, district.
- **Browse listings:** crop, quantity, price, district, photo, voice play button with transcript. Filter by crop and district.
- **Farmer, new listing:** crop from a picture list, quantity and unit, price, district, optional photo, then a large microphone button ("Describe it") or typing.
- **Farmer, my orders:** each order's state in plain words with one main button for the next action ("I've sent it", "Delivered").
- **Farmer, payout number:** confirmed once by SMS code.
- **Buyer, order:** quantity, full price breakdown, Pay, then approve on the phone.
- **Buyer, order page:** progress steps, messages (text or voice), and after delivery "I received it" / "Report a problem".
- **Buyer, coming to me:** everything currently `in_transit` to this buyer.
- **Notifications:** bell icon with unread count on every screen; following page (crops, districts, SMS for new listings on or off).
- **Admin:** disputes (both sides' messages and voice with transcripts; pay farmer / refund / split), stuck payouts and refunds (retry), order lookup with full history, post a listing for a farmer (farmer confirms by SMS code; payout goes to the farmer's own number), product catalogue.

## 8. Voice notes

- Recorded in the browser (MediaRecorder), maximum 2 minutes, uploaded to private storage.
- Used on listings (public, like the listing), in order messages, on "I've sent it" / delivery, and in disputes (private to that order's buyer, farmer and admins).
- Playback through short-lived signed links checked against the viewer's access.
- After upload, sent to Sunbird AI for transcription (Luganda, Runyankole, Acholi, Lugbara, Ateso, English) and English translation. Text is shown under the player, marked "automatic transcription, may contain mistakes". The recording is always kept. If Sunbird is unavailable, the note works without text and transcription is retried by the hourly job.

## 9. Notifications

| Event | Who | In-app | SMS |
|---|---|---|---|
| Order paid, in transit, delivered, problem reported, admin decision, money sent, refund sent | That order's buyer and/or farmer | yes | yes |
| New listing (including posted by admin or agent) | Followers of that product (and district, if set) | yes | only if the follower turned SMS on |
| New product in catalogue | Everyone | yes | only if SMS on |
| New price for a followed product | Followers | yes | only if SMS on (switches on with the market prices project) |

## 10. Languages

Launch languages: **English (`en`), Luganda (`lg`), Kiswahili (`sw`), Runyankole (`nyn`).**

- **Choosing:** a language picker on the first screen (before sign-in) and in settings. The choice is saved on the user's account (`users.language`) and in the browser, so it follows them across devices. First visit defaults to the phone's language if it is one of the four, else English.
- **Screens:** every word farmers and buyers see comes from translation files (`lib/strings/en.js`, `lg.js`, `sw.js`, `nyn.js`), keyed by name. No text is written directly in pages. A missing phrase falls back to English rather than showing a blank.
- **SMS:** sign-in codes and order SMS are sent in the recipient's saved language. Each SMS template is checked to fit one SMS (160 characters, or 70 if the language needs special characters) so messages don't split and cost double.
- **Data stays language-neutral:** order states, product ids, units and categories are stored as keys and translated only when shown. Each product in the catalogue has a name in all four languages (admins enter them when adding a product; English is used where one is missing).
- **Numbers, money and dates:** UGX amounts with thousands separators ("1,200,000 UGX"), dates as "29 Oct" style in each language's month names, "3 days" style durations translated.
- **Voice notes:** transcribed in the language spoken and translated into the *listener's* language where Sunbird AI supports it (Luganda, Runyankole and English are supported; Kiswahili support to be confirmed during the build, falling back to English translation).
- **Translation quality:** the Luganda, Kiswahili and Runyankole files are drafted during the build and must be reviewed by native speakers before launch (added to section 14). Words for money and escrow ("held safely", "refund", "dispute") get special care so farmers trust them.
- **Adding a language later** (e.g. Acholi, Ateso, Lugbara): add one strings file and SMS templates, and register it in the language list. No other code changes.

## 11. When things go wrong

- Payment fails, is declined or times out: order `cancelled`, nothing charged, quantity released.
- Webhook never arrives: hourly job verifies with Flutterwave.
- Payout or refund fails: retried 3 times over 3 hours, then flagged to admin; money remains held.
- SMS or Sunbird down: the order still advances; SMS and transcription are retried.
- Simultaneous actions: the row lock lets exactly one through.
- Unexpected errors: plain message to the user, full detail in the server log; money is never moved by a half-finished request.

## 13. Testing

- Unit tests for the order rules: every allowed transition and every refused one (pay twice, release a cancelled order, dispute after 3 days, deliver before sending).
- Amount tests: commission and totals in whole shillings, splits that always add up to what was paid.
- End-to-end tests with the fake payment provider: full happy path, payment failure, lost webhook, payout failure and retry, dispute with each admin decision, 7-day no-send cancellation, 3-day auto-release, two simultaneous actions on one order.
- Language tests: every key in the English file exists in the other three, placeholders such as `{amount}` match, and every SMS template fits one SMS in every language.
- AI checks: a set of about 30 sample farmer transcripts (all four languages) with the correct listing fields, run before each change to the listing prompt; dispute summaries checked against sample disputes for neutrality (no recommendation, both sides represented); help assistant tested with attempts to see another user's orders or to trigger actions, all of which must fail.
- A final run against Flutterwave's sandbox with test numbers before going live.

## 14. Before launch (outside the code)

1. Verified Flutterwave business account with live keys.
2. Legal check on holding funds under the National Payment Systems Act; confirm with Flutterwave whether their licence covers this arrangement.
3. Africa's Talking account with an approved sender name ("AgriLink").
4. Sunbird AI API access.
5. Terms of use covering the 3% fee, the 7-day and 3-day rules, and how disputes are decided, in all four languages.
6. Native speakers review the Luganda, Kiswahili and Runyankole screen text and SMS templates.
7. Anthropic API account and key, with a monthly spending limit set in the Anthropic Console.

## 15. Not in this project

Market prices (project 2), paid price alerts, featured listings, partner and data fees, bulk buyer subscriptions, further languages (Acholi, Ateso, Lugbara), delivery partner integration. The existing escrow demo (`index.html`, `server.js`, `data.json`) is replaced by the new app; its green visual style is kept.
