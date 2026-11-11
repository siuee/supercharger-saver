import {randomUUID,timingSafeEqual} from 'node:crypto';
import {configured,redis,read,write} from './store.js';
import {getCatalog,fetchStation} from './service.js';
export function authorized(header){const secret=process.env.CRON_SECRET;if(!secret)return false;const a=Buffer.from(header||''),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);}
export async function status(){
 if(!configured()||!process.env.CRON_SECRET)return{body:{configured:false,message:'Daily sync needs Vercel setup. Search-time price checks are available.'}};
 try{const lastRun=await read('last-sync');return{body:{configured:true,lastRun,message:lastRun?(Date.now()-Date.parse(lastRun.finishedAt)>172800000?'Daily sync overdue. Last finished ':'Daily sync last finished ')+lastRun.finishedAt+' · '+lastRun.succeeded+' checked · '+lastRun.failed+' failed · '+lastRun.pending+' pending.':'Daily sync configured; awaiting its first run.'}};}
 catch{return{body:{configured:false,message:'Daily sync storage is unavailable. Search-time checks remain available.'}};}
}
export async function sync(){
 if(!configured())return{status:503,body:{error:'Configure Upstash Redis before enabling daily sync.'}};
 const token=randomUUID();if(!await redis(['SET','scs:sync-lock',token,'NX','EX',300]))return{status:409,body:{error:'A sync is already running.'}};
 const started=Date.now(),report={startedAt:new Date().toISOString(),succeeded:0,failed:0,pending:0};
 try{
 const catalog=await getCatalog(true);
 await redis(['ZREMRANGEBYSCORE','scs:watched','-inf',Date.now()-30*86400000]);
 const ids=await redis(['ZRANGE','scs:watched',0,-1]);
 const byId=new Map(catalog.stations.map(s=>[s.id,s])),queue=ids.map(id=>byId.get(id)).filter(Boolean);
 let next=0;
 async function worker(){while(next<queue.length&&Date.now()-started<220000){const s=queue[next++];try{await fetchStation(s,true);report.succeeded++;}catch{report.failed++;}}}
 await Promise.all([worker(),worker(),worker()]);report.pending=queue.length-next;
 report.complete=report.failed===0&&report.pending===0;
 }catch{report.complete=false;report.error='Could not complete official catalog or storage refresh.';}
 finally{report.finishedAt=new Date().toISOString();await write('last-sync',report);await redis(['EVAL',"if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,'scs:sync-lock',token]);}
 return{status:report.complete?200:503,body:report};
}
