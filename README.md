# Supercharger Saver

Responsive, public website for comparing nearby Tesla Superchargers. Deploy this folder to Vercel from GitHub. No Tesla login is requested.

## What changed

- Station discovery and charging prices now come directly from Tesla's public Find Us endpoints. Community catalogs, demo rates and manual prices were removed.
- GPS or a typed location finds nearby stations within 10, 25, 50 or 100 miles. Prices load progressively and results automatically re-sort.
- Search-time prices have a 15-minute cache; open pages refresh every 15 minutes. Prices older than one hour are not ranked.
- A daily Vercel job refreshes the official catalog and stations searched during the past 30 days. It runs even when nobody has the website open, after the setup below.
- A status line displays configuration and the last background job's successful, failed and pending checks.

## Deploy from GitHub to Vercel

1. Extract this ZIP. Upload the CONTENTS of `supercharger-saver` to your GitHub repository, including `api`, `lib`, `public`, `scripts`, `test`, `package.json`, `package-lock.json` and `vercel.json`. Include `.github` if you want CI. Do not upload ZIP, secrets or `.env.local`.
2. In Vercel, import that GitHub repository. Choose framework **Other**, build command `npm run build`, output `public`, Node.js **22.x**. Set Root Directory to the folder containing `package.json` if you uploaded a containing folder.
3. Enable Fluid Compute / allow a 300-second function duration. The cron worker stops starting new requests after 220 seconds, allowing in-flight requests and status writes to finish.
4. Create an Upstash Redis database (through Vercel Marketplace or Upstash). Copy its **REST URL** and full read/write **REST token** into Vercel Production Environment Variables:

   ```text
   UPSTASH_REDIS_REST_URL=https://YOUR-DATABASE.upstash.io
   UPSTASH_REDIS_REST_TOKEN=YOUR-PRIVATE-TOKEN
   CRON_SECRET=YOUR-RANDOM-SECRET
   ```

   Generate a secret locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep all values server-side. Do not prefix them `PUBLIC` or commit them.
5. Deploy/redeploy. `vercel.json` registers `/api/sync` daily at `17 6 * * *` (UTC). Vercel's Hobby scheduling can run within the scheduled hour; do not treat this as an exact local-time alarm. Cron jobs run on production deployments. Check Vercel's Cron Jobs dashboard to confirm it is enabled.
6. Open the site and search your area. This registers station IDs for subsequent daily refreshes. Use Vercel's cron dashboard to run the job once, then reload the page and confirm the daily status reports a completed check. Inspect function logs if it reports failures. `/api/status` exposes the safe public status.

Without Redis and CRON_SECRET, searches still check Tesla but daily updates are NOT active. The UI says setup is needed. This package alone does not deploy or activate a job in your Vercel account.

Upstash and Vercel usage limits apply. For a large public audience, monitor storage operations, upstream failures and function duration. The job reports unfinished checks rather than claiming all stations were refreshed. It covers recently searched stations, not every station worldwide. Partial jobs are not automatically retried by this app; request-time checks still work independently. If queues regularly exceed the time budget, move refreshes to a durable queued worker before scaling.

## Official data and limitations

Locations: `https://www.tesla.com/api/findus/get-locations?country=US&view=map` currently returns a global catalog; both `supercharger` and `nacs` location types are included. Planned and explicitly closed locations are excluded. Each station's name, address, power, installed stalls and pricing are retrieved from Tesla's `get-charger-details` endpoint using its official location slug.

These are first-party public website endpoints, not a contracted or guaranteed Tesla developer API. Tesla can change their format, coverage or availability. No login scraping or bot-control bypass is used. An official source does not guarantee a real-time quote or complete worldwide coverage. Failed discovery returns an error; it does not fall back to a community catalog. Failed pricing is shown as unknown, never invented.

Only complete daily per-kWh schedules are ranked. Weekly, demand-dependent, tiered, incomplete or unavailable schedules are excluded. Tesla vehicle and non-member schedules are separate; non-Tesla membership prices are not inferred. Times use the station's official time zone, including DST and midnight windows. A retrieved timestamp is our fetch time, not Tesla's own price-change timestamp.

- **Cheapest now:** lowest scheduled price now.
- **Lowest in 24h:** lowest published rate in the next 24 hours.
- **Earliest & cheapest nearby:** earliest start of EACH station's minimum rate, then cheaper price, then distance. A more expensive station at its minimum now can rank above a cheaper one later. Choose Lowest in 24h for absolute price priority.
- **Nearest:** straight-line distance, not travel time.

Different currencies are grouped rather than converted. Charging cost estimates exclude taxes, congestion fees, parking and travel. Live stall availability and driving-time arrival calculations are not provided. Confirm compatibility, access and session pricing in Tesla before charging.

Charger data is Tesla-only. Address lookup uses Photon/OpenStreetMap, maps use OpenStreetMap, and directions open Google Maps. Those are separate from the charging price source. Set `PHOTON_URL` to a compatible geocoder you operate for higher traffic.

## Privacy and security

GPS is requested on button press. Coordinates are used by the server to filter locations; the app does not save coordinates to Redis. It stores official catalog data, station IDs with last search time, published station details and aggregate job status. Hosted request logs can contain query parameters; configure your hosting log retention accordingly. Typed addresses are sent to the geocoder. No Tesla credentials are requested. The cron endpoint uses a timing-safe bearer-secret check, a Redis lock and a bounded runtime. Public requests cannot supply an arbitrary upstream URL.

## Local development and tests

Requires Node.js 22. No npm dependencies.

```sh
npm ci
npm test
npm run build
npm run dev
```

Visit http://localhost:3000. For daily-sync integration locally, copy `.env.example` to `.env.local`, fill values and run `node --env-file=.env.local scripts/dev.mjs`. Local development does not schedule jobs automatically. The authenticated `/api/sync` endpoint is available for manual testing.

Tests cover midnight/DST schedules, earliest-price ties, unsupported pricebooks, official catalog filtering, API validation, cache coalescing, cron authorization, successful durable writes and failed refresh reporting. GitHub Actions runs tests and build on push and pull request.

Official operational references:
- https://vercel.com/docs/cron-jobs/manage-cron-jobs
- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://upstash.com/docs/redis/features/restapi

Independent project; not affiliated with Tesla. This ZIP updates the GitHub/Vercel version, not any separately hosted preview.
