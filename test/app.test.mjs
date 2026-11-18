import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {distance,evaluate,validateSchedule,compareEarliest} from '../public/logic.js';
import {parseTesla} from '../lib/tesla.js';import {stations,pricing,search,cached,clearCache,normalizeCatalog,normalizeFallbackCatalog} from '../lib/service.js';
import handler from '../api/search.js';
const fixture=JSON.parse(readFileSync(new URL('./tesla-fixture.json',import.meta.url),'utf8'));
const html=x=>'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{formattedData:{chargerDetails:x},locationSlug:'45386'}}})+'</script>';
test('overnight, timezone, DST and zero prices',()=>{const schedule=[{from:'22:00',to:'06:00',rate:.19},{from:'06:00',to:'22:00',rate:.45}];const p=evaluate({schedule,zone:'America/Chicago'},new Date('2026-11-10T21:00:00Z'));assert.equal(p.current,.45);assert.equal(p.start.toISOString(),'2026-11-11T04:00:00.000Z');assert.equal(evaluate({schedule,zone:'America/Chicago'},new Date('2026-11-01T06:30:00Z')).current,.19);assert.equal(evaluate({schedule:[{from:'00:00',to:'24:00',rate:0}],zone:'America/Chicago'}).low,0);assert.equal(evaluate(null),null);});
test('rejects gaps, overlaps and invalid times',()=>{assert.throws(()=>validateSchedule([{from:'00:00',to:'22:00',rate:.2}]));assert.throws(()=>validateSchedule([{from:'00:00',to:'24:00',rate:.2},{from:'10:00',to:'11:00',rate:.1}]));assert.throws(()=>validateSchedule([{from:'25:00',to:'24:00',rate:.2}]));});
test('earliest minima, then price and distance; unknown last',()=>{const make=(id,time,low,d)=>({id,e:{start:new Date(time),low},d,p:{currency:'USD'}});const a=make('late','2026-11-11T06:00:00Z',.1,1),b=make('early','2026-11-11T04:00:00Z',.2,2),c=make('cheaper','2026-11-11T04:00:00.900Z',.18,8),d=make('nearer','2026-11-11T04:00:00.500Z',.18,4);assert.deepEqual([a,b,c,d,{id:'unknown',e:null,d:0}].sort(compareEarliest).map(s=>s.id),['nearer','cheaper','early','late','unknown']);});
test('Tesla parser separates membership, prefers TOU and rejects dynamic prices',()=>{const prices=parseTesla(html(fixture));assert.equal(evaluate(prices.member,new Date('2026-11-10T21:00:00Z')).current,.41);assert.equal(evaluate(prices.public,new Date('2026-11-10T21:00:00Z')).current,.66);const dynamic=structuredClone(fixture);dynamic.effectivePricebooks.forEach(x=>x.minSiteOccupancy=1);assert.deepEqual(parseTesla(html(dynamic)),{});assert.throws(()=>parseTesla('<html>Unavailable</html>'));});
test('API validation and coordinate search',async()=>{assert.equal((await stations(new URLSearchParams('lat=&lng=0'))).status,400);assert.equal((await stations(new URLSearchParams('lat=91&lng=0'))).status,400);assert.equal((await pricing(new URLSearchParams('id=https://bad.example'))).status,400);assert.equal((await search(new URLSearchParams('q=91,0'))).status,400);assert.equal((await search(new URLSearchParams('q=32.8,-96.9'))).body[0].lat,32.8);});
test('public serverless adapter returns JSON and refuses POST',async()=>{function res(){return{headers:{},setHeader(k,v){this.headers[k]=v},end(body){this.body=JSON.parse(body)}}}const a=res();await handler({url:'/api/search?q=32.8,-96.9',method:'GET'},a);assert.equal(a.statusCode,200);assert.equal(a.body[0].lng,-96.9);assert.equal(a.headers['Cache-Control'],'no-store');const b=res();await handler({url:'/api/search',method:'POST'},b);assert.equal(b.statusCode,405);});
test('upstream adapter, geocoder, Neon-only pricing and catalog radius',async()=>{const original=globalThis.fetch;clearCache();globalThis.fetch=async url=>{if(String(url).includes('get-locations'))return Response.json({data:{data:[{location_url_slug:'2204',location_type:['nacs'],latitude:32.82,longitude:-96.95},{location_url_slug:'999',location_type:['supercharger'],latitude:0,longitude:0}]}});if(String(url).includes('photon'))return Response.json({features:[{geometry:{coordinates:[-96.8,32.7]},properties:{name:'Dallas',state:'Texas'}}]});throw Error('unexpected live Tesla detail fetch on user path: '+url);};try{const s=await stations(new URLSearchParams('lat=32.814&lng=-96.9489&radius=25'));assert.equal(s.body.stations.length,1);assert.ok(distance({lat:32.814,lng:-96.9489},s.body.stations[0])<25);assert.deepEqual(s.body.stations[0].prices,{});assert.match(s.body.pricingMessage,/price database|shared database/i);const p=await pricing(new URLSearchParams('id=2204'));assert.deepEqual(p.body.prices,{});assert.match(p.body.reason,/stored price|daily/i);assert.equal((await search(new URLSearchParams('q=Dallas'))).body[0].name,'Dallas, Texas');}finally{globalThis.fetch=original;clearCache();}});
test('stations attach Neon prices including previous freshness',async()=>{
 const {bodyFromDbRow}=await import('../lib/db.js');
 const prevFetched=new Date(Date.now()-3*86400000).toISOString();
 const previous={member:{schedule:[{from:'00:00',to:'24:00',rate:.2}],zone:'America/Chicago',currency:'USD',source:'Tesla public schedule',updated:prevFetched}};
 const body=bodyFromDbRow({
  stationId:'2204',name:'Cached Irving',address:'Story',country:'US',power:250,stalls:12,
  prices:previous,fetchedAt:prevFetched,freshness:'previous',
  previousPrices:previous,previousFetchedAt:prevFetched,hasCurrent:false,hasPrevious:true
 });
 assert.equal(body.freshness,'previous');
 assert.equal(body.prices.member.schedule[0].rate,.2);
 assert.match(body.station.name,/Irving/i);
});
test('cache coalesces simultaneous requests',async()=>{let n=0;await Promise.all([cached('test-dedupe',1000,async()=>++n),cached('test-dedupe',1000,async()=>++n)]);assert.equal(n,1);});

import {authorized,sync,status} from '../lib/sync.js';
import syncHandler from '../api/sync.js';
test('official catalog excludes planned/closed sites and deduplicates',()=>{
 const s={location_url_slug:'site',location_type:['nacs'],latitude:32,longitude:-96};
 assert.equal(normalizeCatalog({data:{data:[s,s,{...s,location_url_slug:'planned',location_type:['coming_soon_supercharger']},{...s,location_url_slug:'closed',supercharger_function:{site_status:'closed'}}]}}).length,1);
});
test('fallback catalog keeps only open sites with usable ids',()=>{
 const rows=[{locationId:'GrapevineTXsupercharger',name:'Grapevine',status:'OPEN',gps:{latitude:32.94,longitude:-97.06},address:{city:'Grapevine',state:'TX'},powerKilowatt:250,stallCount:12},{locationId:'planned',name:'Soon',status:'PLAN',gps:{latitude:32,longitude:-96}},{locationId:'bad id',status:'OPEN',gps:{latitude:32,longitude:-96}}];
 const out=normalizeFallbackCatalog(rows);
 assert.equal(out.length,1);assert.equal(out[0].id,'GrapevineTXsupercharger');assert.equal(out[0].source,'fallback');assert.equal(out[0].power,250);
});
test('stations fall back when Tesla catalog is blocked',async()=>{
 const original=globalThis.fetch;clearCache();
 globalThis.fetch=async url=>{
  if(String(url).includes('get-locations'))return new Response('<HTML><TITLE>Access Denied</TITLE></HTML>',{status:403});
  if(String(url).includes('supercharge.info'))return Response.json([{locationId:'GrapevineTXsupercharger',name:'Grapevine, TX',status:'OPEN',gps:{latitude:32.941942,longitude:-97.065861},address:{street:'Main',city:'Grapevine',state:'TX'},powerKilowatt:250,stallCount:12},{locationId:'far',name:'Far',status:'OPEN',gps:{latitude:0,longitude:0}}]);
  throw Error('unexpected '+url);
 };
 try{
  const s=await stations(new URLSearchParams('lat=32.814&lng=-96.9489&radius=25'));
  assert.equal(s.body.source,'fallback');
  assert.equal(s.body.stations.length,1);
  assert.match(s.body.pricingMessage,/Supercharge\.info|price database/i);
 }finally{globalThis.fetch=original;clearCache();}
});
test('cron auth and missing setup fail safely',async()=>{
 const env={...process.env};
 delete process.env.DATABASE_URL;delete process.env.POSTGRES_URL;
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;delete process.env.CRON_SECRET;
 try{
  assert.equal(authorized('Bearer wrong'),false);assert.equal((await status()).body.configured,false);assert.match((await status()).body.message,/not configured/i);assert.equal((await sync()).status,503);
  const res={setHeader(){},end(x){this.body=JSON.parse(x)}};await syncHandler({method:'GET',url:'/api/sync',headers:{}},res);assert.equal(res.statusCode,401);
 }finally{
  for(const key of ['DATABASE_URL','POSTGRES_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CRON_SECRET']){
   if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];
  }
 }
});
test('status explains empty first run without exposing operator secrets',async()=>{
 const env={...process.env};
 process.env.DATABASE_URL='postgresql://user:pass@127.0.0.1/db';
 process.env.CRON_SECRET='unit-test-cron-secret-24b';
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
 try{
  const s=await status();
  assert.equal(s.body.configured,true);
  assert.equal(s.body.lastRun,undefined);
  assert.equal(s.body.proxyReady,undefined);
  assert.match(s.body.message,/Neon|GitHub Actions|scraper|ready|refreshed/i);
  assert.doesNotMatch(s.body.message,/SCRAPERAPI_KEY|TESLA_PROXY_URL|SCRAPFLY_KEY/i);
 }finally{
  for(const key of ['DATABASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CRON_SECRET']){
   if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];
  }
 }
});
test('rejects short CRON_SECRET values',()=>{
 const env={...process.env};
 process.env.CRON_SECRET='too-short';
 try{assert.equal(authorized('Bearer too-short'),false);}
 finally{if(env.CRON_SECRET===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=env.CRON_SECRET;}
});
test('admin sync does not require Scrapfly and persists prices when Redis is present',async()=>{
 const original=fetch,env={...process.env};const saved=new Map();let fail=false;
 const cronSecret='unit-test-cron-secret-24b';
 process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='test';process.env.CRON_SECRET=cronSecret;process.env.SYNC_DAILY_LIMIT='1';
 delete process.env.SCRAPFLY_KEY;delete process.env.SCRAPERAPI_KEY;delete process.env.TESLA_PROXY_URL;delete process.env.DATABASE_URL;
 globalThis.fetch=async(url,options)=>{
 if(String(url).includes('redis.test')){const c=JSON.parse(options.body);let result=null;
 if(c[0]==='SET'){saved.set(c[1],c[2]);result='OK';}
 if(c[0]==='GET')result=saved.get(c[1])||null;
 if(c[0]==='ZRANGE')result=['2204'];
 if(c[0]==='ZREMRANGEBYSCORE'||c[0]==='ZREMRANGEBYRANK')result=0;
 if(c[0]==='SADD'||c[0]==='SREM')result=1;
 if(c[0]==='SCARD')result=1;
 if(c[0]==='EVAL'){saved.delete('scs:sync-lock');result=1;}
 return Response.json({result});}
 if(String(url).includes('get-locations'))return Response.json({data:{data:[{location_url_slug:'2204',location_type:['nacs'],latitude:32,longitude:-96}]}});
 if(fail)throw Error('Tesla temporarily unavailable');return Response.json({data:{data:{...fixture,name:'Official station'}}});};
 try{assert.equal(authorized('Bearer '+cronSecret),true);assert.equal(authorized('Bearer wrong'),false);
 const ok=await sync();assert.equal(ok.status,200);assert.equal(ok.body.succeeded,1);assert.equal(ok.body.limit,1);assert.equal(ok.body.mode,'admin');assert.ok(JSON.parse(saved.get('scs:station:2204')).prices.member);assert.equal(saved.has('scs:sync-lock'),false);assert.ok(saved.has('scs:sync-cursor'));
 fail=true;const bad=await sync();assert.equal(bad.status,503);assert.equal(bad.body.failed,1);assert.match((await status()).body.message,/unavailable|deferred|updated|Neon|refreshed/i);
 }finally{globalThis.fetch=original;for(const key of ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CRON_SECRET','SYNC_DAILY_LIMIT','SCRAPFLY_KEY','SCRAPERAPI_KEY','TESLA_PROXY_URL','DATABASE_URL']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});
test('failed scrape recording never clears prices shape helpers',async()=>{
 const {bodyFromDbRow}=await import('../lib/db.js');
 const previous={member:{schedule:[{from:'00:00',to:'24:00',rate:.31}],zone:'America/Chicago',currency:'USD',source:'Tesla public schedule',updated:'2026-11-01T00:00:00.000Z'}};
 const body=bodyFromDbRow({
  stationId:'x',name:'X',prices:previous,fetchedAt:'2026-11-01T00:00:00.000Z',freshness:'previous',
  previousPrices:previous,previousFetchedAt:'2026-11-01T00:00:00.000Z',hasCurrent:false,hasPrevious:true
 });
 assert.equal(body.freshness,'previous');
 assert.equal(body.prices.member.schedule[0].rate,.31);
});
test('scout CORS allows Tesla origins and validates payload shape',async()=>{
 const {corsHeaders,acceptScoutItems}=await import('../lib/scout.js');
 const headers=corsHeaders({headers:{origin:'https://www.tesla.com'}});
 assert.equal(headers['Access-Control-Allow-Origin'],'https://www.tesla.com');
 const env={...process.env};
 process.env.DATABASE_URL=process.env.DATABASE_URL||'postgresql://user:pass@localhost/db';
 try{
  const bad=await acceptScoutItems([]);
  assert.ok(bad.status===400||bad.status===503);
 }finally{
  if(env.DATABASE_URL===undefined)delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL=env.DATABASE_URL;
 }
});
