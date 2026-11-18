import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {neon} from '@neondatabase/serverless';

const __dirname=dirname(fileURLToPath(import.meta.url));

export function dbConfigured(){
 return !!(process.env.DATABASE_URL||process.env.POSTGRES_URL);
}

function connectionString(){
 return process.env.DATABASE_URL||process.env.POSTGRES_URL||'';
}

/** Lazy Neon SQL client — avoids build-time crash when DATABASE_URL is unset. */
let _sql;
export function sql(){
 if(!_sql){
  const url=connectionString();
  if(!url)throw Error('DATABASE_URL is not configured');
  _sql=neon(url);
 }
 return _sql;
}

export async function ensureSchema(){
 const q=sql();
 const schema=readFileSync(join(__dirname,'schema.sql'),'utf8');
 const statements=schema
  .split(/;\s*(?:\r?\n|$)/)
  .map(s=>s.replace(/--[^\n]*/g,'').trim())
  .filter(Boolean);
 for(const statement of statements){
  await q.query(statement);
 }
}

function hasPrices(prices){
 return !!(prices&&typeof prices==='object'&&Object.keys(prices).length>0);
}

function normalizeRow(row){
 if(!row)return null;
 const prices=row.prices&&typeof row.prices==='object'?row.prices:{};
 const previous=row.previous_prices&&typeof row.previous_prices==='object'?row.previous_prices:null;
 const currentOk=hasPrices(prices);
 const previousOk=hasPrices(previous);
 let effectivePrices=prices;
 let fetchedAt=row.fetched_at?new Date(row.fetched_at).toISOString():null;
 let freshness='today';
 if(!currentOk&&previousOk){
  effectivePrices=previous;
  fetchedAt=row.previous_fetched_at?new Date(row.previous_fetched_at).toISOString():null;
  freshness='previous';
 }else if(currentOk&&fetchedAt){
  const startOfToday=new Date();
  startOfToday.setHours(0,0,0,0);
  freshness=Date.parse(fetchedAt)>=startOfToday.getTime()?'today':'previous';
 }else if(!currentOk){
  freshness='missing';
 }
 return{
  stationId:row.station_id,
  name:row.name,
  lat:row.lat,
  lng:row.lng,
  address:row.address,
  country:row.country,
  power:row.power,
  stalls:row.stalls,
  prices:effectivePrices,
  fetchedAt,
  freshness:currentOk||previousOk?freshness:'missing',
  previousPrices:previous,
  previousFetchedAt:row.previous_fetched_at?new Date(row.previous_fetched_at).toISOString():null,
  lastError:row.last_error||null,
  rawCurrent:prices,
  hasCurrent:currentOk,
  hasPrevious:previousOk
 };
}

export async function getStationPrices(ids){
 if(!dbConfigured()||!ids?.length)return new Map();
 const q=sql();
 const unique=[...new Set(ids.map(String))];
 const rows=await q`
  SELECT station_id,name,lat,lng,address,country,power,stalls,prices,fetched_at,
         previous_prices,previous_fetched_at,last_error
  FROM station_prices
  WHERE station_id = ANY(${unique})
 `;
 const map=new Map();
 for(const row of rows)map.set(row.station_id,normalizeRow(row));
 return map;
}

export async function getStationPrice(id){
 const map=await getStationPrices([id]);
 return map.get(String(id))||null;
}

/**
 * Successful scrape UPSERT: rotate current → previous only when the new payload has prices
 * and differs from (or replaces empty) current. Never wipe on empty success without prices.
 */
export async function upsertStationSuccess(station,{prices,fetchedAt=new Date().toISOString(),meta={}}={}){
 if(!dbConfigured())throw Error('DATABASE_URL is not configured');
 const q=sql();
 const id=String(station.id||station.station_id||'');
 if(!id)throw Error('station id required');
 const nextPrices=prices&&typeof prices==='object'?prices:{};
 const priced=hasPrices(nextPrices);
 const existing=await q`SELECT prices,fetched_at FROM station_prices WHERE station_id=${id}`;
 const prev=existing[0];
 let previousPrices=null;
 let previousFetchedAt=null;
 if(priced&&prev&&hasPrices(prev.prices)){
  previousPrices=prev.prices;
  previousFetchedAt=prev.fetched_at;
 }
 const pricesJson=JSON.stringify(nextPrices);
 const previousJson=previousPrices?JSON.stringify(previousPrices):null;
 await q`
  INSERT INTO station_prices (
    station_id,name,lat,lng,address,country,power,stalls,
    prices,fetched_at,previous_prices,previous_fetched_at,last_error,updated_at
  ) VALUES (
    ${id},
    ${meta.name??station.name??null},
    ${meta.lat??station.lat??null},
    ${meta.lng??station.lng??null},
    ${meta.address??station.address??null},
    ${meta.country??station.country??null},
    ${meta.power??station.power??null},
    ${meta.stalls??station.stalls??null},
    ${pricesJson}::jsonb,
    ${priced?fetchedAt:null},
    ${previousJson}::jsonb,
    ${previousFetchedAt},
    NULL,
    NOW()
  )
  ON CONFLICT (station_id) DO UPDATE SET
    name=COALESCE(EXCLUDED.name,station_prices.name),
    lat=COALESCE(EXCLUDED.lat,station_prices.lat),
    lng=COALESCE(EXCLUDED.lng,station_prices.lng),
    address=COALESCE(EXCLUDED.address,station_prices.address),
    country=COALESCE(EXCLUDED.country,station_prices.country),
    power=COALESCE(EXCLUDED.power,station_prices.power),
    stalls=COALESCE(EXCLUDED.stalls,station_prices.stalls),
    prices=CASE
      WHEN ${priced} THEN EXCLUDED.prices
      ELSE station_prices.prices
    END,
    fetched_at=CASE
      WHEN ${priced} THEN EXCLUDED.fetched_at
      ELSE station_prices.fetched_at
    END,
    previous_prices=CASE
      WHEN ${priced} AND station_prices.prices IS NOT NULL AND station_prices.prices <> '{}'::jsonb
        THEN station_prices.prices
      ELSE station_prices.previous_prices
    END,
    previous_fetched_at=CASE
      WHEN ${priced} AND station_prices.prices IS NOT NULL AND station_prices.prices <> '{}'::jsonb
        THEN station_prices.fetched_at
      ELSE station_prices.previous_fetched_at
    END,
    last_error=NULL,
    updated_at=NOW()
 `;
 return{id,priced};
}

/** Record scrape failure without clearing stored prices. */
export async function recordStationError(stationId,error){
 if(!dbConfigured())return;
 const q=sql();
 const id=String(stationId);
 const msg=String(error?.message||error||'unknown error').slice(0,500);
 await q`
  INSERT INTO station_prices (station_id,prices,last_error,updated_at)
  VALUES (${id},'{}'::jsonb,${msg},NOW())
  ON CONFLICT (station_id) DO UPDATE SET
    last_error=EXCLUDED.last_error,
    updated_at=NOW()
 `;
}

export async function getSyncState(key='scraper_cursor'){
 if(!dbConfigured())return null;
 const q=sql();
 const rows=await q`SELECT value FROM sync_state WHERE key=${key}`;
 return rows[0]?.value||null;
}

export async function setSyncState(key,value){
 if(!dbConfigured())throw Error('DATABASE_URL is not configured');
 const q=sql();
 const payload=JSON.stringify(value??{});
 await q`
  INSERT INTO sync_state (key,value,updated_at)
  VALUES (${key},${payload}::jsonb,NOW())
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()
 `;
}

export async function countPricedStations(){
 if(!dbConfigured())return 0;
 const q=sql();
 const rows=await q`SELECT COUNT(*)::int AS n FROM station_prices WHERE prices <> '{}'::jsonb OR previous_prices IS NOT NULL AND previous_prices <> '{}'::jsonb`;
 return rows[0]?.n||0;
}

export async function getLastScraperRun(){
 return getSyncState('last_scraper_run');
}

export async function setLastScraperRun(report){
 return setSyncState('last_scraper_run',report);
}

/** Convert Neon row / API shape into the Redis-compatible station body used by the UI. */
export function bodyFromDbRow(row,fallbackMeta={}){
 if(!row)return null;
 const prices=row.prices||{};
 const fetchedAt=row.fetchedAt||null;
 const reason=hasPrices(prices)
  ?''
  :'No stored price for this station yet. Rates fill automatically from the cloud harvest as daily batches cover the catalog.';
 // Stamp schedule.updated from fetchedAt so the UI age check works.
 const stamped={};
 for(const [type,book] of Object.entries(prices)){
  stamped[type]={...book,updated:book.updated||fetchedAt};
 }
 return{
  prices:stamped,
  updated:fetchedAt,
  freshness:row.freshness||'missing',
  station:{
   name:row.name||fallbackMeta.name,
   address:row.address||fallbackMeta.address,
   country:row.country||fallbackMeta.country,
   power:row.power??fallbackMeta.power,
   stalls:row.stalls??fallbackMeta.stalls
  },
  reason
 };
}
