# Supercharger Saver

Find nearby Tesla Superchargers and compare **when** it’s cheapest to charge — without logging into Tesla.

**Live app:** [https://supercharger-saver.vercel.app](https://supercharger-saver.vercel.app)

**Search / SEO:** Canonical URL, Open Graph + Twitter cards, JSON-LD (WebSite / WebApplication / FAQ), `robots.txt`, and `sitemap.xml` are shipped with the site. After deploy, submit the sitemap in [Google Search Console](https://search.google.com/search-console) → `https://supercharger-saver.vercel.app/sitemap.xml`.

## What this project does

Supercharger Saver is a simple website that helps everyday drivers answer one practical question:

> “Which Supercharger near me is the best deal right now — or a little later today?”

Tesla Supercharger prices often change by time of day (cheaper overnight, more expensive in the afternoon). Checking that station-by-station in the Tesla app is slow. This app does the comparison for you.

### How it helps normal people

- **Saves money** — Shows the rate **now** vs the **lowest published window** over the next 24 hours, so you can wait for a cheaper slot when it makes sense.
- **Saves time** — Enter a city, ZIP, or use GPS once. See nearby stops ranked by price or distance instead of opening every pin yourself.
- **Clear for real trips** — Pick Tesla vehicle rates or non-member rates, filter by charging speed, and open directions when you’re ready to go.
- **No Tesla account needed** — Public station and schedule data only. No login, no passwords, no tracking of your trips.
- **Works for many people at once** — Anyone in the US can search their own area; everyone reads from the same shared price database.

### What the app does (in plain terms)

1. Finds open Superchargers near your location (10–100 mile radius).
2. Shows published per-kWh schedules when available (member / non-member).
3. Ranks stops by **cheapest now**, **lowest in 24h**, **earliest cheap window**, or **nearest**.
4. Estimates energy cost for a charge size you choose (for example 40 kWh).
5. Lets you open Google Maps directions or the official Tesla station page.

**Tip:** Always confirm the live session price in Tesla before you plug in. Rates can change, and this tool does not invent prices.

---

## Architecture (free Neon + GitHub Actions)

| Piece | Role |
|---|---|
| **Neon Postgres** | Source of truth for station prices (`station_prices` + `sync_state`) |
| **GitHub Actions scraper** | Once-daily batch (40–80 stations) via [`.github/workflows/daily-price-scraper.yml`](.github/workflows/daily-price-scraper.yml) |
| **Website (Vercel)** | Reads Neon only — never calls Tesla for visitor requests |

Failed scrapes **never wipe** good prices. When today’s scrape misses a station, the API can serve `previous_prices` with `freshness: "previous"`, and the UI shows **Previous record · retrieved {date}**.

There are **no per-user tables**. A request with `lat`/`lng` filters the shared catalog and joins Neon prices. User searches never call Tesla live.

## Daily scraper

1. Loads US open stations from Supercharge.info.
2. Rotates through the catalog using a Neon `sync_state` cursor.
3. Fetches Tesla `get-charger-details` **directly** (no paid proxy required).
4. UPSERTs successes into Neon; records `last_error` on failure without clearing prices.

Manual run: Actions → **Daily price scraper** → **Run workflow**, or locally:

```sh
npm run migrate
npm run scrape
```

Requires `DATABASE_URL` (and `SCRAPER_BATCH_SIZE` optionally).

## Deploy on Vercel

1. Import the repo. Framework **Other**, build `npm run build`, output `public`, Node **22.x**.
2. Install **Neon** via Vercel Marketplace (free). Env vars including `DATABASE_URL` are injected automatically.
3. Set `CRON_SECRET` (≥24 characters) if you use `/api/sync` or `/api/ingest`.
4. Add the same `DATABASE_URL` to GitHub Actions secrets for the scraper workflow.
5. Deploy. Open the site and search; rates fill as scraper batches succeed.

Without Neon, locations still work; stored prices will be empty until the database and scraper are connected.

## Ranking

- **Cheapest now** / **Lowest in 24h** / **Earliest & cheapest nearby** / **Nearest**
- Only complete daily per-kWh schedules are ranked
- Stored / previous records stay rankable for about **30 days**
- Confirm session price in Tesla before charging

## Privacy

GPS is used only to filter nearby stations. Neon stores station IDs and published schedules, not user coordinates or accounts. Cron/ingest require a timing-safe bearer secret.

## Local development

```sh
npm ci
npm test
npm run build
npm run migrate
npm run dev
```

Copy `.env.example` → `.env.local` after `vercel env pull`.

Independent project; not affiliated with Tesla.
