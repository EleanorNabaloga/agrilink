# AgriLink

AgriLink connects Ugandan farmers to buyers. Buyers pay by mobile money (MTN or Airtel); AgriLink holds the money in escrow until delivery, then pays the farmer. Built with Next.js 14 (App Router, TypeScript), Postgres (Neon), Tailwind CSS and Vitest.

Design: `docs/superpowers/specs/2026-10-22-agrilink-escrow-design.md`.

## Setup

```bash
npm install
cp .env.example .env     # then fill in the values
npm run migrate          # applies db/migrations/*.sql and seeds products
npm run dev
```

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon) |
| `TEST_DATABASE_URL` | Separate database used by `npm test` (see below) |
| `SESSION_SECRET`, `OTP_SECRET`, `CRON_SECRET` | Long random secrets |
| `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH` | Flutterwave |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | Africa's Talking SMS |
| `PAYMENT_PROVIDER` | `fake` (default) or `flutterwave` |
| `SMS_PROVIDER` | `fake` (default) or `africastalking` |
| `COMMISSION_PERCENT` | AgriLink commission, default `3` |
| `PROVIDER_FEE_PERCENT` | Mobile money fee passed to the buyer, default `0` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage |

## Tests

```bash
npm test
```

Tests reset the database on every run, so they must never point at real data. Set `TEST_DATABASE_URL` to a separate database (for Neon, a separate branch). If it is not set, `npm test` starts a throwaway local Postgres using the `embedded-postgres` package and removes it afterwards.
