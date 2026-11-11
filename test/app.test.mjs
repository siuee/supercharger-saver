import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {distance,evaluate,validateSchedule,compareEarliest} from '../public/logic.js';
import {parseTesla} from '../lib/tesla.js';import {stations,pricing,search,cached,clearCache,normalizeCatalog,normalizeFallbackCatalog} from '../lib/service.js';import handler from '../api/search.js';
const fixture=JSON.parse(readFileSync(new URL('./tesla-fixture.json',import.meta.url),'utf8'));
const html=x=>'<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{formattedData:{chargerDetails:x},locationSlug:'45386'}}})+'</script>';
test('overnight, timezone, DST and zero prices',()=>{const schedule=[{from:'22:00',to:'06:00',rate:.19},{from:'06:00',to:'22:00',rate:.45}];const p=evaluate({schedule,zone:'America/Chicago'},new Date('2026-11-10T21:00:00Z'));assert.equal(p.current,.45);assert.equal(p.start.toISOString(),'2026-11-11T04:00:00.000Z');assert.equal(evaluate({schedule,zone:'America/Chicago'},new Date('2026-11-01T06:30:00Z')).current,.19);assert.equal(evaluate({schedule:[{from:'00:00',to:'24:00',rate:0}],zone:'America/Chicago'}).low,0);assert.equal(evaluate(null),null);});
test('rejects gaps, overlaps and invalid times',()=>{assert.throws(()=>validateSchedule([{from:'00:00',to:'22:00',rate:.2}]));assert.throws(()=>validateSchedule([{from:'00:00',to:'24:00',rate:.2},{from:'10:00',to:'11:00',rate:.1}]));assert.throws(()=>validateSchedule([{from:'25:00',to:'24:00',rate:.2}]));});
test('earliest minima, then price and distance; unknown last',()=>{const make=(id,time,low,d)=>({id,e:{start:new Date(time),low},d,p:{currency:'USD'}});const a=make('late','2026-11-11T06:00:00Z',.1,1),b=make('early','2026-11-11T04:00:00Z',.2,2),c=make('cheaper','2026-11-11T04:00:00.900Z',.18,8),d=make('nearer','2026-11-11T04:00:00.500Z',.18,4);assert.deepEqual([a,b,c,d,{id:'unknown',e:null,d:0}].sort(compareEarliest).map(s=>s.id),['nearer','cheaper','early','late','unknown']);});
test('Tesla parser separates membership, prefers TOU and rejects dynamic prices',()=>{const prices=parseTesla(html(fixture));assert.equal(evaluate(prices.member,new Date('2026-11-10T21:00:00Z')).current,.41);assert.equal(evaluate(prices.public,new Date('2026-11-10T21:00:00Z')).current,.66);const dynamic=structuredClone(fixture);dynamic.effectivePricebooks.forEach(x=>x.minSiteOccupancy=1);assert.deepEqual(parseTesla(html(dynamic)),{});assert.throws(()=>parseTesla('<html>Unavailable</html>'));});
test('API validation and coordinate search',async()=>{assert.equal((await stations(new URLSearchParams('lat=&lng=0'))).status,400);assert.equal((await stations(new URLSearchParams('lat=91&lng=0'))).status,400);assert.equal((await pricing(new URLSearchParams('id=https://bad.example'))).status,400);assert.equal((await search(new URLSearchParams('q=91,0'))).status,400);assert.equal((await search(new URLSearchParams('q=32.8,-96.9'))).body[0].lat,32.8);});
test('public serverless adapter returns JSON and refuses POST',async()=>{function res(){return{headers:{},setHeader(k,v){this.headers[k]=v},end(body){this.body=JSON.parse(body)}}}const a=res();await handler({url:'/api/search?q=32.8,-96.9',method:'GET'},a);assert.equal(a.statusCode,200);assert.equal(a.body[0].lng,-96.9);assert.equal(a.headers['Cache-Control'],'no-store');const b=res();await handler({url:'/api/search',method:'POST'},b);assert.equal(b.statusCode,405);});
test('upstream adapter, geocoder, Redis-only pricing and catalog radius',async()=>{const original=globalThis.fetch;clearCache();globalThis.fetch=async url=>{if(String(url).includes('get-locations'))return Response.json({data:{data:[{location_url_slug:'2204',location_type:['nacs'],latitude:32.82,longitude:-96.95},{location_url_slug:'999',location_type:['supercharger'],latitude:0,longitude:0}]}});if(String(url).includes('photon'))return Response.json({features:[{geometry:{coordinates:[-96.8,32.7]},properties:{name:'Dallas',state:'Texas'}}]});throw Error('unexpected live Tesla detail fetch on user path: '+url);};try{const s=await stations(new URLSearchParams('lat=32.814&lng=-96.9489&radius=25'));assert.equal(s.body.stations.length,1);assert.ok(distance({lat:32.814,lng:-96.9489},s.body.stations[0])<25);assert.deepEqual(s.body.stations[0].prices,{});assert.match(s.body.pricingMessage,/daily-cached|shared database/i);const p=await pricing(new URLSearchParams('id=2204'));assert.deepEqual(p.body.prices,{});assert.match(p.body.reason,/daily-cached/i);assert.equal((await search(new URLSearchParams('q=Dallas'))).body[0].name,'Dallas, Texas');}finally{globalThis.fetch=original;clearCache();}});
test('stations MGET attaches shared Redis prices for concurrent readers',async()=>{
 const original=fetch,env={...process.env};const saved=new Map();
 process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='test';
 clearCache();
 const priced={prices:{member:{schedule:[{from:'00:00',to:'24:00',rate:.2}],zone:'America/Chicago',currency:'USD',source:'Tesla public schedule',updated:new Date().toISOString()}},updated:new Date().toISOString(),station:{name:'Cached Irving',address:'Story',power:250,stalls:12},reason:''};
 saved.set('scs:station:2204',JSON.stringify(priced));
 globalThis.fetch=async(url,options)=>{
  if(String(url).includes('redis.test')){
   const c=JSON.parse(options.body);let result=null;
   if(c[0]==='MGET')result=c.slice(1).map(k=>saved.get(k)||null);
   if(c[0]==='ZADD')result=1;
   if(c[0]==='GET')result=saved.get(c[1])||null;
   return Response.json({result});
  }
  if(String(url).includes('get-locations'))return Response.json({data:{data:[{location_url_slug:'2204',location_type:['nacs'],latitude:32.82,longitude:-96.95}]}});
  throw Error('unexpected '+url);
 };
 try{
  const s=await stations(new URLSearchParams('lat=32.814&lng=-96.9489&radius=25'));
  assert.equal(s.body.priced,1);
  assert.equal(s.body.stations[0].prices.member.schedule[0].rate,.2);
  assert.equal(s.body.stations[0].name,'Cached Irving');
  const p=await pricing(new URLSearchParams('id=2204'));
  assert.equal(p.body.prices.member.schedule[0].rate,.2);
 }finally{globalThis.fetch=original;clearCache();for(const key of ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
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
  assert.match(s.body.pricingMessage,/Supercharge\.info|daily-cached/i);
 }finally{globalThis.fetch=original;clearCache();}
});
test('cron auth and missing setup fail safely',async()=>{
 assert.equal(authorized('Bearer wrong'),false);assert.equal((await status()).body.configured,false);assert.match((await status()).body.message,/not configured/i);assert.equal((await sync()).status,503);
 const res={setHeader(){},end(x){this.body=JSON.parse(x)}};await syncHandler({method:'GET',url:'/api/sync',headers:{}},res);assert.equal(res.statusCode,401);
});
test('status explains empty first run without exposing operator secrets',async()=>{
 const env={...process.env};
 process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='test';process.env.CRON_SECRET='secret';
 const original=fetch;
 globalThis.fetch=async()=>Response.json({result:null});
 try{
  const s=await status();
  assert.equal(s.body.configured,true);
  assert.match(s.body.message,/Cloud daily price sync is ready|first Vercel cron has not run yet/i);
  assert.doesNotMatch(s.body.message,/SCRAPERAPI_KEY|TESLA_PROXY_URL|SCRAPFLY_KEY/i);
 }finally{globalThis.fetch=original;for(const key of ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CRON_SECRET']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});
test('daily sync persists official prices, records failures, and releases lock',async()=>{
 const original=fetch,env={...process.env};const saved=new Map();let fail=false;
 process.env.UPSTASH_REDIS_REST_URL='https://redis.test';process.env.UPSTASH_REDIS_REST_TOKEN='test';process.env.CRON_SECRET='test-secret';process.env.SYNC_DAILY_LIMIT='1';process.env.SCRAPFLY_KEY='test-key';
 globalThis.fetch=async(url,options)=>{
 if(String(url).includes('redis.test')){const c=JSON.parse(options.body);let result=null;
 if(c[0]==='SET'){saved.set(c[1],c[2]);result='OK';}
 if(c[0]==='GET')result=saved.get(c[1])||null;
 if(c[0]==='ZRANGE')result=['2204'];
 if(c[0]==='ZREMRANGEBYSCORE')result=0;
 if(c[0]==='SADD'||c[0]==='SREM')result=1;
 if(c[0]==='SCARD')result=1;
 if(c[0]==='EVAL'){saved.delete('scs:sync-lock');result=1;}
 return Response.json({result});}
 if(String(url).includes('get-locations'))return Response.json({data:{data:[{location_url_slug:'2204',location_type:['nacs'],latitude:32,longitude:-96}]}});
 if(String(url).includes('scrapfly.io')){
  if(fail)return Response.json({result:{success:false,error:{message:'blocked'}}}, {status:200});
  return Response.json({result:{success:true,content:JSON.stringify({data:{data:{...fixture,name:'Official station'}}})}});
 }
 if(fail)throw Error('Tesla temporarily unavailable');return Response.json({data:{data:{...fixture,name:'Official station'}}});};
 try{assert.equal(authorized('Bearer test-secret'),true);assert.equal(authorized('Bearer wrong'),false);
 const ok=await sync();assert.equal(ok.status,200);assert.equal(ok.body.succeeded,1);assert.equal(ok.body.limit,1);assert.equal(ok.body.mode,'cloud');assert.ok(JSON.parse(saved.get('scs:station:2204')).prices.member);assert.equal(saved.has('scs:sync-lock'),false);assert.ok(saved.has('scs:sync-cursor'));
 fail=true;const bad=await sync();assert.equal(bad.status,503);assert.equal(bad.body.failed,1);assert.equal((await status()).body.lastRun.complete,false);
 }finally{globalThis.fetch=original;for(const key of ['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','CRON_SECRET','SYNC_DAILY_LIMIT','SCRAPFLY_KEY']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});
