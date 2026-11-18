-- Neon schema for Supercharger Saver price DB (free tier).
-- Failed scrapes must never wipe good prices; only successful parses rotate current → previous.

CREATE TABLE IF NOT EXISTS station_prices (
  station_id TEXT PRIMARY KEY,
  name TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address TEXT,
  country TEXT,
  power DOUBLE PRECISION,
  stalls INTEGER,
  prices JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ,
  previous_prices JSONB,
  previous_fetched_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS station_prices_fetched_at_idx ON station_prices (fetched_at DESC);
CREATE INDEX IF NOT EXISTS station_prices_priced_idx ON station_prices ((prices <> '{}'::jsonb));

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sync_state (key, value)
VALUES ('scraper_cursor', '{"offset":0,"batchSize":60}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Stations users searched that still need prices — filled by residential browser scouts.
CREATE TABLE IF NOT EXISTS scout_wanted (
  station_id TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 1,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS scout_wanted_priority_idx ON scout_wanted (hits DESC, updated_at DESC);
