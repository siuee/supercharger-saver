# Supercharger Saver

Find nearby Tesla Superchargers and compare **when** it’s cheapest to charge — without logging into Tesla.

**Live app:** [https://supercharger-saver.vercel.app](https://supercharger-saver.vercel.app)

## What this project does

Supercharger Saver is a simple website that helps everyday drivers answer one practical question:

> “Which Supercharger near me is the best deal right now — or a little later today?”

Tesla Supercharger prices often change by time of day (cheaper overnight, more expensive in the afternoon). Checking that station-by-station in the Tesla app is slow. This app does the comparison for you.

### How it helps normal people

- **Saves money** — Shows the rate **now** vs the **lowest published window** over the next 24 hours, so you can wait for a cheaper slot when it makes sense.
- **Saves time** — Enter a city, ZIP, or use GPS once. See nearby stops ranked by price or distance instead of opening every pin yourself.
- **Clear for real trips** — Pick Tesla vehicle rates or non-member rates, filter by charging speed, and open directions when you’re ready to go.
- **No Tesla account needed** — Public station and schedule data only. No login, no passwords, no tracking of your trips.
- **Works for many people at once** — Anyone in the US can search their own area; everyone reads from the same shared price cache.

### What the app does (in plain terms)

1. Finds open Superchargers near your location (10–100 mile radius).
2. Shows published per-kWh schedules when available (member / non-member).
3. Ranks stops by **cheapest now**, **lowest in 24h**, **earliest cheap window**, or **nearest**.
4. Estimates energy cost for a charge size you choose (for example 40 kWh).
5. Lets you open Google Maps directions or the official Tesla station page.

**Tip:** Always confirm the live session price in Tesla before you plug in. Rates can change, and this tool does not invent prices.

---

## Concurrent multi-user design

Many people can search different cities at the same time. Everyone reads one **shared Redis database** on Upstash:

| Redis key | Purpose |
|---|---|
| `scs:catalog` | All open station locations |
| `scs:station:{id}` | That station’s schedules (TTL 7 days) |
| `scs:watched` | Station IDs anyone searched (last 30 days) |
| `scs:priced-ids` | IDs that currently have schedules |
| `scs:last-sync` / `scs:sync-cursor` | Daily cloud job status and rotation |

There are **no per-user tables**. A request with `lat`/`lng` filters the shared catalog and `MGET`s prices. User searches never call Scrapfly/Tesla live.

## Cloud-only daily refresh

1. **Reads (all visitors):** `/api/stations` returns nearby stations **with prices inline** from Redis.
2. **Writes (Vercel Cron once/day):** `/api/sync` refreshes up to `SYNC_DAILY_LIMIT` **stale / missing** watched stations via Scrapfly (default **1**/day ≈ 30/month on free Scrapfly ASP credits).
3. Hottest searched stations are preferred so popular areas stay covered first.

Schedules up to **48 hours** old stay rankable in the UI. Already-cached rates keep serving every concurrent user even when the free credit budget is tight.

## Deploy on Vercel

1. Import the repo. Framework **Other**, build `npm run build`, output `public`, Node **22.x**.
2. Create Upstash Redis. Set production env:

   ```text
   UPSTASH_REDIS_REST_URL=https://YOUR-DATABASE.upstash.io
   UPSTASH_REDIS_REST_TOKEN=YOUR-PRIVATE-TOKEN
   CRON_SECRET=YOUR-RANDOM-SECRET
   SYNC_DAILY_LIMIT=1
   SCRAPFLY_KEY=your-scrapfly-key
   ```

3. Deploy. Cron runs `/api/sync` daily (`17 6 * * *` UTC in `vercel.json`).
4. Open the site and search a few areas (fills `scs:watched`). The next cron (or a manual authenticated sync) fills rates in the cloud.

Without Redis + `CRON_SECRET` + `SCRAPFLY_KEY`, locations still work; live Tesla prices cannot be refreshed from Vercel’s network alone.

## Free-tier budget note

Scrapfly free ASP refreshes cost ~25 credits each (~40/month). Keeping `SYNC_DAILY_LIMIT=1` stays inside that. Raising the limit burns credits faster; cached Redis prices still serve all users.

## Ranking

- **Cheapest now** / **Lowest in 24h** / **Earliest & cheapest nearby** / **Nearest**
- Only complete daily per-kWh schedules are ranked
- Confirm session price in Tesla before charging

## Privacy

GPS is used only to filter nearby stations. Redis stores station IDs and published schedules, not user coordinates or accounts. Cron/ingest require a timing-safe bearer secret.

## Local development

```sh
npm ci
npm test
npm run build
npm run dev
```

Copy `.env.example` → `.env.local` for Redis-backed local runs.

Optional advanced: `scripts/daily-sync.mjs` can still push bulk ingest from elsewhere, but normal operation is **Vercel cron only**.

Independent project; not affiliated with Tesla.
