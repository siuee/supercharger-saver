#!/usr/bin/env node
/**
 * Free daily price scraper (GitHub Actions) + multi-strategy fetch.
 *
 * Datacenter IPs are usually blocked by Tesla. Strategies (in order):
 * 1) Chrome TLS impersonation via Python curl_cffi
 * 2) Native fetch (rarely works from Actions)
 * 3) Soft-complete: advance cursor, keep prior Neon rows, exit 0
 *
 * Real nationwide coverage comes from residential browser scouts
 * (public/scout.user.js) posting to /api/scout.
 */
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const rootUrl=pathToFileURL(root+'/').href;
const here=dirname(fileURLToPath(import.meta.url));

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
 const us=rows.filter(s=>{
  const c=String(s?.address?.country||'').toUpperCase();
  return !c||c==='USA'||c==='US'||c==='UNITED STATES';
 });
 return normalizeFallbackCatalog(us);
}

function fetchViaImpersonate(stationId){
 const script=join(here,'fetch_impersonate.py');
 let py=spawnSync('python3',[script,stationId],{encoding:'utf8',timeout:60000});
 if(py.error||py.status===9009||py.status===127){
  py=spawnSync('python',[script,stationId],{encoding:'utf8',timeout:60000});
 }
 const out=(py.stdout||'').trim()||(py.stderr||'').trim();
 if(!out)throw Error('impersonate empty ('+(py.error?.message||('exit '+py.status))+')');
 let parsed;
 try{parsed=JSON.parse(out.split(/\r?\n/).filter(Boolean).at(-1));}
 catch{throw Error('impersonate bad json');}
 if(!parsed.ok)throw Error(parsed.error||'impersonate failed');
 return parsed.detail;
}

async function fetchViaNative(station){
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
   Origin:'https://www.tesla.com'
  },
  signal:AbortSignal.timeout(45000)
 });
 const text=await r.text();
 if(!r.ok)throw Error('Tesla upstream blocked ('+r.status+')');
 if(/Access Denied|cpr_chlge/i.test(text)||text.trimStart().startsWith('<HTML>'))throw Error('Tesla bot protection blocked this request');
 const json=JSON.parse(text);
 const detail=json?.data?.data;
 if(!detail?.name||!detail.timeZone)throw Error('Official details unavailable');
 return detail;
}

async function fetchDetail(station){
 const errors=[];
 try{return fetchViaImpersonate(station.id);}
 catch(e){errors.push('impersonate: '+(e.message||e));}
 try{return await fetchViaNative(station);}
 catch(e){errors.push('native: '+(e.message||e));}
 throw Error(errors.join(' | '));
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
 for(const book of Object.values(prices||{})){
  book.via='actions-scraper';
  book.updated=updated;
 }
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
  mode:'github-actions-multistrategy',
  catalogSize:catalog.length,
  batchSize:queue.length,
  offset,
  nextOffset,
  succeeded:0,
  priced:0,
  failed:0,
  blocked:false,
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
   const msg=String(e.message||e).slice(0,240);
   if(/403|bot protection|blocked|impersonate/i.test(msg))report.blocked=true;
   report.errors.push({id:station.id,error:msg});
   await recordStationError(station.id,msg).catch(()=>{});
   console.warn('fail',station.id,msg);
  }
  await sleep(jitter(800,1800));
 }

 await setSyncState('scraper_cursor',{offset:nextOffset,batchSize:limit,updatedAt:new Date().toISOString()});
 report.finishedAt=new Date().toISOString();
 report.complete=report.failed===0;
 report.note=report.blocked
  ?'Tesla blocked datacenter fetches. Neon kept prior rows. Install public/scout.user.js (Tampermonkey) so residential browsers fill wanted stations.'
  :'Batch finished';
 await setLastScraperRun(report);
 console.log(JSON.stringify({
  succeeded:report.succeeded,
  priced:report.priced,
  failed:report.failed,
  blocked:report.blocked,
  nextOffset,
  note:report.note
 },null,2));
 // Soft-success: cursor advanced and DB updated even when Tesla blocks every request.
 process.exitCode=0;
}

main().catch(e=>{
 console.error(e);
 process.exit(1);
});
