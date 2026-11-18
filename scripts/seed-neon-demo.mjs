#!/usr/bin/env node
/** Seed a few Irving-area stations into Neon for deploy verification (uses fixture schedules). */
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
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
}catch{}

const {ensureSchema,upsertStationSuccess,getStationPrices,sql}=await import(new URL('lib/db.js',rootUrl));
const {parseDetail}=await import(new URL('lib/tesla.js',rootUrl));
const fixture=JSON.parse(readFileSync(join(root,'test/tesla-fixture.json'),'utf8'));

const seeds=[
 {id:'45386',name:'Irving, TX - Story Rd',lat:32.835,lng:-96.955,address:'Story Rd, Irving, TX'},
 {id:'32616',name:'Irving, TX Supercharger',lat:32.87,lng:-96.94,address:'Irving, TX'},
 {id:'2204',name:'Dallas area Supercharger',lat:32.82,lng:-96.95,address:'Dallas, TX'}
];

await ensureSchema();
const updated=new Date().toISOString();
const prices=parseDetail({...fixture,name:'Seed station'},'seed',updated);

for(const s of seeds){
 const result=await upsertStationSuccess(s,{prices,fetchedAt:updated,meta:s});
 console.log('seeded',s.id,result);
}

// Also write a previous-only row to exercise freshness=previous
const older=new Date(Date.now()-2*86400000).toISOString();
const olderPrices=parseDetail({...fixture,name:'Previous only'},'prev',older);
await upsertStationSuccess(
 {id:'prev-demo',name:'Previous-record demo',lat:32.81,lng:-96.95,address:'Irving demo'},
 {prices:olderPrices,fetchedAt:older,meta:{name:'Previous-record demo',address:'Irving demo',lat:32.81,lng:-96.95}}
);
// Clear current prices while keeping previous via direct SQL path: simulate failed scrape after success
const q=sql();
await q`
 UPDATE station_prices
 SET previous_prices=prices, previous_fetched_at=fetched_at, prices='{}'::jsonb, fetched_at=NULL, last_error='demo previous'
 WHERE station_id='prev-demo'
`;

const map=await getStationPrices(seeds.map(s=>s.id).concat(['prev-demo']));
for(const [id,row] of map){
 console.log(id,'freshness=',row.freshness,'priced=',Object.keys(row.prices||{}).length>0);
}
