import {stations,pricing,search,ingestDetails} from './service.js';
import {status,sync,listWatched,authorized} from './sync.js';
const routes={stations,pricing,search,status,sync};
function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{try{resolve(Buffer.concat(chunks).toString('utf8'));}catch(e){reject(e);}});req.on('error',reject);});}
export function createHandler(route){return async function handler(req,res){res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(route==='ingest'){
  if(req.method!=='POST'){res.setHeader('Allow','POST');res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed.'}));return;}
  if(!authorized(req.headers?.authorization)){res.statusCode=401;res.end(JSON.stringify({error:'Unauthorized'}));return;}
  try{
   const raw=await readBody(req);const parsed=raw?JSON.parse(raw):null;const items=Array.isArray(parsed)?parsed:parsed?.items;
   const result=await ingestDetails(items);res.statusCode=result.status||200;res.end(JSON.stringify(result.body));
  }catch{res.statusCode=400;res.end(JSON.stringify({error:'Invalid ingest payload.'}));}
  return;
 }
 if(req.method!=='GET'){res.setHeader('Allow','GET');res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed.'}));return;}
 if(route==='sync'&&!authorized(req.headers?.authorization)){res.statusCode=401;res.end(JSON.stringify({error:'Unauthorized'}));return;}
 try{
  const url=new URL(req.url,'https://supercharger-saver.invalid');
  if(route==='sync'&&url.searchParams.get('list')==='watched'){
   const result=await listWatched();res.statusCode=result.status||200;res.end(JSON.stringify(result.body));return;
  }
  const result=await routes[route](url.searchParams);res.statusCode=result.status||200;if(result.publicCache)res.setHeader('Vercel-CDN-Cache-Control','public, s-maxage='+result.publicCache);res.end(JSON.stringify(result.body));
 }catch{res.statusCode=503;res.end(JSON.stringify({error:'Service temporarily unavailable. Please retry.'}));}};}
