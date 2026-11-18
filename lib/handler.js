import {stations,pricing,search,ingestDetails} from './service.js';
import {status,sync,listWatched,authorized} from './sync.js';
import {acceptScoutItems,listWanted,rateLimitOk,corsHeaders,scoutStatus} from './scout.js';

const routes={stations,pricing,search,status,sync};
const MAX_BODY_BYTES=262144;

function readBody(req,limit=MAX_BODY_BYTES){
 return new Promise((resolve,reject)=>{
  const chunks=[];
  let size=0;
  req.on('data',c=>{
   size+=c.length;
   if(size>limit){
    reject(Object.assign(new Error('Payload too large'),{code:'PAYLOAD_TOO_LARGE'}));
    try{req.destroy();}catch{}
    return;
   }
   chunks.push(c);
  });
  req.on('end',()=>{try{resolve(Buffer.concat(chunks).toString('utf8'));}catch(e){reject(e);}});
  req.on('error',reject);
 });
}

function applyCors(req,res){
 const headers=corsHeaders(req);
 for(const [k,v] of Object.entries(headers))res.setHeader(k,v);
}

export function createHandler(route){return async function handler(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');

 if(route==='scout'){
  applyCors(req,res);
  if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
  if(req.method==='GET'){
   try{
    const url=new URL(req.url,'https://supercharger-saver.invalid');
    if(url.searchParams.get('status')==='1'){
     const result=await scoutStatus();
     res.statusCode=200;res.end(JSON.stringify(result.body));return;
    }
    const result=await listWanted(url.searchParams.get('limit'));
    res.statusCode=200;res.end(JSON.stringify(result.body));
   }catch{res.statusCode=503;res.end(JSON.stringify({error:'Scout queue unavailable.'}));}
   return;
  }
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST, OPTIONS');res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed.'}));return;}
  if(!rateLimitOk(req)){res.statusCode=429;res.end(JSON.stringify({error:'Too many scout submissions from this network. Try again later.'}));return;}
  try{
   const raw=await readBody(req);
   const parsed=raw?JSON.parse(raw):null;
   const items=Array.isArray(parsed)?parsed:parsed?.items?parsed.items:[parsed].filter(Boolean);
   const result=await acceptScoutItems(items);
   res.statusCode=result.status||200;
   res.end(JSON.stringify(result.body));
  }catch(e){
   if(e?.code==='PAYLOAD_TOO_LARGE'){res.statusCode=413;res.end(JSON.stringify({error:'Scout payload exceeds 256 KiB.'}));return;}
   res.statusCode=400;res.end(JSON.stringify({error:'Invalid scout payload.'}));
  }
  return;
 }

 if(route==='ingest'){
  if(req.method!=='POST'){res.setHeader('Allow','POST');res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed.'}));return;}
  if(!authorized(req.headers?.authorization)){res.statusCode=401;res.end(JSON.stringify({error:'Unauthorized'}));return;}
  try{
   const raw=await readBody(req);
   const parsed=raw?JSON.parse(raw):null;
   const items=Array.isArray(parsed)?parsed:parsed?.items;
   const result=await ingestDetails(items);
   res.statusCode=result.status||200;
   res.end(JSON.stringify(result.body));
  }catch(e){
   if(e?.code==='PAYLOAD_TOO_LARGE'){res.statusCode=413;res.end(JSON.stringify({error:'Ingest payload exceeds 256 KiB.'}));return;}
   res.statusCode=400;res.end(JSON.stringify({error:'Invalid ingest payload.'}));
  }
  return;
 }

 if(req.method!=='GET'){res.setHeader('Allow','GET');res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed.'}));return;}
 if(route==='sync'&&!authorized(req.headers?.authorization)){res.statusCode=401;res.end(JSON.stringify({error:'Unauthorized'}));return;}
 try{
  const url=new URL(req.url,'https://supercharger-saver.invalid');
  if(route==='sync'&&url.searchParams.get('list')==='watched'){
   const result=await listWatched();
   res.statusCode=result.status||200;
   res.end(JSON.stringify(result.body));
   return;
  }
  const result=await routes[route](url.searchParams);
  res.statusCode=result.status||200;
  if(result.publicCache)res.setHeader('Vercel-CDN-Cache-Control','public, s-maxage='+result.publicCache);
  res.end(JSON.stringify(result.body));
 }catch{res.statusCode=503;res.end(JSON.stringify({error:'Service temporarily unavailable. Please retry.'}));}
};}
