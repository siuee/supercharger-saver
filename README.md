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
| **GitHub Actions scraper** | Daily cloud harvest via [`.github/workflows/daily-price-scraper.yml`](.github/workflows/daily-price-scraper.yml) |
| **Website (Vercel)** | Reads Neon only — never calls Tesla for visitor requests |

**No localhost / Tampermonkey dependency** for normal users. After you push to GitHub and deploy on Vercel with `DATABASE_URL`, the site works for everyone on the internet; prices fill automatically from the cloud harvest.

Failed scrapes **never wipe** good prices. When today’s scrape misses a station, the API can serve `previous_prices` with `freshness: "previous"`, and the UI shows **Previous record · retrieved {date}**.

There are **no per-user tables**. A request with `lat`/`lng` filters the shared catalog and joins Neon prices. User searches never call Tesla live.

## Daily cloud price pipeline

1. Loads US open stations from Supercharge.info.
2. Rotates through the catalog using a Neon `sync_state` cursor.
3. Tries Tesla `get-charger-details` (TLS impersonation → native → optional Bright Data Web Unlocker).
4. When Tesla is blocked or returns no schedule, fills from **free aggregators**:
   - **NREL AFDC** (`DEMO_KEY` by default, override with `NREL_API_KEY`) — parses `ev_pricing` `$X.XX/kWh`
   - **ChargeAlong** (keyless) — flat `cost.per_kwh_*` when published
   - **Open Charge Map** (optional `OCM_API_KEY`) — parses `UsageCost`
5. Matches aggregator rows to catalog stations by lat/lng (≤250 m) and UPSERTs synthetic all-day member/public books stamped with `via: afdc|chargealong|ocm` and `approximate: true`.
6. Runs a progressive nationwide AFDC bulk fill each run (state cursor) so empty stations gain approximate rates over time.

Aggregator rates are **flat / approximate**. Live Tesla time-of-use needs Bright Data Web Unlocker (`BRIGHTDATA_API_TOKEN`).

**Option A (recommended free-tier):** one **monthly** full US Tesla harvest via Actions `full_sweep=true` (Bright Data → Neon). Daily cron stays **aggregator-only** and does **not** call Bright Data, so the 5,000 free Web Unlocker credits last.

Manual monthly Tesla harvest: Actions → **Daily price scraper** → **Run workflow** → enable **full_sweep** (optional **refresh_all_tesla** to re-fetch every station). Daily schedule runs automatically for AFDC/ChargeAlong fill only.

```sh
npm run migrate
npm run scrape
```

### Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** (Vercel + Actions) | Neon connection — enough for approximate cloud prices |
| `NREL_API_KEY` | Optional | AFDC key (defaults to free `DEMO_KEY`) |
| `OCM_API_KEY` | Optional | Open Charge Map |
| `BRIGHTDATA_API_TOKEN` | For live Tesla TOU | Web Unlocker API token (GitHub Actions secret) |
| `BRIGHTDATA_ZONE` | Optional | Defaults to `web_unlocker1` |
| `SCRAPER_FULL_SWEEP` | Optional | `1` = monthly Tesla+AFDC full catalog (workflow `full_sweep`) |
| `SCRAPER_BRIGHTDATA_REFRESH_ALL` | Optional | With full sweep: re-fetch ALL stations, not only missing Tesla TOU |
| `SCRAPER_BATCH_SIZE` | Optional | Daily aggregator batch size (1–80) |
| `CRON_SECRET` | Optional | Protects `/api/sync` and `/api/ingest` (≥24 chars) |

## Deploy on Vercel

1. Import the repo. Framework **Other**, build `npm run build`, output `public`, Node **22.x**.
2. Install **Neon** via Vercel Marketplace (free). Env vars including `DATABASE_URL` are injected automatically.
3. Set `CRON_SECRET` (≥24 characters) if you use `/api/sync` or `/api/ingest`.
4. Add the same `DATABASE_URL` to GitHub Actions secrets for the scraper workflow.
5. Deploy. Open the site and search; rates fill as cloud harvest batches succeed (Tesla when reachable, aggregators otherwise).

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
