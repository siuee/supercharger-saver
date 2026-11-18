/**
 * Free automatic price fillers when Tesla detail is blocked from cloud IPs.
 * Sources: NREL AFDC (DEMO_KEY), ChargeAlong (keyless), optional Open Charge Map.
 * Never invents rates — only parses published $/kWh strings or flat cost fields.
 */
import {validateSchedule} from '../public/logic.js';

const AFDC_HOSTS=[
 'https://developer.nlr.gov/api/alt-fuel-stations/v1.json',
 'https://developer.nrel.gov/api/alt-fuel-stations/v1.json'
];
const CHARGEALONG_NEARBY='https://api.chargealong.io/v1/nearby';
const CHARGEALONG_SITE='https://api.chargealong.io/v1/sites/';
const OCM_POI='https://api.openchargemap.io/v3/poi/';

const US_STATES=[
 'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
 'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
 'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
];

/** Rough continental IANA zones for synthetic all-day books. */
const STATE_ZONE={
 AK:'America/Anchorage',HI:'Pacific/Honolulu',
 CA:'America/Los_Angeles',OR:'America/Los_Angeles',WA:'America/Los_Angeles',NV:'America/Los_Angeles',
 AZ:'America/Phoenix',
 MT:'America/Denver',WY:'America/Denver',CO:'America/Denver',NM:'America/Denver',UT:'America/Denver',ID:'America/Denver',
 ND:'America/Chicago',SD:'America/Chicago',NE:'America/Chicago',KS:'America/Chicago',OK:'America/Chicago',TX:'America/Chicago',
 MN:'America/Chicago',IA:'America/Chicago',MO:'America/Chicago',AR:'America/Chicago',LA:'America/Chicago',
 WI:'America/Chicago',IL:'America/Chicago',TN:'America/Chicago',MS:'America/Chicago',AL:'America/Chicago',
 MI:'America/Detroit',IN:'America/Indiana/Indianapolis',KY:'America/New_York',
 OH:'America/New_York',PA:'America/New_York',NY:'America/New_York',VT:'America/New_York',NH:'America/New_York',
 ME:'America/New_York',MA:'America/New_York',RI:'America/New_York',CT:'America/New_York',NJ:'America/New_York',
 DE:'America/New_York',MD:'America/New_York',DC:'America/New_York',VA:'America/New_York',WV:'America/New_York',
 NC:'America/New_York',SC:'America/New_York',GA:'America/New_York',FL:'America/New_York'
};

const MATCH_METERS_DEFAULT=250;
const STALE_MS=14*86400000;
const AGGREGATOR_VIAS=new Set(['afdc','chargealong','ocm']);

export function nrelApiKey(){
 return (process.env.NREL_API_KEY||'DEMO_KEY').trim()||'DEMO_KEY';
}

export function metersBetween(a,b){
 const r=Math.PI/180;
 const dlat=(b.lat-a.lat)*r,dlng=(b.lng-a.lng)*r;
 const x=Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlng/2)**2;
 return 6371000*2*Math.asin(Math.min(1,Math.sqrt(x)));
}

/** Extract a single USD/kWh rate from free-text pricing (AFDC / OCM). */
export function parseUsdPerKwh(text){
 if(text==null)return null;
 const s=String(text).replace(/,/g,'');
 if(!s.trim()||/free|no fee|gratis/i.test(s)&&!/\$\s*\d/.test(s)){
  if(/^(free|no fee)\b/i.test(s.trim()))return 0;
 }
 const patterns=[
  /\$\s*(\d+(?:\.\d+)?)\s*(?:\/|\s+per\s+)\s*kwh/i,
  /(\d+(?:\.\d+)?)\s*(?:usd|us\$)\s*(?:\/|\s+per\s+)\s*kwh/i,
  /(\d+(?:\.\d+)?)\s*(?:\/|\s+per\s+)\s*kwh/i
 ];
 for(const re of patterns){
  const m=s.match(re);
  if(!m)continue;
  const rate=Number(m[1]);
  if(Number.isFinite(rate)&&rate>=0&&rate<=10)return rate;
 }
 return null;
}

export function parseChargeAlongCost(cost){
 if(!cost||typeof cost!=='object')return null;
 const min=Number(cost.per_kwh_min);
 const max=Number(cost.per_kwh_max);
 if(Number.isFinite(min)&&min>=0&&min<=10){
  if(!Number.isFinite(max)||max===min)return min;
  // Flat approximate when a narrow published band exists.
  if(Number.isFinite(max)&&max>=0&&max<=10)return min;
 }
 if(cost.text)return parseUsdPerKwh(cost.text);
 return null;
}

export function zoneForState(state,fallback='America/Chicago'){
 const z=STATE_ZONE[String(state||'').toUpperCase()];
 if(z){
  try{new Intl.DateTimeFormat('en-US',{timeZone:z});return z;}catch{/* fall through */}
 }
 return fallback;
}

/**
 * Build member+public all-day synthetic books the ranking UI already understands.
 */
export function syntheticSchedulePrices({rate,currency='USD',zone='America/Chicago',via,source,sourceUrl,updated=new Date().toISOString()}){
 if(!Number.isFinite(rate)||rate<0||rate>10)return{};
 if(!via||!AGGREGATOR_VIAS.has(via))throw Error('via required');
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone});}catch{zone='America/Chicago';}
 const schedule=[{from:'00:00',to:'24:00',rate}];
 validateSchedule(schedule);
 const book={
  schedule,
  zone,
  currency:currency||'USD',
  source:source||('Approximate flat rate · '+via),
  updated,
  sourceUrl:sourceUrl||null,
  manual:false,
  approximate:true,
  via
 };
 return{member:{...book},public:{...book}};
}

export function nameHintScore(catalogName,candidateName){
 const tokens=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/).filter(t=>t.length>2&&!/^(tesla|supercharger|the|and)$/.test(t));
 const a=new Set(tokens(catalogName)),b=tokens(candidateName);
 if(!a.size||!b.length)return 0;
 let hit=0;
 for(const t of b)if(a.has(t))hit++;
 return hit;
}

/** Match aggregator lat/lng (+ optional name hint) to a Supercharge.info catalog station. */
export function matchCatalogStation(candidate,catalog,{maxMeters=MATCH_METERS_DEFAULT}={}){
 if(!candidate||!Number.isFinite(candidate.lat)||!Number.isFinite(candidate.lng)||!Array.isArray(catalog))return null;
 let best=null;
 for(const station of catalog){
  if(!Number.isFinite(station.lat)||!Number.isFinite(station.lng))continue;
  const meters=metersBetween(candidate,station);
  if(meters>maxMeters)continue;
  const hint=nameHintScore(station.name,candidate.name);
  const score=meters-(hint*15);
  if(!best||score<best.score)best={station,meters,hint,score};
 }
 return best;
}

export function bookIsTeslaLive(book){
 if(!book||typeof book!=='object')return false;
 if(book.approximate||AGGREGATOR_VIAS.has(book.via))return false;
 const via=String(book.via||'');
 if(via==='actions-scraper'||via==='brightdata'||via==='browser-scout')return true;
 return /tesla/i.test(String(book.source||''));
}

export function pricesNeedAggregatorFill(row,{staleMs=STALE_MS,now=Date.now()}={}){
 if(!row)return true;
 const raw=row.rawCurrent&&typeof row.rawCurrent==='object'?row.rawCurrent:null;
 const current=raw&&Object.keys(raw).length?raw
  :(row.hasCurrent===false?{}:(row.prices&&typeof row.prices==='object'?row.prices:{}));
 const keys=Object.keys(current||{});
 if(!keys.length)return true; // empty current (even if previous exists) → fill
 const fetched=row.fetchedAt||row.fetched_at;
 const age=fetched?now-Date.parse(fetched):Infinity;
 // Fresh Tesla TOU or fresh aggregator approx → leave alone; refresh when stale/missing date.
 return!(Number.isFinite(age)&&age<staleMs);
}

async function fetchJson(url,{headers={},timeout=45000}={}){
 const r=await fetch(url,{
  headers:{Accept:'application/json','User-Agent':'SuperchargerSaver-aggregators/1.0',...headers},
  signal:AbortSignal.timeout(timeout)
 });
 if(!r.ok)throw Error('HTTP '+r.status+' '+String(url).slice(0,80));
 return r.json();
}

export async function fetchAfdcTeslaStations({state,limit='all',apiKey=nrelApiKey()}={}){
 const params=new URLSearchParams({
  api_key:apiKey,
  fuel_type:'ELEC',
  ev_network:'Tesla',
  status:'E'
 });
 if(state)params.set('state',String(state).toUpperCase());
 if(limit!=null)params.set('limit',String(limit));
 let last;
 for(const host of AFDC_HOSTS){
  try{
   const data=await fetchJson(host+'?'+params,{timeout:90000});
   const rows=Array.isArray(data?.fuel_stations)?data.fuel_stations:[];
   return rows.map(s=>({
    name:s.station_name,
    lat:s.latitude,
    lng:s.longitude,
    state:s.state,
    address:[s.street_address,s.city,s.state,s.zip].filter(Boolean).join(', '),
    ev_pricing:s.ev_pricing,
    rate:parseUsdPerKwh(s.ev_pricing),
    sourceUrl:s.ev_network_web||'https://afdc.energy.gov/stations/',
    via:'afdc'
   })).filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lng));
  }catch(e){last=e;}
 }
 throw last||Error('AFDC unavailable');
}

export async function fetchChargeAlongNearby(lat,lng,{limit=30,radiusKm=5}={}){
 const url=new URL(CHARGEALONG_NEARBY);
 url.searchParams.set('lat',String(Number(lat).toFixed(4)));
 url.searchParams.set('lng',String(Number(lng).toFixed(4)));
 url.searchParams.set('network','tesla');
 url.searchParams.set('limit',String(Math.min(Math.max(limit,1),30)));
 url.searchParams.set('radius_km',String(radiusKm));
 const data=await fetchJson(url);
 const sites=data?.data?.sites||data?.sites||[];
 return sites.map(s=>({
  public_id:s.public_id,
  name:s.name,
  lat:s.lat,
  lng:s.lng,
  cost_kind:s.cost_kind,
  address:s.address,
  via:'chargealong'
 })).filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lng));
}

export async function fetchChargeAlongSite(publicId){
 const data=await fetchJson(CHARGEALONG_SITE+encodeURIComponent(publicId));
 const site=data?.data?.site||data?.site;
 const locality=data?.data?.locality;
 if(!site)throw Error('ChargeAlong site missing');
 const rate=parseChargeAlongCost(site.cost);
 return{
  public_id:site.public_id,
  name:site.name,
  lat:site.lat,
  lng:site.lng,
  address:site.address,
  rate,
  currency:site.cost?.currency||'USD',
  zone:locality?.time_zone||null,
  text:site.cost?.text||null,
  sourceUrl:site.path?('https://chargealong.io'+site.path):'https://chargealong.io/',
  via:'chargealong'
 };
}

export async function fetchOcmNearby(lat,lng,{maxresults=10,distanceKm=0.3}={}){
 const key=(process.env.OCM_API_KEY||'').trim();
 if(!key)return[];
 const url=new URL(OCM_POI);
 url.searchParams.set('key',key);
 url.searchParams.set('latitude',String(lat));
 url.searchParams.set('longitude',String(lng));
 url.searchParams.set('distance',String(distanceKm));
 url.searchParams.set('distanceunit','KM');
 url.searchParams.set('maxresults',String(maxresults));
 url.searchParams.set('compact','true');
 url.searchParams.set('verbose','false');
 const rows=await fetchJson(url,{headers:{'X-API-Key':key}});
 if(!Array.isArray(rows))return[];
 return rows.map(s=>{
  const usage=s.UsageCost||s.AddressInfo?.UsageCost||'';
  const ai=s.AddressInfo||{};
  return{
   name:s.AddressInfo?.Title||s.OperatorInfo?.Title,
   lat:ai.Latitude,
   lng:ai.Longitude,
   rate:parseUsdPerKwh(usage),
   usage,
   sourceUrl:ai.RelatedURL||'https://openchargemap.org/',
   via:'ocm'
  };
 }).filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lng)&&s.rate!=null);
}

/**
 * Try ChargeAlong → AFDC state sample → OCM for one catalog station.
 * Returns synthetic prices object or null.
 */
export async function resolveAggregatorPrices(station,{afdcCache=null}={}){
 const updated=new Date().toISOString();

 // 1) ChargeAlong nearby + site detail when a flat $/kWh is published
 try{
  const nearby=await fetchChargeAlongNearby(station.lat,station.lng,{limit:15,radiusKm:3});
  let best=null,bestM=Infinity;
  for(const s of nearby){
   const m=metersBetween(station,s);
   if(m<bestM){bestM=m;best=s;}
  }
  if(best&&bestM<=MATCH_METERS_DEFAULT&&best.public_id){
   const detail=await fetchChargeAlongSite(best.public_id);
   if(detail.rate!=null){
    return syntheticSchedulePrices({
     rate:detail.rate,
     currency:detail.currency||'USD',
     zone:detail.zone||zoneForState(guessState(station)),
     via:'chargealong',
     source:'ChargeAlong approximate · '+(detail.text||('flat $'+detail.rate+'/kWh')),
     sourceUrl:detail.sourceUrl,
     updated
    });
   }
  }
 }catch{/* optional */}

 // 2) AFDC — use preloaded state list or fetch one state
 try{
  const state=guessState(station);
  let rows=afdcCache?.get?.(state);
  if(!rows){
   rows=await fetchAfdcTeslaStations({state,limit:200});
   afdcCache?.set?.(state,rows);
  }
  const priced=rows.filter(r=>r.rate!=null);
  const hit=matchCatalogStation({lat:station.lat,lng:station.lng,name:station.name},priced,{maxMeters:MATCH_METERS_DEFAULT});
  if(hit&&hit.station.rate!=null){
   const r=hit.station;
   return syntheticSchedulePrices({
    rate:r.rate,
    zone:zoneForState(r.state||state),
    via:'afdc',
    source:'AFDC approximate · '+String(r.ev_pricing||('$'+r.rate+'/kWh')),
    sourceUrl:r.sourceUrl,
    updated
   });
  }
 }catch{/* optional */}

 // 3) Open Charge Map when keyed
 try{
  const ocm=await fetchOcmNearby(station.lat,station.lng);
  const hit=matchCatalogStation({lat:station.lat,lng:station.lng,name:station.name},ocm,{maxMeters:MATCH_METERS_DEFAULT});
  if(hit&&hit.station.rate!=null){
   const r=hit.station;
   return syntheticSchedulePrices({
    rate:r.rate,
    zone:zoneForState(guessState(station)),
    via:'ocm',
    source:'Open Charge Map approximate · '+String(r.usage||('$'+r.rate+'/kWh')),
    sourceUrl:r.sourceUrl,
    updated
   });
  }
 }catch{/* optional */}

 return null;
}

function guessState(station){
 const addr=String(station.address||'');
 const m=addr.match(/\b([A-Z]{2})\b(?:\s+\d{5})?/);
 if(m&&STATE_ZONE[m[1]])return m[1];
 return null;
}

/**
 * Pull every open US Tesla AFDC station with pricing in one shot when possible,
 * falling back to a full 51-jurisdiction state walk.
 */
export async function fetchAfdcTeslaStationsNationwide({apiKey=nrelApiKey()}={}){
 try{
  const rows=await fetchAfdcTeslaStations({limit:'all',apiKey});
  if(rows.length)return{rows,mode:'nationwide',states:['ALL']};
 }catch{/* fall through to per-state */}
 const rows=[];
 const states=[];
 const errors=[];
 for(const state of US_STATES){
  try{
   const part=await fetchAfdcTeslaStations({state,limit:'all',apiKey});
   rows.push(...part);
   states.push(state);
  }catch(e){
   errors.push(state+': '+(e.message||e));
  }
 }
 return{rows,mode:'by-state',states,error:errors.length?errors.join('; '):undefined};
}

async function upsertAfdcPricedRows(pricedRows,catalog,{
 maxUpserts=Infinity,
 cache,
 getExisting=null,
 upsert,
 report
}={}){
 let filled=0;
 for(const row of pricedRows){
  if(filled>=maxUpserts)break;
  const hit=matchCatalogStation(row,catalog,{maxMeters:MATCH_METERS_DEFAULT});
  if(!hit)continue;
  report.matched++;
  const station=hit.station;
  let existing=cache.get(station.id);
  if(existing===undefined&&typeof getExisting==='function'){
   existing=await getExisting(station.id);
   cache.set(station.id,existing||null);
  }
  if(!pricesNeedAggregatorFill(existing||null)){report.skipped++;continue;}
  const updated=new Date().toISOString();
  const prices=syntheticSchedulePrices({
   rate:row.rate,
   zone:zoneForState(row.state),
   via:'afdc',
   source:'AFDC approximate · '+String(row.ev_pricing||('$'+row.rate+'/kWh')),
   sourceUrl:row.sourceUrl,
   updated
  });
  await upsert(station,prices,updated,row);
  filled++;
  report.filled++;
  cache.set(station.id,{prices,fetchedAt:updated,rawCurrent:prices});
 }
 return filled;
}

/**
 * Progressive nationwide AFDC fill for empty catalog stations (free-tier safe).
 * Advances a state cursor in the returned nextState so callers can persist it.
 * Pass fullSweep/statesPerRun='all' to cover every US state/DC in one call.
 */
export async function bulkFillFromAfdc(catalog,{
 statesPerRun=3,
 maxUpserts=80,
 startStateIndex=0,
 fullSweep=false,
 existingById=null,
 getExisting=null,
 upsert
}={}){
 if(typeof upsert!=='function')throw Error('upsert required');
 const cache=existingById instanceof Map?existingById:new Map();
 const allStates=fullSweep||statesPerRun==='all'||Number(statesPerRun)>=US_STATES.length;
 const upsertCap=allStates
  ?(Number.isFinite(Number(maxUpserts))?Math.max(Number(maxUpserts),catalog?.length||0):Infinity)
  :Math.max(1,Number(maxUpserts)||80);
 const report={scanned:0,matched:0,filled:0,skipped:0,states:[],nextStateIndex:startStateIndex,mode:allStates?'full':'progressive'};

 if(allStates){
  const nationwide=await fetchAfdcTeslaStationsNationwide();
  report.states=nationwide.states||['ALL'];
  report.fetchMode=nationwide.mode;
  if(nationwide.error)report.error=nationwide.error;
  const priced=nationwide.rows.filter(r=>r.rate!=null);
  report.scanned=priced.length;
  report.afdcRows=nationwide.rows.length;
  report.afdcPricedRows=priced.length;
  await upsertAfdcPricedRows(priced,catalog,{maxUpserts:upsertCap,cache,getExisting,upsert,report});
  report.nextStateIndex=0;
  return report;
 }

 let filled=0;
 let idx=((Number(startStateIndex)||0)%US_STATES.length+US_STATES.length)%US_STATES.length;
 const runStates=Math.max(1,Math.min(Number(statesPerRun)||3,US_STATES.length));

 for(let n=0;n<runStates&&filled<upsertCap;n++){
  const state=US_STATES[idx];
  report.states.push(state);
  let rows=[];
  try{rows=await fetchAfdcTeslaStations({state,limit:'all'});}
  catch(e){
   report.error=(report.error||'')+state+': '+(e.message||e)+'; ';
   idx=(idx+1)%US_STATES.length;
   continue;
  }
  const priced=rows.filter(r=>r.rate!=null);
  report.scanned+=priced.length;
  filled+=await upsertAfdcPricedRows(priced,catalog,{
   maxUpserts:upsertCap-filled,cache,getExisting,upsert,report
  });
  idx=(idx+1)%US_STATES.length;
 }
 report.nextStateIndex=idx;
 return report;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/**
 * Walk every empty catalog station through ChargeAlong (+ optional OCM).
 * AFDC should already have run; this drains remaining gaps with free-tier pacing.
 */
export async function drainEmptyStationsWithAggregators(stations,{
 existingById=null,
 getExisting=null,
 upsert,
 concurrency=4,
 delayMs=350,
 onProgress=null
}={}){
 if(typeof upsert!=='function')throw Error('upsert required');
 const cache=existingById instanceof Map?existingById:new Map();
 const report={attempted:0,filled:0,skipped:0,noRate:0,errors:0,byVia:{}};
 const queue=[...stations];
 let cursor=0;

 async function one(station){
  report.attempted++;
  let existing=cache.get(station.id);
  if(existing===undefined&&typeof getExisting==='function'){
   existing=await getExisting(station.id);
   cache.set(station.id,existing||null);
  }
  if(!pricesNeedAggregatorFill(existing||null)){report.skipped++;return;}
  try{
   const fill=await fillStationFromAggregators(station,{
    existing:existing||null,
    afdcCache:null,
    upsert:async(s,prices,updated)=>{
     await upsert(s,prices,updated);
     cache.set(s.id,{prices,fetchedAt:updated,rawCurrent:prices});
    }
   });
   if(fill.filled){
    report.filled++;
    const via=fill.via||'aggregator';
    report.byVia[via]=(report.byVia[via]||0)+1;
   }else report.noRate++;
  }catch{
   report.errors++;
  }
  if(typeof onProgress==='function'&&report.attempted%50===0)onProgress({...report});
  if(delayMs>0)await sleep(delayMs+Math.floor(Math.random()*200));
 }

 const workers=Array.from({length:Math.max(1,Math.min(concurrency,8))},async()=>{
  while(cursor<queue.length){
   const i=cursor++;
   await one(queue[i]);
  }
 });
 await Promise.all(workers);
 return report;
}

export async function fillStationFromAggregators(station,{existing=null,upsert,afdcCache=null}={}){
 if(typeof upsert!=='function')throw Error('upsert required');
 if(!pricesNeedAggregatorFill(existing))return{filled:false,reason:'fresh'};
 const prices=await resolveAggregatorPrices(station,{afdcCache});
 if(!prices||!Object.keys(prices).length)return{filled:false,reason:'no-aggregator-rate'};
 const updated=prices.member?.updated||new Date().toISOString();
 await upsert(station,prices,updated);
 return{filled:true,via:prices.member?.via||prices.public?.via,priced:true};
}

export{US_STATES,MATCH_METERS_DEFAULT,STALE_MS};
