#!/usr/bin/env node
/**
 * Free daily price scraper (GitHub Actions) + multi-strategy fetch.
 *
 * Strategies (in order):
 * 1) Chrome TLS impersonation via Python curl_cffi
 * 2) Native fetch (rarely works from Actions)
 * 3) Optional Bright Data Web Unlocker (if BRIGHTDATA_API_TOKEN set)
 * 4) Free aggregator fill (AFDC / ChargeAlong / optional OCM) for failed/empty rows
 *
 * Full sweep (SCRAPER_FULL_SWEEP=1):
 *  - Nationwide AFDC match against the entire US catalog first
 *  - Then drain every remaining empty station via ChargeAlong/OCM
 *  - Tesla live details only when Bright Data is configured (Actions IPs get 403)
 *
 * Soft-completes with exit 0 so Actions stays green while Neon fills progressively.
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
 setLastScraperRun,
 getStationPrices,
 getStationPrice,
 countPricedStations,
 listPriorityEmptyStationIds
}=await import(new URL('lib/db.js',rootUrl));
const {parseDetail}=await import(new URL('lib/tesla.js',rootUrl));
const {normalizeFallbackCatalog}=await import(new URL('lib/service.js',rootUrl));
const {
 fillStationFromAggregators,
 bulkFillFromAfdc,
 drainEmptyStationsWithAggregators,
 pricesNeedAggregatorFill,
 bookIsTeslaLive,
 US_STATES
}=await import(new URL('scraper/aggregators.mjs',rootUrl));

const FALLBACK_CATALOG_URL='https://supercharge.info/service/supercharge/allSites';
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fullSweepEnabled(){
 const v=String(process.env.SCRAPER_FULL_SWEEP||'').trim().toLowerCase();
 return v==='1'||v==='true'||v==='yes';
}

function batchSize(){
 if(fullSweepEnabled()){
  const n=Number(process.env.SCRAPER_BATCH_SIZE);
  // Full sweep defaults to the entire catalog; allow an explicit override.
  if(Number.isFinite(n)&&n>=1)return Math.floor(n);
  return Number.POSITIVE_INFINITY;
 }
 const n=Number(process.env.SCRAPER_BATCH_SIZE);
 if(Number.isFinite(n)&&n>=1)return Math.min(Math.floor(n),80);
 return 40+Math.floor(Math.random()*41);
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function jitter(minMs,maxMs){return minMs+Math.floor(Math.random()*(maxMs-minMs+1));}
function brightDataConfigured(){return!!(process.env.BRIGHTDATA_API_TOKEN||'').trim();}

/** True when station lacks a live Tesla TOU book (AFDC/approx counts as still needing Tesla). */
function needsTeslaLive(row){
 if(!row)return true;
 const raw=row.rawCurrent&&typeof row.rawCurrent==='object'?row.rawCurrent:null;
 const current=raw&&Object.keys(raw).length?raw
  :(row.hasCurrent===false?{}:(row.prices&&typeof row.prices==='object'?row.prices:{}));
 const books=Object.values(current||{});
 if(!books.length)return true;
 return!books.some(bookIsTeslaLive);
}

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

function teslaDetailUrl(station){
 const url=new URL('https://www.tesla.com/api/findus/get-charger-details');
 url.search=new URLSearchParams({
  locationSlug:station.id,
  programType:'supercharger',
  locale:'en-US',
  isInHkMoTw:String(!!station.inHkMoTw)
 });
 return url;
}

async function fetchViaNative(station){
 const url=teslaDetailUrl(station);
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

async function fetchViaBrightData(station){
 const token=(process.env.BRIGHTDATA_API_TOKEN||'').trim();
 if(!token)throw Error('brightdata unset');
 const zone=(process.env.BRIGHTDATA_ZONE||'web_unlocker1').trim()||'web_unlocker1';
 const r=await fetch('https://api.brightdata.com/request',{
  method:'POST',
  headers:{
   Authorization:'Bearer '+token,
   'Content-Type':'application/json',
   Accept:'application/json'
  },
  body:JSON.stringify({zone,url:teslaDetailUrl(station).toString(),format:'raw'}),
  signal:AbortSignal.timeout(90000)
 });
 const text=await r.text();
 if(!r.ok)throw Error('brightdata HTTP '+r.status);
 if(/Access Denied|cpr_chlge/i.test(text)||text.trimStart().startsWith('<HTML>'))throw Error('brightdata still blocked');
 let json;
 try{json=JSON.parse(text);}
 catch{throw Error('brightdata bad json');}
 const envelope=json?.data?.data?json
  :(typeof json?.body==='string'?JSON.parse(json.body)
  :(typeof json?.content==='string'?JSON.parse(json.content):json));
 const detail=envelope?.data?.data||envelope?.data||envelope;
 if(!detail?.name||!detail.timeZone)throw Error('brightdata details unavailable');
 return detail;
}

async function fetchDetail(station,{preferBrightDataOnly=false}={}){
 const errors=[];
 if(!preferBrightDataOnly){
  try{return{detail:fetchViaImpersonate(station.id),via:'actions-scraper'};}
  catch(e){errors.push('impersonate: '+(e.message||e));}
  try{return{detail:await fetchViaNative(station),via:'actions-scraper'};}
  catch(e){errors.push('native: '+(e.message||e));}
 }
 if(brightDataConfigured()){
  try{return{detail:await fetchViaBrightData(station),via:'brightdata'};}
  catch(e){errors.push('brightdata: '+(e.message||e));}
 }
 throw Error(errors.join(' | ')||'Tesla fetch unavailable');
}

async function upsertPrices(station,prices,updated,metaExtra={}){
 return upsertStationSuccess(station,{
  prices,
  fetchedAt:updated,
  meta:{
   name:metaExtra.name||station.name,
   lat:station.lat,
   lng:station.lng,
   address:metaExtra.address||station.address,
   country:metaExtra.country||station.country,
   power:metaExtra.power??station.power,
   stalls:metaExtra.stalls??station.stalls
  }
 });
}

async function scrapeOneTesla(station,{preferBrightDataOnly=false}={}){
 const updated=new Date().toISOString();
 let fetched;
 try{
  fetched=await fetchDetail(station,{preferBrightDataOnly});
 }catch(first){
  if(preferBrightDataOnly)throw first;
  await sleep(jitter(1500,3500));
  fetched=await fetchDetail(station).catch(()=>{throw first;});
 }
 const {detail,via}=fetched;
 const prices=parseDetail(detail,station.id,updated);
 for(const book of Object.values(prices||{})){
  book.via=via;
  book.updated=updated;
 }
 const a=detail.address||{};
 return upsertStationSuccess(station,{
  prices,
  fetchedAt:updated,
  meta:{
   name:detail.name,
   lat:station.lat,
   lng:station.lng,
   address:[a.streetNumber,a.street,a.city,a.state,a.postalCode].filter(Boolean).join(' ')||station.address,
   country:a.country||station.country,
   power:detail.maxPowerKw??station.power,
   stalls:detail.publicStallCount??station.stalls
  }
 });
}

async function tryAggregatorFill(station,existing,afdcCache,report){
 try{
  const fill=await fillStationFromAggregators(station,{
   existing,
   afdcCache,
   upsert:async(s,prices,updated)=>upsertPrices(s,prices,updated)
  });
  if(fill.filled){
   report.aggregatorFilled++;
   report.priced++;
   console.log('agg',station.id,fill.via);
   return true;
  }
 }catch(ae){
  console.warn('agg-fail',station.id,String(ae.message||ae).slice(0,160));
 }
 return false;
}

async function loadExistingMap(ids){
 const map=new Map();
 const chunk=400;
 for(let i=0;i<ids.length;i+=chunk){
  const part=await getStationPrices(ids.slice(i,i+chunk)).catch(()=>new Map());
  for(const [k,v] of part)map.set(k,v);
 }
 return map;
}

/** Prefer scout_wanted + DFW empties ahead of random catalog drain. */
function prioritizeStations(stations,priorityIds){
 if(!Array.isArray(stations)||!stations.length)return[];
 const byId=new Map(stations.map(s=>[String(s.id),s]));
 const seen=new Set();
 const out=[];
 for(const id of priorityIds||[]){
  const s=byId.get(String(id));
  if(!s||seen.has(s.id))continue;
  seen.add(s.id);
  out.push(s);
 }
 for(const s of stations){
  if(seen.has(s.id))continue;
  seen.add(s.id);
  out.push(s);
 }
 return out;
}

async function loadPriorityIds(catalog){
 const fromDb=await listPriorityEmptyStationIds({limit:200,includeDbEmpties:true}).catch(()=>[]);
 // Soft DFW box boost when catalog coords are present (recent empties without scout_wanted rows).
 const dfw=[];
 for(const s of catalog||[]){
  if(!Number.isFinite(s.lat)||!Number.isFinite(s.lng))continue;
  if(s.lat>=32.3&&s.lat<=33.4&&s.lng>=-97.6&&s.lng<=-96.4)dfw.push(String(s.id));
 }
 return[...new Set([...(fromDb||[]).map(String),...dfw])];
}

/**
 * AFDC first-pass for priority empties: run their states (TX first) before catalog drain.
 */
async function fillWantedFirst(catalog,priorityIds,report){
 const byId=new Map(catalog.map(s=>[String(s.id),s]));
 const wantedStations=priorityIds.map(id=>byId.get(String(id))).filter(Boolean);
 if(!wantedStations.length)return{filled:0,states:[],scanned:0};
 const stateSet=new Set();
 for(const s of wantedStations){
  const addr=String(s.address||'');
  const m=addr.match(/\b([A-Z]{2})\b(?:\s+\d{5})?/);
  if(m&&US_STATES.includes(m[1]))stateSet.add(m[1]);
 }
 // Always try TX early when any DFW/priority empties look Texan or lat/lng is in TX box.
 if(wantedStations.some(s=>Number.isFinite(s.lat)&&s.lat>=25.8&&s.lat<=36.6&&s.lng>=-106.7&&s.lng<=-93.4)){
  stateSet.add('TX');
 }
 let states=['TX',...[...stateSet].filter(s=>s!=='TX')].filter(s=>US_STATES.includes(s));
 if(!states.length)states=['TX']; // TX is always a safe first AFDC pass for DFW wanted queues
 const startIdx=US_STATES.indexOf(states[0]||'TX');
 const bulk=await bulkFillFromAfdc(catalog,{
  statesPerRun:Math.min(Math.max(states.length,3),8),
  maxUpserts:Math.max(wantedStations.length*2,120),
  startStateIndex:startIdx>=0?startIdx:US_STATES.indexOf('TX'),
  getExisting:async id=>getStationPrice(id).catch(()=>null),
  upsert:async(station,prices,updated,row)=>{
   await upsertPrices(station,prices,updated,{name:row?.name,address:row?.address});
  }
 });
 report.phases=report.phases||{};
 report.phases.fillWantedFirst=bulk;
 report.aggregatorFilled+=(bulk.filled||0);
 report.priced+=(bulk.filled||0);
 console.log('fillWantedFirst',JSON.stringify({filled:bulk.filled,states:bulk.states,scanned:bulk.scanned}));
 return bulk;
}

async function runFullSweep(catalog){
 const pricedBefore=await countPricedStations().catch(()=>0);
 const report={
  startedAt:new Date().toISOString(),
  mode:'full-sweep',
  catalogSize:catalog.length,
  pricedBefore,
  succeeded:0,
  priced:0,
  failed:0,
  aggregatorFilled:0,
  blocked:!brightDataConfigured(),
  brightData:brightDataConfigured(),
  errors:[],
  phases:{}
 };

 const priorityIds=await loadPriorityIds(catalog);
 report.priorityCount=priorityIds.length;
 console.log(`FULL SWEEP starting: catalog ${catalog.length}, pricedBefore ${pricedBefore}, brightData=${report.brightData}, priority=${priorityIds.length}`);

 // Phase 0 — AFDC for scout_wanted / DFW empties first (TX-biased) before full catalog walk.
 const bulkEnabled=String(process.env.SCRAPER_BULK_AFDC||'1')!=='0';
 if(bulkEnabled&&priorityIds.length){
  try{
   console.log('phase-0 fillWantedFirst begin');
   await fillWantedFirst(catalog,priorityIds,report);
  }catch(e){
   report.phases.fillWantedFirstError=String(e.message||e).slice(0,240);
   console.warn('phase-0 fillWantedFirst-fail',report.phases.fillWantedFirstError);
  }
 }

 // Phase 1 — nationwide AFDC match against the entire catalog (fast, free).
 if(bulkEnabled){
  try{
   console.log('phase-1 afdc-nationwide begin');
   const bulk=await bulkFillFromAfdc(catalog,{
    fullSweep:true,
    maxUpserts:catalog.length,
    getExisting:async id=>getStationPrice(id).catch(()=>null),
    upsert:async(station,prices,updated,row)=>{
     await upsertPrices(station,prices,updated,{name:row?.name,address:row?.address});
    }
   });
   report.phases.afdc=bulk;
   report.aggregatorFilled+=(bulk.filled||0);
   report.priced+=(bulk.filled||0);
   await setSyncState('afdc_bulk_cursor',{stateIndex:0,updatedAt:new Date().toISOString(),last:bulk,fullSweep:true});
   console.log('phase-1 afdc-nationwide',JSON.stringify({
    filled:bulk.filled,scanned:bulk.scanned,matched:bulk.matched,
    afdcRows:bulk.afdcRows,afdcPricedRows:bulk.afdcPricedRows,mode:bulk.fetchMode,states:bulk.states?.length
   }));
  }catch(e){
   report.phases.afdcError=String(e.message||e).slice(0,240);
   console.warn('phase-1 afdc-fail',report.phases.afdcError);
  }
 }

 const existingMap=await loadExistingMap(catalog.map(s=>s.id));
 // One-time cloud Tesla harvest: every station lacking live Tesla TOU (AFDC approx still counts as needing Tesla).
 const needTesla=prioritizeStations(
  catalog.filter(s=>needsTeslaLive(existingMap.get(s.id)||null)),
  priorityIds
 );
 console.log(`phase-2 Tesla targets (no live TOU): ${needTesla.length} / ${catalog.length} (priority-first)`);

 // Phase 2 — Bright Data Web Unlocker for ALL stations missing Tesla live rates (cloud-only path).
 if(brightDataConfigured()&&needTesla.length){
  const bdLimit=Math.min(needTesla.length,Number(process.env.SCRAPER_BRIGHTDATA_MAX)||needTesla.length);
  console.log(`phase-2a brightdata Tesla unlock for up to ${bdLimit} stations`);
  let bdFilled=0,bdEmpty=0;
  for(let i=0;i<bdLimit;i++){
   const station=needTesla[i];
   try{
    const result=await scrapeOneTesla(station,{preferBrightDataOnly:true});
    report.succeeded++;
    if(result.priced){
     report.priced++;
     bdFilled++;
     existingMap.set(station.id,{
      prices:{member:{via:'brightdata'}},
      fetchedAt:new Date().toISOString(),
      rawCurrent:{member:{via:'brightdata',source:'Tesla public schedule'}},
      hasCurrent:true
     });
    }else bdEmpty++;
    console.log('bd-ok',station.id,result.priced?'priced':'empty');
   }catch(e){
    report.failed++;
    const msg=String(e.message||e).slice(0,240);
    if(/403|bot protection|blocked/i.test(msg))report.blocked=true;
    if(report.errors.length<80)report.errors.push({id:station.id,error:msg});
    await recordStationError(station.id,msg).catch(()=>{});
    console.warn('bd-fail',station.id,msg);
   }
   await sleep(jitter(400,1200));
  }
  report.phases.brightdata={attempted:bdLimit,filled:bdFilled,emptyDetail:bdEmpty,failed:report.failed};
 }else if(!brightDataConfigured()){
  console.warn('phase-2a SKIPPED — BRIGHTDATA_API_TOKEN unset (Actions cannot reach Tesla without Web Unlocker)');
  report.phases.brightdata={skipped:true,reason:'BRIGHTDATA_API_TOKEN unset'};
 }

 // Phase 3 — aggregator drain ONLY for stations still completely empty (not for AFDC→Tesla upgrade targets).
 const stillEmpty=prioritizeStations(
  catalog.filter(s=>pricesNeedAggregatorFill(existingMap.get(s.id)||null)),
  priorityIds
 );
 console.log(`phase-3 aggregator drain: ${stillEmpty.length} stations`);
 try{
  const drain=await drainEmptyStationsWithAggregators(stillEmpty,{
   existingById:existingMap,
   concurrency:Number(process.env.SCRAPER_DRAIN_CONCURRENCY)||4,
   delayMs:Number(process.env.SCRAPER_DRAIN_DELAY_MS)||300,
   upsert:async(station,prices,updated)=>upsertPrices(station,prices,updated),
   onProgress:p=>console.log('drain-progress',JSON.stringify(p))
  });
  report.phases.drain=drain;
  report.aggregatorFilled+=(drain.filled||0);
  report.priced+=(drain.filled||0);
  console.log('phase-3 drain done',JSON.stringify(drain));
 }catch(e){
  report.phases.drainError=String(e.message||e).slice(0,240);
  console.warn('phase-3 drain-fail',report.phases.drainError);
 }

 const pricedAfter=await countPricedStations().catch(()=>pricedBefore);
 const teslaAfter=catalog.filter(s=>!needsTeslaLive(existingMap.get(s.id)||null)).length;
 report.pricedAfter=pricedAfter;
 report.teslaLiveAfter=teslaAfter;
 report.finishedAt=new Date().toISOString();
 report.complete=true;
 report.fillRate=catalog.length?Number(((pricedAfter/catalog.length)*100).toFixed(2)):0;
 report.teslaFillRate=catalog.length?Number(((teslaAfter/catalog.length)*100).toFixed(2)):0;
 report.note=[
  'Full US catalog sweep finished (cloud Actions → Neon).',
  'pricedBefore='+pricedBefore,
  'pricedAfter='+pricedAfter,
  'teslaLiveAfter='+teslaAfter,
  'fillRate='+report.fillRate+'%',
  'teslaFillRate='+report.teslaFillRate+'%',
  report.brightData
   ?'Bright Data Web Unlocker attempted Tesla get-charger-details for stations lacking live TOU.'
   :'BLOCKED: No BRIGHTDATA_API_TOKEN secret — Tesla live harvest skipped (Actions IPs get 403). Set BRIGHTDATA_API_TOKEN (+ optional BRIGHTDATA_ZONE) and re-run full_sweep.'
 ].join(' ');

 await setSyncState('scraper_cursor',{offset:0,batchSize:catalog.length,updatedAt:new Date().toISOString(),fullSweep:true});
 await setLastScraperRun(report);
 console.log(JSON.stringify({
  mode:report.mode,
  catalogSize:report.catalogSize,
  pricedBefore,
  pricedAfter,
  fillRate:report.fillRate,
  aggregatorFilled:report.aggregatorFilled,
  phases:report.phases,
  note:report.note
 },null,2));
 process.exitCode=0;
}

async function runBatch(catalog){
 const limit=batchSize();
 const state=(await getSyncState('scraper_cursor'))||{offset:0};
 let offset=Number(state.offset)||0;
 if(offset<0||offset>=catalog.length)offset=0;

 const priorityIds=await loadPriorityIds(catalog);
 const byId=new Map(catalog.map(s=>[String(s.id),s]));
 const existingPriority=await getStationPrices(priorityIds.slice(0,200)).catch(()=>new Map());
 const priorityQueue=[];
 for(const id of priorityIds){
  if(priorityQueue.length>=limit)break;
  const s=byId.get(String(id));
  if(!s)continue;
  if(!pricesNeedAggregatorFill(existingPriority.get(s.id)||null))continue;
  priorityQueue.push(s);
 }

 // Fill remaining batch slots from the rotating catalog cursor (skip already-queued).
 const queued=new Set(priorityQueue.map(s=>s.id));
 const queue=[...priorityQueue];
 for(let i=0;i<catalog.length&&queue.length<limit;i++){
  const s=catalog[(offset+i)%catalog.length];
  if(queued.has(s.id))continue;
  queued.add(s.id);
  queue.push(s);
 }
 const catalogConsumed=Math.max(0,queue.length-priorityQueue.length);
 const nextOffset=catalog.length?(offset+catalogConsumed)%catalog.length:0;
 const existingMap=await getStationPrices(queue.map(s=>s.id)).catch(()=>new Map());
 const afdcCache=new Map();
 const pricedBefore=await countPricedStations().catch(()=>0);

 const report={
  startedAt:new Date().toISOString(),
  mode:'github-actions-cloud-automatic',
  catalogSize:catalog.length,
  batchSize:queue.length,
  priorityFirst:priorityQueue.length,
  offset,
  nextOffset,
  pricedBefore,
  succeeded:0,
  priced:0,
  failed:0,
  aggregatorFilled:0,
  blocked:false,
  brightData:brightDataConfigured(),
  errors:[],
  phases:{}
 };

 console.log(`Scraper starting: batch ${queue.length} (priority ${priorityQueue.length}) / catalog ${catalog.length} @ offset ${offset}`);

 // AFDC TX/wanted states before Tesla attempts so known AFDC prices (e.g. Lamar) land immediately.
 const bulkEnabled=String(process.env.SCRAPER_BULK_AFDC||'1')!=='0';
 if(bulkEnabled&&priorityQueue.length){
  try{await fillWantedFirst(catalog,priorityQueue.map(s=>s.id),report);}
  catch(e){
   report.phases.fillWantedFirstError=String(e.message||e).slice(0,240);
   console.warn('fillWantedFirst-fail',report.phases.fillWantedFirstError);
  }
 }

 for(const station of queue){
  // Skip Tesla unlock spam when fillWantedFirst already priced this id.
  const fresh=await getStationPrice(station.id).catch(()=>existingMap.get(station.id)||null);
  if(fresh&&!pricesNeedAggregatorFill(fresh)){
   report.priced++;
   console.log('skip-priced',station.id);
   continue;
  }

  let teslaPriced=false;
  try{
   const result=await scrapeOneTesla(station);
   report.succeeded++;
   if(result.priced){
    report.priced++;
    teslaPriced=true;
   }
   console.log('ok',station.id,result.priced?'priced':'empty');
  }catch(e){
   report.failed++;
   const msg=String(e.message||e).slice(0,240);
   if(/403|bot protection|blocked|impersonate/i.test(msg))report.blocked=true;
   report.errors.push({id:station.id,error:msg});
   await recordStationError(station.id,msg).catch(()=>{});
   console.warn('fail',station.id,msg);
  }

  // Fill from aggregators when Tesla failed or returned an empty schedule.
  if(!teslaPriced){
   await tryAggregatorFill(station,existingMap.get(station.id)||null,afdcCache,report);
  }
  await sleep(jitter(400,1200));
 }

 // Progressive nationwide AFDC bulk fill for empty stations (free DEMO_KEY / NREL_API_KEY).
 if(bulkEnabled){
  try{
   const bulkState=(await getSyncState('afdc_bulk_cursor'))||{stateIndex:0};
   // Prefer advancing from TX when cursor is cold and priority empties are Texan.
   let startIdx=Number(bulkState.stateIndex)||0;
   if(!bulkState.last&&priorityQueue.some(s=>/,\s*TX\b/i.test(String(s.address||'')))){
    const tx=US_STATES.indexOf('TX');
    if(tx>=0)startIdx=tx;
   }
   const bulk=await bulkFillFromAfdc(catalog,{
    statesPerRun:Number(process.env.AFDC_STATES_PER_RUN)||3,
    maxUpserts:Number(process.env.AFDC_MAX_UPSERTS)||80,
    startStateIndex:startIdx,
    getExisting:async id=>getStationPrice(id).catch(()=>null),
    upsert:async(station,prices,updated,row)=>{
     await upsertPrices(station,prices,updated,{name:row?.name,address:row?.address});
    }
   });
   report.afdcBulk=bulk;
   report.aggregatorFilled+=(bulk.filled||0);
   report.priced+=(bulk.filled||0);
   await setSyncState('afdc_bulk_cursor',{stateIndex:bulk.nextStateIndex,updatedAt:new Date().toISOString(),last:bulk});
   console.log('afdc-bulk',JSON.stringify({filled:bulk.filled,states:bulk.states,next:bulk.nextStateIndex}));
  }catch(e){
   report.afdcBulkError=String(e.message||e).slice(0,240);
   console.warn('afdc-bulk-fail',report.afdcBulkError);
  }
 }

 const pricedAfter=await countPricedStations().catch(()=>pricedBefore);
 report.pricedAfter=pricedAfter;
 await setSyncState('scraper_cursor',{offset:nextOffset,batchSize:limit,updatedAt:new Date().toISOString()});
 report.finishedAt=new Date().toISOString();
 report.complete=report.failed===0;
 report.note=report.blocked
  ?(report.aggregatorFilled
   ?'Tesla blocked datacenter fetches; filled '+report.aggregatorFilled+' station(s) from free aggregators (flat/approx rates). Optional Bright Data unlocks live TOU.'
   :'Tesla blocked datacenter fetches. Neon kept prior rows; aggregator harvest found no matching $/kWh for this batch. Next run continues AFDC bulk fill.')
  :'Batch finished';
 await setLastScraperRun(report);
 console.log(JSON.stringify({
  succeeded:report.succeeded,
  priced:report.priced,
  failed:report.failed,
  aggregatorFilled:report.aggregatorFilled,
  pricedBefore,
  pricedAfter,
  blocked:report.blocked,
  nextOffset,
  note:report.note
 },null,2));
 process.exitCode=0;
}

async function main(){
 if(!process.env.DATABASE_URL&&!process.env.POSTGRES_URL){
  console.error('DATABASE_URL is required');
  process.exit(1);
 }
 await ensureSchema();
 const catalog=await loadCatalog();
 if(fullSweepEnabled())await runFullSweep(catalog);
 else await runBatch(catalog);
}

main().catch(e=>{
 console.error(e);
 process.exit(1);
});
