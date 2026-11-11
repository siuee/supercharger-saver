export const configured=()=>!!(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN);
/** Shared station price TTL (7 days). Concurrent users read the same keys. */
export const STATION_TTL=604800;
export async function redis(command){
 if(!configured())throw Error('Daily sync storage is not configured');
 const url=new URL(process.env.UPSTASH_REDIS_REST_URL);if(url.protocol!=='https:')throw Error('Redis requires HTTPS');
 const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('Sync storage unavailable');const data=await response.json();if(data.error)throw Error('Sync storage command failed');return data.result;
}
export async function read(key){if(!configured())return null;const value=await redis(['GET','scs:'+key]);return value?JSON.parse(value):null;}
export async function readMany(keys){
 if(!configured()||!keys.length)return keys.map(()=>null);
 const values=await redis(['MGET',...keys.map(k=>'scs:'+k)]);
 return (values||[]).map(v=>v?JSON.parse(v):null);
}
export async function write(key,value,ttl=STATION_TTL){return redis(['SET','scs:'+key,JSON.stringify(value),'EX',ttl]);}
export async function markPriced(id,hasPrices){
 if(!configured())return;
 if(hasPrices)await redis(['SADD','scs:priced-ids',id]);
 else await redis(['SREM','scs:priced-ids',id]);
}
