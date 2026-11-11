import {randomUUID,timingSafeEqual} from 'node:crypto';
import {configured,redis,read,write} from './store.js';
import {getCatalog,fetchStation} from './service.js';

/** Prefer freshness under 20h so free Scrapfly (~40 ASP calls/month) is not wasted. */
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
 // Default 1/day ≈ 30 Scrapfly ASP calls/month on free tier (asp≈25 credits).
 const n=Number(process.env.SYNC_DAILY_LIMIT);
 return Number.isFinite(n)&&n>=1?Math.min(Math.floor(n),20):1;
}
function proxyReady(){return !!(process.env.SCRAPFLY_KEY||process.env.SCRAPERAPI_KEY||process.env.TESLA_PROXY_URL);}
function secretConfigured(){
 const secret=process.env.CRON_SECRET;
 return !!(secret&&secret.length>=MIN_SECRET_LEN);
}
export async function listWatched(){
 if(!configured())return{status:503,body:{error:'Redis is not configured.'}};
 await redis(['ZREMRANGEBYSCORE','scs:watched','-inf',Date.now()-30*86400000]);
 const ids=await redis(['ZRANGE','scs:watched',0,-1]);
 let priced=0;
 try{priced=Number(await redis(['SCARD','scs:priced-ids']))||0;}catch{priced=0;}
 // Auth-gated via /api/sync — IDs are for operator scripts (daily-sync), not public status.
 return{body:{ids:ids||[],watched:ids?.length||0,priced,dailyLimit:dailyLimit()}};
}
export async function status(){
 if(!configured()||!secretConfigured())return{body:{configured:false,message:'Shared cloud price cache is not configured yet. Station locations still work; rates appear after Vercel Redis + daily cron are set up.'}};
 try{
  const lastRun=await read('last-sync');
  let priced=0;
  try{priced=Number(await redis(['SCARD','scs:priced-ids']))||0;}catch{priced=0;}
  let message;
  if(!lastRun)message='Cloud daily price sync is ready. The first Vercel cron has not run yet — locations work for every visitor; rates fill as the cloud job refreshes watched stations.';
  else{
   const overdue=Date.now()-Date.parse(lastRun.finishedAt)>172800000;
   message=(overdue?'Cloud price refresh overdue. Last finished ':'Cloud price cache last refreshed ')+lastRun.finishedAt+' · '+lastRun.succeeded+' updated · '+lastRun.failed+' unavailable · '+lastRun.pending+' deferred · '+priced+' stations priced for all users.';
   if(lastRun.error)message+=' Catalog refresh had issues; nearby stations may use the fallback source.';
   else if(!proxyReady()&&lastRun.failed>0&&lastRun.succeeded===0)message+=' Cloud Tesla refresh needs a configured proxy in Vercel env so the daily cron can update rates.';
  }
  // Public status stays high-level: no lastRun object, proxy flags, or limit numbers for recon.
  return{body:{configured:true,message}};
 }
 catch{return{body:{configured:false,message:'Shared storage is temporarily unavailable. Searches still work for locations.'}};}
}

async function pickStaleQueue(ids,byId,limit){
 const queue=[];
 // Hottest searches first (shared demand from every concurrent user).
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
  if(priced&&age<STALE_MS)continue; // keep free Scrapfly budget for stale/missing
  queue.push(station);
 }
 const nextCursor=ordered.length?(cursor+Math.max(queue.length,1))%ordered.length:0;
 await redis(['SET','scs:sync-cursor',String(nextCursor)]);
 // If everything is fresh, still rotate one station so schedules do not rot forever.
 if(!queue.length&&ordered.length){
  for(let i=0;i<ordered.length&&queue.length<limit;i++){
   const s=byId.get(ordered[(cursor+i)%ordered.length]);
   if(s)queue.push(s);
  }
 }
 return queue;
}

export async function sync(){
 if(!configured())return{status:503,body:{error:'Configure Upstash Redis before enabling daily sync.'}};
 if(!proxyReady())return{status:503,body:{error:'Set SCRAPFLY_KEY (or SCRAPERAPI_KEY / TESLA_PROXY_URL) on Vercel so cloud sync can reach Tesla.'}};
 const token=randomUUID();if(!await redis(['SET','scs:sync-lock',token,'NX','EX',300]))return{status:409,body:{error:'A sync is already running.'}};
 const limit=dailyLimit();
 const started=Date.now(),report={startedAt:new Date().toISOString(),succeeded:0,failed:0,pending:0,limit,mode:'cloud'};
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
 }catch{report.complete=false;report.error='Could not complete official catalog or cloud price refresh.';}
 finally{report.finishedAt=new Date().toISOString();await write('last-sync',report);await redis(['EVAL',"if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,'scs:sync-lock',token]);}
 return{status:report.complete?200:503,body:report};
}
