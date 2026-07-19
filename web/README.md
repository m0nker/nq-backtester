# NQ/ES Replay Backtester

Client-side bar-replay backtesting platform for NQ futures (ES chart-only, for context). Next.js 16 + TypeScript + lightweight-charts, backed by Supabase (Postgres metadata + Storage for gzipped price-data chunks).

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

Set in `.env.local` for local dev, and in Vercel Project Settings → Environment Variables for deploys:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_KEY=...   # publishable/anon key
```

## Deploying

This project deploys from GitHub via Vercel's Git integration (Root Directory: `web`). Push to `main` and Vercel builds automatically.

## Data pipeline

Price data (NQ + ES continuous front-month series, minute and second resolution) is built and uploaded via `../scripts/ingest_dbn.py` (Databento DBN sources) and `../scripts/ingest.mjs` (legacy CSV path). See those scripts for details on roll-adjustment and chunking.
