import {readFileSync} from 'node:fs';
try{
 for(const line of readFileSync('.env.local','utf8').split(/\r?\n/)){
  if(!line||line.startsWith('#')||!line.includes('='))continue;
  const i=line.indexOf('=');
  const k=line.slice(0,i).trim();
  let v=line.slice(i+1).trim();
  if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
  if(!(k in process.env))process.env[k]=v;
 }
}catch{}
const {stations}=await import('../lib/service.js');
const r=await stations(new URLSearchParams('lat=32.814&lng=-96.9489&radius=25'));
const priced=r.body.stations.filter(s=>s.prices&&Object.keys(s.prices).length);
console.log(JSON.stringify({
 priced:r.body.priced,
 total:r.body.total,
 message:r.body.pricingMessage,
 sample:priced.slice(0,5).map(s=>({id:s.id,freshness:s.freshness,name:s.name}))
},null,2));
