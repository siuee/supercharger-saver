import {distance} from '../public/logic.js';
import {parseDetail} from './tesla.js';
import {configured,redis,read,readMany,write,markPriced,STATION_TTL} from './store.js';
const NO_CACHE_REASON='No daily-cached price for this station yet. Rates are stored once per day in the shared database and reused by every visitor.';
const hasPrices=b=>b?.prices&&Object.keys(b.prices).length>0;
async function persistStation(id,body,strict=false){
 if(!configured())return;
 try{
  await write('station:'+id,body,STATION_TTL);
  await markPriced(id,hasPrices(body));
 }catch(e){if(strict)throw e;}
}
const memo=new Map(),pending=new Map();
export function clearCache(){memo.clear();pending.clear();}
export async function cached(key,ttl,fn){const v=memo.get(key);if(v&&v.until>Date.now())return v.data;if(pending.has(key))return pending.get(key);const task=Promise.resolve().then(fn).then(data=>{if(memo.size>=300)memo.delete(memo.keys().next().value);memo.set(key,{data,until:Date.now()+ttl});return data;}).finally(()=>pending.delete(key));pending.set(key,task);return task;}

const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function teslaHeaders(type='json'){
 return{
  Accept:type==='json'?'application/json, text/plain, */*':'text/html,application/xhtml+xml',
  'Accept-Language':'en-US,en;q=0.9',
  'User-Agent':BROWSER_UA,
  Referer:'https://www.tesla.com/findus',
  Origin:'https://www.tesla.com',
  'Sec-Fetch-Dest':'empty',
  'Sec-Fetch-Mode':'cors',
  'Sec-Fetch-Site':'same-origin'
 };
}
function resolveUpstreamUrl(url){
 const target=String(url);
 // Only proxy charger-detail fetches. Catalog map endpoints burn credits and
 // hang every /api/pricing call when a proxy is slow — Supercharge.info covers locations.
 const needsProxy=/tesla\.com\/api\/findus\/get-charger-details/i.test(target);
 if(needsProxy&&process.env.SCRAPFLY_KEY){
  const proxied=new URL('https://api.scrapfly.io/scrape');
  proxied.searchParams.set('key',process.env.SCRAPFLY_KEY);
  proxied.searchParams.set('url',target);
  proxied.searchParams.set('asp','true');
  proxied.searchParams.set('country','us');
  return {url:proxied,viaProxy:true,viaScrapfly:true};
 }
 if(needsProxy&&process.env.SCRAPERAPI_KEY){
  const proxied=new URL('https://api.scraperapi.com/');
  proxied.searchParams.set('api_key',process.env.SCRAPERAPI_KEY);
  proxied.searchParams.set('url',target);
  proxied.searchParams.set('country_code','us');
  // Let ScraperAPI own headers — keep_headers lowers Tesla/Akamai success.
  return {url:proxied,viaProxy:true};
 }
 if(needsProxy&&process.env.TESLA_PROXY_URL){
  const base=process.env.TESLA_PROXY_URL.replace(/\/$/,'');
  const proxied=base.includes('{url}')?base.replace('{url}',encodeURIComponent(target)):base+(base.includes('?')?'&':'?')+'url='+encodeURIComponent(target);
  return {url:proxied,viaProxy:true};
 }
 return {url,viaProxy:false};
}
async function upstreamOnce(url,type='json'){
 const resolved=resolveUpstreamUrl(url);
 const viaProxy=resolved.viaProxy;
 const target=resolved.url;
 const headers=viaProxy
  ?{Accept:type==='json'?'application/json, text/plain, */*':'text/html','User-Agent':'SuperchargerSaver/1.0'}
  :(/tesla\.com/i.test(String(url))?teslaHeaders(type):{Accept:type==='json'?'application/json':'text/html','User-Agent':'SuperchargerSaver/1.0'});
 // Proxied Akamai bypass often needs 45–90s; free-tier concurrency is low.
 const r=await fetch(target,{headers,signal:AbortSignal.timeout(viaProxy?90000:20000)});
 let text=await r.text();
 if(!r.ok)throw Error(/tesla\.com/i.test(String(url))?'Tesla upstream blocked ('+r.status+')':'Upstream unavailable');
 if(resolved.viaScrapfly){
  let envelope;
  try{envelope=JSON.parse(text);}catch{throw Error('Invalid Scrapfly response');}
  if(!envelope?.result?.success){
   const msg=envelope?.result?.error?.message||envelope?.message||'Scrapfly request failed';
   throw Error(msg);
  }
  text=typeof envelope.result.content==='string'?envelope.result.content:JSON.stringify(envelope.result.content);
 }
 if(/tesla\.com/i.test(String(url))&&(/Access Denied|cpr_chlge|"t":\s*"\d+"/i.test(text)||text.trimStart().startsWith('<HTML>')||/Protected domains may require/i.test(text)))throw Error('Tesla bot protection blocked this request');
 if(type!=='json')return text;
 try{return JSON.parse(text);}catch{throw Error('Invalid upstream JSON');}
}
async function upstream(url,type='json'){
 // One retry only — free proxy tiers often need 45–90s per attempt.
 const attempts=(process.env.SCRAPFLY_KEY||process.env.SCRAPERAPI_KEY)&&/tesla\.com/i.test(String(url))?2:1;
 let last;
 for(let i=0;i<attempts;i++){
  try{return await upstreamOnce(url,type);}
  catch(e){last=e;if(i<attempts-1)await new Promise(r=>setTimeout(r,2000));}
 }
 throw last;
}

export const CATALOG_URL='https://www.tesla.com/api/findus/get-locations?country=US&view=map';
export const FALLBACK_CATALOG_URL='https://supercharge.info/service/supercharge/allSites';
export function normalizeCatalog(data){
 if(!Array.isArray(data?.data?.data))throw Error('Invalid official catalog');
 const seen=new Set();
 return data.data.data.filter(s=>s.location_type?.some(t=>['supercharger','nacs'].includes(t))&&(!s.supercharger_function?.site_status||s.supercharger_function.site_status.toLowerCase()==='open')).flatMap(s=>{
 const id=s.location_url_slug;
 if(typeof id!=='string'||!validId(id)||seen.has(id)||!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude))return [];
 seen.add(id);return [{id,teslaId:id,name:s.title&&s.title!=='locations'?s.title:'Tesla Supercharger · '+id,lat:s.latitude,lng:s.longitude,inHkMoTw:!!s.inHkMoTw,source:'tesla'}];});
}
export function normalizeFallbackCatalog(rows){
 if(!Array.isArray(rows))throw Error('Invalid fallback catalog');
 const seen=new Set();
 return rows.filter(s=>String(s.status||'').toUpperCase()==='OPEN'&&s.gps&&Number.isFinite(s.gps.latitude)&&Number.isFinite(s.gps.longitude)).flatMap(s=>{
  const id=String(s.locationId||'');
  if(!validId(id)||seen.has(id))return [];
  seen.add(id);
  const a=s.address||{};
  return[{id,teslaId:id,name:s.name||('Tesla Supercharger · '+id),lat:s.gps.latitude,lng:s.gps.longitude,inHkMoTw:false,source:'fallback',address:[a.street,a.city,a.state,a.zip].filter(Boolean).join(', '),country:a.country,power:s.powerKilowatt,stalls:s.stallCount}];
 });
}
const validId=id=>/^[a-zA-Z0-9_-]{1,150}$/.test(id);

async function fetchOfficialCatalog(){
 const data={stations:normalizeCatalog(await upstream(CATALOG_URL)),fetchedAt:new Date().toISOString(),source:'tesla'};
 if(configured())await write('catalog',data,86400).catch(()=>{});
 return data;
}
async function fetchFallbackCatalog(){
 const data={stations:normalizeFallbackCatalog(await upstream(FALLBACK_CATALOG_URL)),fetchedAt:new Date().toISOString(),source:'fallback'};
 if(configured())await write('catalog',data,21600).catch(()=>{});
 return data;
}
export async function getCatalog(force=false){
 const load=async()=>{
  try{return await fetchOfficialCatalog();}
  catch(officialError){
   try{const fallback=await fetchFallbackCatalog();fallback.officialError=String(officialError.message||officialError);return fallback;}
   catch{throw officialError;}
  }
 };
 if(force)return load();
 return cached('official-catalog',3600000,async()=>{
  const saved=await read('catalog').catch(()=>null);
  if(saved?.stations?.length&&Date.now()-Date.parse(saved.fetchedAt)<3600000)return saved;
  return load();
 });
}
export function stationBodyFromDetail(detail,id,updated=new Date().toISOString()){
 if(!detail?.name||!detail.timeZone)throw Error('Official details unavailable');
 const prices=parseDetail(detail,id,updated),a=detail.address||{};
 return{prices,updated,station:{name:detail.name,address:[a.streetNumber,a.street,a.city,a.state,a.postalCode].filter(Boolean).join(' '),country:a.country,power:detail.maxPowerKw,stalls:detail.publicStallCount},reason:Object.keys(prices).length?'':'Tesla does not publish a comparable daily per-kWh schedule here. Demand-dependent, weekly or tiered prices are not ranked.'};
}
export async function fetchStation(station,strict=false){
 const url=new URL('https://www.tesla.com/api/findus/get-charger-details');
 url.search=new URLSearchParams({locationSlug:station.id,programType:'supercharger',locale:'en-US',isInHkMoTw:String(!!station.inHkMoTw)});
 const detail=(await upstream(url))?.data?.data;
 const body=stationBodyFromDetail(detail,station.id);
 await persistStation(station.id,body,strict);
 return body;
}
export async function ingestDetails(items){
 if(!configured())return{status:503,body:{error:'Redis is not configured.'}};
 if(!Array.isArray(items)||!items.length||items.length>100)return{status:400,body:{error:'Send 1–100 Tesla charger detail objects.'}};
 const saved=[],failed=[];
 for(const item of items){
  const id=String(item?.id||item?.locationSlug||'');
  const detail=item?.detail||item?.data?.data||item;
  if(!validId(id)){failed.push({id,error:'Invalid id'});continue;}
  try{
   const body=stationBodyFromDetail(detail,id);
   await persistStation(id,body,true);
   saved.push({id,priced:hasPrices(body)});
  }catch(e){failed.push({id,error:String(e.message||e)});}
 }
 return{body:{saved:saved.length,failed:failed.length,stations:saved,errors:failed}};
}
export async function stations(q){
 const rawLat=q.get('lat'),rawLng=q.get('lng'),lat=Number(rawLat),lng=Number(rawLng),radius=Number(q.get('radius')||25);
 if(!rawLat?.trim()||!rawLng?.trim()||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180||![10,25,50,100].includes(radius))return{status:400,body:{error:'Enter valid coordinates and a radius of 10, 25, 50 or 100 miles.'}};
 const catalog=await getCatalog(),center={lat,lng};
 const nearby=catalog.stations.filter(s=>distance(center,s)<=radius).sort((a,b)=>distance(center,a)-distance(center,b));
 // Shared watched queue: every visitor's location feeds the same daily refresh set.
 if(configured()&&nearby.length)await redis(['ZADD','scs:watched',...nearby.flatMap(s=>[Date.now(),s.id])]).catch(()=>{});
 const cachedBodies=configured()?await readMany(nearby.map(s=>'station:'+s.id)).catch(()=>nearby.map(()=>null)):nearby.map(()=>null);
 const found=nearby.map((s,i)=>{
  const saved=cachedBodies[i];
  const base={id:s.id,teslaId:s.teslaId,name:s.name,lat:s.lat,lng:s.lng,inHkMoTw:!!s.inHkMoTw,address:s.address,country:s.country,power:s.power,stalls:s.stalls,source:s.source||catalog.source};
  if(!saved)return{...base,prices:{},reason:NO_CACHE_REASON};
  return{
   ...base,
   name:saved.station?.name||base.name,
   address:saved.station?.address||base.address,
   country:saved.station?.country||base.country,
   power:saved.station?.power??base.power,
   stalls:saved.station?.stalls??base.stalls,
   prices:saved.prices||{},
   updated:saved.updated,
   reason:hasPrices(saved)?'':(saved.reason||NO_CACHE_REASON)
  };
 });
 const priced=found.filter(s=>hasPrices(s)).length;
 const pricingMessage=catalog.source==='tesla'
  ?'Shared station catalog with daily-cached Tesla schedules. '+priced+' of '+found.length+' nearby stops have rates in the shared database.'
  :'Locations from Supercharge.info (Tesla catalog blocked from this host). '+priced+' of '+found.length+' nearby stops have daily-cached rates in the shared database.';
 return{body:{stations:found,fetchedAt:catalog.fetchedAt,source:catalog.source||'tesla',pricingMessage,priced,total:found.length}};
}
export async function pricing(q){
 const id=q.get('id');if(!id||!validId(id))return{status:400,body:{error:'Invalid station ID.'}};
 const station=(await getCatalog()).stations.find(s=>s.id===id);if(!station)return{status:404,body:{error:'Station not found in the current catalog.'}};
 const fallbackMeta={name:station.name,address:station.address,country:station.country,power:station.power,stalls:station.stalls};
 // User path is Redis-only — never call Tesla/Scrapfly here (shared cache for concurrent users).
 const saved=await read('station:'+id).catch(()=>null);
 if(hasPrices(saved))return{body:saved};
 return{body:{prices:{},station:saved?.station||fallbackMeta,updated:saved?.updated,reason:saved?.reason||NO_CACHE_REASON}};
}
export async function search(q){const query=(q.get('q')||'').trim();if(query.length<2||query.length>200)return{status:400,body:{error:'Enter a city, ZIP code or address (2–200 characters).'}};const coords=query.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);if(coords){const lat=Number(coords[1]),lng=Number(coords[2]);return Math.abs(lat)<=90&&Math.abs(lng)<=180?{body:[{name:query,lat,lng}]}:{status:400,body:{error:'Coordinates are out of range.'}};}if(/^irving(?:,?\s+tx)?$/i.test(query))return{body:[{name:'Irving, Texas, United States',lat:32.814,lng:-96.9489}]};try{const endpoint=new URL(process.env.PHOTON_URL||'https://photon.komoot.io/api/');endpoint.searchParams.set('q',query);endpoint.searchParams.set('limit','5');const body=await cached(endpoint.href,86400000,async()=>{const data=await upstream(endpoint);if(!Array.isArray(data.features))throw Error('Invalid geocoding response');return data.features.filter(f=>Array.isArray(f.geometry?.coordinates)&&f.geometry.coordinates.length>=2).map(f=>{const p=f.properties||{};return{name:[...new Set([p.name,[p.housenumber,p.street].filter(Boolean).join(' '),p.city,p.state,p.postcode,p.country].filter(Boolean))].join(', '),lng:f.geometry.coordinates[0],lat:f.geometry.coordinates[1]};});});return{body};}catch{return{status:503,body:{error:'Location search is temporarily unavailable. Use your GPS or enter latitude, longitude.'}};}}
