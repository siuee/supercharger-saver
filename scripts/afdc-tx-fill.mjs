#!/usr/bin/env node
/**
 * Immediate TX-focused AFDC upsert for empty catalog stations (e.g. Arlington E Lamar 489356).
 * Loads .env.local DATABASE_URL and writes AFDC flat rates into Neon.
 */
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const rootUrl=pathToFileURL(root+'/').href;

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
}catch{/* CI may inject secrets */}

if(!process.env.DATABASE_URL&&!process.env.POSTGRES_URL){
 console.error('DATABASE_URL required');
 process.exit(1);
}

const {ensureSchema,upsertStationSuccess,getStationPrice,countPricedStations}=await import(new URL('lib/db.js',rootUrl));
const {normalizeFallbackCatalog}=await import(new URL('lib/service.js',rootUrl));
const {bulkFillFromAfdc,US_STATES}=await import(new URL('scraper/aggregators.mjs',rootUrl));

const FALLBACK_CATALOG_URL='https://supercharge.info/service/supercharge/allSites';

async function loadCatalog(){
 const r=await fetch(FALLBACK_CATALOG_URL,{
  headers:{Accept:'application/json','User-Agent':'SuperchargerSaver-afdc-tx/1.0'},
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

await ensureSchema();
const catalog=await loadCatalog();
const before=await countPricedStations().catch(()=>0);
const txIdx=US_STATES.indexOf('TX');
const report=await bulkFillFromAfdc(catalog,{
 statesPerRun:1,
 maxUpserts:500,
 startStateIndex:txIdx>=0?txIdx:0,
 getExisting:async id=>getStationPrice(id).catch(()=>null),
 upsert:async(station,prices,updated,row)=>{
  await upsertStationSuccess(station,{
   prices,
   fetchedAt:updated,
   meta:{
    name:row?.name||station.name,
    lat:station.lat,
    lng:station.lng,
    address:row?.address||station.address,
    country:station.country,
    power:station.power,
    stalls:station.stalls
   }
  });
 }
});
const after=await countPricedStations().catch(()=>before);
const checkIds=['489356','32090','arlingtonsupercharger','DallasTXCentralQ322','19035','45384'];
const checks={};
for(const id of checkIds){
 const row=await getStationPrice(id).catch(()=>null);
 const book=row?.prices?.member||row?.rawCurrent?.member;
 checks[id]={
  priced:!!(book&&Object.keys(row?.rawCurrent||row?.prices||{}).length),
  rate:book?.schedule?.[0]?.rate??null,
  via:book?.via||null
 };
}
console.log(JSON.stringify({before,after,report,checks},null,2));
