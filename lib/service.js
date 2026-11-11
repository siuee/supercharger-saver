import {distance} from '../public/logic.js';
import {parseDetail} from './tesla.js';
import {configured,redis,read,write} from './store.js';
const memo=new Map(),pending=new Map();
export async function cached(key,ttl,fn){const v=memo.get(key);if(v&&v.until>Date.now())return v.data;if(pending.has(key))return pending.get(key);const task=Promise.resolve().then(fn).then(data=>{if(memo.size>=300)memo.delete(memo.keys().next().value);memo.set(key,{data,until:Date.now()+ttl});return data;}).finally(()=>pending.delete(key));pending.set(key,task);return task;}
async function upstream(url,type='json'){const r=await fetch(url,{headers:{Accept:type==='json'?'application/json':'text/html','User-Agent':'SuperchargerSaver/1.0'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Upstream unavailable');return type==='json'?r.json():r.text();}

export const CATALOG_URL='https://www.tesla.com/api/findus/get-locations?country=US&view=map';
export function normalizeCatalog(data){
 if(!Array.isArray(data?.data?.data))throw Error('Invalid official catalog');
 const seen=new Set();
 return data.data.data.filter(s=>s.location_type?.some(t=>['supercharger','nacs'].includes(t))&&(!s.supercharger_function?.site_status||s.supercharger_function.site_status.toLowerCase()==='open')).flatMap(s=>{
 const id=s.location_url_slug;
 if(typeof id!=='string'||!validId(id)||seen.has(id)||!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude))return [];
 seen.add(id);return [{id,teslaId:id,name:s.title&&s.title!=='locations'?s.title:'Tesla Supercharger · '+id,lat:s.latitude,lng:s.longitude,inHkMoTw:!!s.inHkMoTw}];});
}
const validId=id=>/^[a-zA-Z0-9_-]{1,150}$/.test(id);
export async function getCatalog(force=false){
 const fetchCatalog=async()=>{const data={stations:normalizeCatalog(await upstream(CATALOG_URL)),fetchedAt:new Date().toISOString()};if(configured())await write('catalog',data,86400).catch(()=>{});return data;};
 if(force)return fetchCatalog();
 return cached('official-catalog',3600000,async()=>{const saved=await read('catalog').catch(()=>null);if(saved&&Date.now()-Date.parse(saved.fetchedAt)<3600000)return saved;return fetchCatalog();});
}
export async function fetchStation(station,strict=false){
 const url=new URL('https://www.tesla.com/api/findus/get-charger-details');
 url.search=new URLSearchParams({locationSlug:station.id,programType:'supercharger',locale:'en-US',isInHkMoTw:String(station.inHkMoTw)});
 const detail=(await upstream(url))?.data?.data;
 if(!detail?.name||!detail.timeZone)throw Error('Official details unavailable');
 const updated=new Date().toISOString(), prices=parseDetail(detail,station.id,updated),a=detail.address||{};
 const body={prices,updated,station:{name:detail.name,address:[a.streetNumber,a.street,a.city,a.state,a.postalCode].filter(Boolean).join(' '),country:a.country,power:detail.maxPowerKw,stalls:detail.publicStallCount},reason:Object.keys(prices).length?'':'Tesla does not publish a comparable daily per-kWh schedule here. Demand-dependent, weekly or tiered prices are not ranked.'};
 if(configured())await write('station:'+station.id,body,86400).catch(e=>{if(strict)throw e;});
 return body;
}
export async function stations(q){
 const rawLat=q.get('lat'),rawLng=q.get('lng'),lat=Number(rawLat),lng=Number(rawLng),radius=Number(q.get('radius')||25);
 if(!rawLat?.trim()||!rawLng?.trim()||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180||![10,25,50,100].includes(radius))return{status:400,body:{error:'Enter valid coordinates and a radius of 10, 25, 50 or 100 miles.'}};
 const catalog=await getCatalog(),center={lat,lng};
 const found=catalog.stations.filter(s=>distance(center,s)<=radius).sort((a,b)=>distance(center,a)-distance(center,b));
 if(configured()&&found.length)await redis(['ZADD','scs:watched',...found.flatMap(s=>[Date.now(),s.id])]).catch(()=>{});
 return{body:{stations:found,fetchedAt:catalog.fetchedAt,pricingMessage:'Official Tesla locations. Checking published schedules.'}};
}
export async function pricing(q){
 const id=q.get('id');if(!id||!validId(id))return{status:400,body:{error:'Invalid station ID.'}};
 const station=(await getCatalog()).stations.find(s=>s.id===id);if(!station)return{status:404,body:{error:'Station not found in Tesla’s current catalog.'}};
 try{const body=await cached('price:'+id,900000,async()=>{const saved=await read('station:'+id).catch(()=>null);if(saved&&Date.now()-Date.parse(saved.updated)<900000)return saved;return fetchStation(station);});return{body};}
 catch{return{body:{prices:{},reason:'Tesla’s official pricing feed is unavailable. No estimated or stale price is shown.'}};}
}
export async function search(q){const query=(q.get('q')||'').trim();if(query.length<2||query.length>200)return{status:400,body:{error:'Enter a city, ZIP code or address (2–200 characters).'}};const coords=query.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);if(coords){const lat=Number(coords[1]),lng=Number(coords[2]);return Math.abs(lat)<=90&&Math.abs(lng)<=180?{body:[{name:query,lat,lng}]}:{status:400,body:{error:'Coordinates are out of range.'}};}if(/^irving(?:,?\s+tx)?$/i.test(query))return{body:[{name:'Irving, Texas, United States',lat:32.814,lng:-96.9489}]};try{const endpoint=new URL(process.env.PHOTON_URL||'https://photon.komoot.io/api/');endpoint.searchParams.set('q',query);endpoint.searchParams.set('limit','5');const body=await cached(endpoint.href,86400000,async()=>{const data=await upstream(endpoint);if(!Array.isArray(data.features))throw Error('Invalid geocoding response');return data.features.filter(f=>Array.isArray(f.geometry?.coordinates)&&f.geometry.coordinates.length>=2).map(f=>{const p=f.properties||{};return{name:[...new Set([p.name,[p.housenumber,p.street].filter(Boolean).join(' '),p.city,p.state,p.postcode,p.country].filter(Boolean))].join(', '),lng:f.geometry.coordinates[0],lat:f.geometry.coordinates[1]};});});return{body};}catch{return{status:503,body:{error:'Location search is temporarily unavailable. Use your GPS or enter latitude, longitude.'}};}}
