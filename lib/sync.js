import {randomUUID,timingSafeEqual} from 'node:crypto';
import {configured,redis,read,write} from './store.js';
import {dbConfigured,countPricedStations,getLastScraperRun,ensureSchema} from './db.js';
import {getCatalog,fetchStation} from './service.js';

/** Prefer freshness under 20h for optional admin Redis sync. */
const STALE_MS=20*3600000;

/** Reject short operator secrets so offline brute-force of sync/ingest is impractical. */
const MIN_SECRET_LEN=24;
export function authorized(header){
 const secret=process.env.CRON_SECRET;
 if(!secret||secret.length<MIN_SECRET_LEN)return false;
 const a=Buffer.from(header||''),b=Buffer.from('Bearer '+secret);
 return a.length===b.length&&timingSafeEqual(a,b);
}
function dailyLimit(){
 const n=Number(process.env.SYNC_DAILY_LIMIT);
 return Number.isFinite(n)&&n>=1?Math.min(Math.floor(n),20):1;
}
function secretConfigured(){
 const secret=process.env.CRON_SECRET;
 return !!(secret&&secret.length>=MIN_SECRET_LEN);
}
export async function listWatched(){
 if(!configured())return{status:503,body:{error:'Redis is not configured.'}};
 await redis(['ZREMRANGEBYSCORE','scs:watched','-inf',Date.now()-30*86400000]);
 const ids=await redis(['ZRANGE','scs:watched',0,-1]);
 let priced=0;
 try{priced=dbConfigured()?await countPricedStations():Number(await redis(['SCARD','scs:priced-ids']))||0;}catch{priced=0;}
 return{body:{ids:ids||[],watched:ids?.length||0,priced,dailyLimit:dailyLimit()}};
}
export async function status(){
 if(!dbConfigured()&&(!configured()||!secretConfigured())){
  return{body:{configured:false,message:'Price database is not configured yet. Station locations still work; rates appear after Neon + the daily GitHub Actions scraper are set up.'}};
 }
 try{
  if(dbConfigured())await ensureSchema().catch(()=>{});
  let lastRun=null;
  try{lastRun=dbConfigured()?await getLastScraperRun():await read('last-sync');}catch{lastRun=null;}
  let priced=0;
  try{priced=dbConfigured()?await countPricedStations():Number(await redis(['SCARD','scs:priced-ids']))||0;}catch{priced=0;}
  let message;
  if(!lastRun)message='Neon price database is ready. The first GitHub Actions scraper run has not finished yet — locations work for every visitor; rates fill as the daily batch covers the catalog.';
  else{
   const finished=lastRun.finishedAt||lastRun.finished_at;
   const overdue=finished&&Date.now()-Date.parse(finished)>172800000;
   const succeeded=lastRun.succeeded??0;
   const failed=lastRun.failed??0;
   const pending=lastRun.pending??0;
   message=(overdue?'Price refresh overdue. Last finished ':'Price database last refreshed ')+finished+' · '+succeeded+' updated · '+failed+' unavailable'+(pending?' · '+pending+' deferred':'')+' · '+priced+' stations priced for all users.';
   if(lastRun.error)message+=' Catalog refresh had issues; nearby stations may use the fallback source.';
  }
  return{body:{configured:true,message}};
 }
 catch{return{body:{configured:false,message:'Shared storage is temporarily unavailable. Searches still work for locations.'}};}
}

async function pickStaleQueue(ids,byId,limit){
 const queue=[];
 const ordered=[...ids].reverse();
 let cursor=Number(await redis(['GET','scs:sync-cursor']));
 if(!Number.isFinite(cursor)||cursor<0)cursor=0;
 const rotated=ordered.slice(cursor).concat(ordered.slice(0,cursor));
 for(const id of rotated){
  if(queue.length>=limit)break;
  const station=byId.get(id);if(!station)continue;
  const saved=await read('station:'+id).catch(()=>null);
  const age=saved?.updated?Date.now()-Date.parse(saved.updated):Infinity;
  const priced=saved?.prices&&Object.keys(saved.prices).length>0;
  if(priced&&age<STALE_MS)continue;
  queue.push(station);
 }
 const nextCursor=ordered.length?(cursor+Math.max(queue.length,1))%ordered.length:0;
 await redis(['SET','scs:sync-cursor',String(nextCursor)]);
 if(!queue.length&&ordered.length){
  for(let i=0;i<ordered.length&&queue.length<limit;i++){
   const s=byId.get(ordered[(cursor+i)%ordered.length]);
   if(s)queue.push(s);
  }
 }
 return queue;
}

/**
 * Optional admin sync (auth-gated). Preferred path is the GitHub Actions scraper → Neon.
 * No Scrapfly/proxy required — fetches Tesla directly when the host allows it.
 */
export async function sync(){
 if(!configured()&&!dbConfigured())return{status:503,body:{error:'Configure DATABASE_URL (Neon) or Redis before enabling admin sync.'}};
 if(configured()){
  const token=randomUUID();
  if(!await redis(['SET','scs:sync-lock',token,'NX','EX',300]))return{status:409,body:{error:'A sync is already running.'}};
  const limit=dailyLimit();
  const started=Date.now(),report={startedAt:new Date().toISOString(),succeeded:0,failed:0,pending:0,limit,mode:'admin'};
  try{
   const catalog=await getCatalog(true);
   await redis(['ZREMRANGEBYSCORE','scs:watched','-inf',Date.now()-30*86400000]);
   const ids=await redis(['ZRANGE','scs:watched',0,-1])||[];
   const byId=new Map(catalog.stations.map(s=>[s.id,s]));
   const queue=await pickStaleQueue(ids,byId,limit);
   for(const s of queue){
    if(Date.now()-started>=280000){report.pending=queue.length-report.succeeded-report.failed;break;}
    try{await fetchStation(s,true);report.succeeded++;}
    catch{report.failed++;}
   }
   report.pending=Math.max(0,ids.length-report.succeeded-report.failed);
   report.complete=report.failed===0&&(queue.length===0||report.succeeded===queue.length);
   if(!ids.length){report.complete=true;report.pending=0;}
  }catch{report.complete=false;report.error='Could not complete official catalog or admin price refresh.';}
  finally{report.finishedAt=new Date().toISOString();await write('last-sync',report);await redis(['EVAL',"if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,'scs:sync-lock',token]);}
  return{status:report.complete?200:503,body:report};
 }
 return{status:200,body:{complete:true,mode:'neon-only',message:'Use the GitHub Actions daily-price-scraper workflow to refresh Neon prices. Admin Redis sync is not configured.'}};
}
