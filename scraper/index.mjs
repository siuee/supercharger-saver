#!/usr/bin/env node
/**
 * Free daily price scraper (GitHub Actions).
 * 1) Load US open stations from Supercharge.info
 * 2) Rotate via Neon sync_state cursor
 * 3) Fetch Tesla get-charger-details directly (no Scrapfly)
 * 4) UPSERT successes into Neon; failures leave prior prices intact
 */
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const rootUrl=pathToFileURL(root+'/').href;

function loadEnvLocal(){
 try{
  const raw=readFileSync(join(root,'.env.local'),'utf8');
  for(const line of raw.split(/\r?\n/)){
   if(!line||line.startsWith('#')||!line.includes('='))continue;
   const i=line.indexOf('=');
   const key=line.slice(0,i).trim();
   let val=line.slice(i+1).trim();
   if((val.startsWith('"')&&val.endsWith('"'))||(val.startsWith("'")&&val.endsWith("'")))val=val.slice(1,-1);
   if(!(key in process.env))process.env[key]=val;
  }
 }catch{/* optional for CI secrets */}
}

loadEnvLocal();

const {
 ensureSchema,
 upsertStationSuccess,
 recordStationError,
 getSyncState,
 setSyncState,
 setLastScraperRun
}=await import(new URL('lib/db.js',rootUrl));
const {parseDetail}=await import(new URL('lib/tesla.js',rootUrl));
const {normalizeFallbackCatalog}=await import(new URL('lib/service.js',rootUrl));

const FALLBACK_CATALOG_URL='https://supercharge.info/service/supercharge/allSites';
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function batchSize(){
 const n=Number(process.env.SCRAPER_BATCH_SIZE);
 if(Number.isFinite(n)&&n>=1)return Math.min(Math.floor(n),80);
 // Free-safe default: 40–80 with slight randomness per run.
 return 40+Math.floor(Math.random()*41);
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function jitter(minMs,maxMs){return minMs+Math.floor(Math.random()*(maxMs-minMs+1));}

async function loadCatalog(){
 const r=await fetch(FALLBACK_CATALOG_URL,{
  headers:{Accept:'application/json','User-Agent':'SuperchargerSaver-scraper/1.0'},
  signal:AbortSignal.timeout(60000)
 });
 if(!r.ok)throw Error('Catalog HTTP '+r.status);
 const rows=await r.json();
 // Prefer US open sites for this product; keep unknown-country rows only if they look US.
 const us=rows.filter(s=>{
  const c=String(s?.address?.country||'').toUpperCase();
  return !c||c==='USA'||c==='US'||c==='UNITED STATES';
 });
 return normalizeFallbackCatalog(us);
}

async function fetchDetail(station){
 const url=new URL('https://www.tesla.com/api/findus/get-charger-details');
 url.search=new URLSearchParams({
  locationSlug:station.id,
  programType:'supercharger',
  locale:'en-US',
  isInHkMoTw:String(!!station.inHkMoTw)
 });
 const r=await fetch(url,{
  headers:{
   Accept:'application/json, text/plain, */*',
   'Accept-Language':'en-US,en;q=0.9',
   'User-Agent':BROWSER_UA,
   Referer:'https://www.tesla.com/findus',
   Origin:'https://www.tesla.com',
   'Sec-Fetch-Dest':'empty',
   'Sec-Fetch-Mode':'cors',
   'Sec-Fetch-Site':'same-origin'
  },
  signal:AbortSignal.timeout(45000)
 });
 const text=await r.text();
 if(!r.ok)throw Error('Tesla upstream blocked ('+r.status+')');
 if(/Access Denied|cpr_chlge|"t":\s*"\d+"/i.test(text)||text.trimStart().startsWith('<HTML>')){
  throw Error('Tesla bot protection blocked this request');
 }
 let json;
 try{json=JSON.parse(text);}catch{throw Error('Invalid Tesla JSON');}
 const detail=json?.data?.data;
 if(!detail?.name||!detail.timeZone)throw Error('Official details unavailable');
 return detail;
}

async function scrapeOne(station){
 const updated=new Date().toISOString();
 let detail;
 try{
  detail=await fetchDetail(station);
 }catch(first){
  await sleep(jitter(1500,3500));
  detail=await fetchDetail(station).catch(()=>{throw first;});
 }
 const prices=parseDetail(detail,station.id,updated);
 const a=detail.address||{};
 const meta={
  name:detail.name,
  lat:station.lat,
  lng:station.lng,
  address:[a.streetNumber,a.street,a.city,a.state,a.postalCode].filter(Boolean).join(' ')||station.address,
  country:a.country||station.country,
  power:detail.maxPowerKw??station.power,
  stalls:detail.publicStallCount??station.stalls
 };
 return upsertStationSuccess(station,{prices,fetchedAt:updated,meta});
}

async function main(){
 if(!process.env.DATABASE_URL&&!process.env.POSTGRES_URL){
  console.error('DATABASE_URL is required');
  process.exit(1);
 }
 await ensureSchema();
 const catalog=await loadCatalog();
 const limit=batchSize();
 const state=(await getSyncState('scraper_cursor'))||{offset:0};
 let offset=Number(state.offset)||0;
 if(offset<0||offset>=catalog.length)offset=0;

 const queue=[];
 for(let i=0;i<catalog.length&&queue.length<limit;i++){
  queue.push(catalog[(offset+i)%catalog.length]);
 }
 const nextOffset=catalog.length?(offset+queue.length)%catalog.length:0;

 const report={
  startedAt:new Date().toISOString(),
  mode:'github-actions',
  catalogSize:catalog.length,
  batchSize:queue.length,
  offset,
  nextOffset,
  succeeded:0,
  priced:0,
  failed:0,
  errors:[]
 };

 console.log(`Scraper starting: batch ${queue.length} / catalog ${catalog.length} @ offset ${offset}`);

 for(const station of queue){
  try{
   const result=await scrapeOne(station);
   report.succeeded++;
   if(result.priced)report.priced++;
   console.log('ok',station.id,result.priced?'priced':'empty');
  }catch(e){
   report.failed++;
   const msg=String(e.message||e).slice(0,200);
   report.errors.push({id:station.id,error:msg});
   await recordStationError(station.id,msg).catch(()=>{});
   console.warn('fail',station.id,msg);
  }
  await sleep(jitter(1200,2800));
 }

 await setSyncState('scraper_cursor',{offset:nextOffset,batchSize:limit,updatedAt:new Date().toISOString()});
 report.finishedAt=new Date().toISOString();
 report.complete=report.failed===0;
 await setLastScraperRun(report);
 console.log(JSON.stringify({succeeded:report.succeeded,priced:report.priced,failed:report.failed,nextOffset},null,2));
 // Soft-fail the job when fully blocked so Actions still records the run; exit 1 only if zero successes and some failures.
 if(report.succeeded===0&&report.failed>0)process.exitCode=1;
}

main().catch(e=>{
 console.error(e);
 process.exit(1);
});
