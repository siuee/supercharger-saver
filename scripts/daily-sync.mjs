#!/usr/bin/env node
/**
 * Free primary price refill for the shared Redis cache.
 *
 * Runs on a home / residential PC (Tesla often allows this IP without Scrapfly).
 * 1) Lists station IDs anyone searched recently (shared scs:watched)
 * 2) Fetches Tesla get-charger-details for each (direct, no paid proxy)
 * 3) POSTs batches to /api/ingest so every concurrent website visitor can read them
 *
 * Usage:
 *   set CRON_SECRET=...   (same as Vercel)
 *   set APP_URL=https://supercharger-saver.vercel.app
 *   node scripts/daily-sync.mjs
 *   node scripts/daily-sync.mjs 45386 32616   # optional explicit IDs
 *
 * Windows Task Scheduler: daily action
 *   program: node
 *   arguments: C:\path\to\scripts\daily-sync.mjs
 *   start in: C:\path\to\supercharger-saver
 *   env: CRON_SECRET, APP_URL
 */
const secret=process.env.CRON_SECRET;
const base=(process.env.APP_URL||'https://supercharger-saver.vercel.app').replace(/\/$/,'');
const limit=Math.max(1,Number(process.env.DAILY_SYNC_BATCH)||40);
const pauseMs=Math.max(0,Number(process.env.DAILY_SYNC_PAUSE_MS)||1500);
const cliIds=process.argv.slice(2).filter(Boolean);

if(!secret){
 console.error('CRON_SECRET is required (same value as Vercel production).');
 process.exit(1);
}

const auth={Authorization:'Bearer '+secret,'Content-Type':'application/json','User-Agent':'SuperchargerSaver-daily-sync/1.0'};

async function listWatched(){
 const r=await fetch(base+'/api/sync?list=watched',{headers:auth,signal:AbortSignal.timeout(30000)});
 const body=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(body.error||('watched list HTTP '+r.status));
 return Array.isArray(body.ids)?body.ids:[];
}

async function fetchDetail(id){
 const url=new URL('https://www.tesla.com/api/findus/get-charger-details');
 url.search=new URLSearchParams({locationSlug:id,programType:'supercharger',locale:'en-US',isInHkMoTw:'false'});
 const r=await fetch(url,{
  headers:{
   Accept:'application/json, text/plain, */*',
   'Accept-Language':'en-US,en;q=0.9',
   'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
   Referer:'https://www.tesla.com/findus',
   Origin:'https://www.tesla.com'
  },
  signal:AbortSignal.timeout(45000)
 });
 const text=await r.text();
 if(!r.ok)throw Error('HTTP '+r.status);
 if(/Access Denied|cpr_chlge/i.test(text)||text.trimStart().startsWith('<HTML>'))throw Error('Tesla bot protection blocked this request');
 const json=JSON.parse(text);
 const detail=json?.data?.data;
 if(!detail?.name)throw Error('Missing detail payload');
 return detail;
}

async function ingest(items){
 const r=await fetch(base+'/api/ingest',{method:'POST',headers:auth,body:JSON.stringify({items}),signal:AbortSignal.timeout(60000)});
 const body=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(body.error||('ingest HTTP '+r.status));
 return body;
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const ids=(cliIds.length?cliIds:await listWatched()).slice(0,limit);
console.log('daily-sync',base,'stations',ids.length);
if(!ids.length){
 console.log('No watched station IDs yet. Open the website and search a few areas first, then re-run.');
 process.exit(0);
}

const batch=[];
let ok=0,fail=0;
for(const id of ids){
 try{
  const detail=await fetchDetail(id);
  batch.push({id,detail});
  console.log('ok',id,detail.name);
  ok++;
 }catch(e){
  console.error('fail',id,String(e.message||e));
  fail++;
 }
 if(batch.length>=20){
  const res=await ingest(batch.splice(0,batch.length));
  console.log('ingest',res);
 }
 if(pauseMs)await sleep(pauseMs);
}
if(batch.length){
 const res=await ingest(batch);
 console.log('ingest',res);
}
console.log('done ok='+ok+' fail='+fail);
process.exit(fail&&!ok?1:0);
