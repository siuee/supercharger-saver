import {parseDetail} from './tesla.js';
import {dbConfigured,sql,upsertStationSuccess} from './db.js';

const validId=id=>/^[a-zA-Z0-9_-]{1,150}$/.test(id);
const hits=new Map(); // ip -> {count, reset}

function clientIp(req){
 const xf=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
 return xf||req.headers?.['x-real-ip']||'unknown';
}

export function rateLimitOk(req,max=40){
 const ip=clientIp(req);
 const now=Date.now();
 const row=hits.get(ip);
 if(!row||now>row.reset){hits.set(ip,{count:1,reset:now+3600000});return true;}
 if(row.count>=max)return false;
 row.count++;
 return true;
}

export function corsHeaders(req){
 const origin=String(req.headers?.origin||'');
 const allow=/^https:\/\/([a-z0-9-]+\.)*tesla\.com$/i.test(origin)||origin==='https://supercharger-saver.vercel.app'||!origin;
 return{
  'Access-Control-Allow-Origin':allow?(origin||'*'):'https://www.tesla.com',
  'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
  'Access-Control-Max-Age':'86400',
  'Vary':'Origin'
 };
}

/** Record nearby stations that still need prices (called from /api/stations). */
export async function markWanted(stations=[]){
 if(!dbConfigured()||!stations.length)return;
 const q=sql();
 for(const s of stations.slice(0,40)){
  const id=String(s.id||'');
  if(!validId(id))continue;
  await q`
   INSERT INTO scout_wanted (station_id,hits,lat,lng,updated_at)
   VALUES (${id},1,${s.lat??null},${s.lng??null},NOW())
   ON CONFLICT (station_id) DO UPDATE SET
     hits=scout_wanted.hits+1,
     lat=COALESCE(EXCLUDED.lat,scout_wanted.lat),
     lng=COALESCE(EXCLUDED.lng,scout_wanted.lng),
     updated_at=NOW()
  `.catch(()=>{});
 }
}

/** Clear wanted entry after a successful price save. */
export async function clearWanted(stationId){
 if(!dbConfigured())return;
 const q=sql();
 await q`DELETE FROM scout_wanted WHERE station_id=${String(stationId)}`.catch(()=>{});
}

/**
 * Stations scouts should harvest from a real browser (Tesla same-origin fetch works there).
 * Prefer high-hit wanted rows that still lack usable prices.
 */
export async function listWanted(limit=12){
 if(!dbConfigured())return{body:{ids:[],stations:[]}};
 const q=sql();
 const n=Math.max(1,Math.min(Number(limit)||12,25));
 const rows=await q`
  SELECT w.station_id,w.hits,w.lat,w.lng
  FROM scout_wanted w
  LEFT JOIN station_prices p ON p.station_id=w.station_id
  WHERE p.station_id IS NULL
     OR ((p.prices = '{}'::jsonb OR p.prices IS NULL)
         AND (p.previous_prices IS NULL OR p.previous_prices = '{}'::jsonb))
  ORDER BY w.hits DESC, w.updated_at DESC
  LIMIT ${n}
 `;
 return{
  body:{
   ids:rows.map(r=>r.station_id),
   stations:rows.map(r=>({id:r.station_id,lat:r.lat,lng:r.lng,hits:r.hits})),
   hint:'Fetch each id from https://www.tesla.com/api/findus/get-charger-details in the browser, then POST {id,detail} to /api/scout'
  }
 };
}

export async function acceptScoutItems(items){
 if(!dbConfigured())return{status:503,body:{error:'Price database is not configured.'}};
 if(!Array.isArray(items)||!items.length||items.length>25){
  return{status:400,body:{error:'Send 1–25 scout items.'}};
 }
 const saved=[],failed=[];
 for(const item of items){
  const id=String(item?.id||item?.locationSlug||'');
  const detail=item?.detail||item?.data?.data||item;
  if(!validId(id)){failed.push({id,error:'Invalid id'});continue;}
  try{
   const updated=new Date().toISOString();
   const prices=parseDetail(detail,id,updated);
   if(!prices||!Object.keys(prices).length){
    failed.push({id,error:'No comparable daily schedule'});
    continue;
   }
   // Stamp source so UI can tell residential scout from demo seeds.
   for(const book of Object.values(prices)){
    book.source=book.source||'Tesla public schedule';
    book.via='browser-scout';
    book.updated=updated;
   }
   const a=detail.address||{};
   const meta={
    name:detail.name,
    address:[a.streetNumber,a.street,a.city,a.state,a.postalCode].filter(Boolean).join(' '),
    country:a.country,
    power:detail.maxPowerKw,
    stalls:detail.publicStallCount
   };
   const result=await upsertStationSuccess({id},{prices,fetchedAt:updated,meta});
   await clearWanted(id);
   saved.push({id,priced:result.priced});
  }catch(e){failed.push({id,error:String(e.message||e).slice(0,200)});}
 }
 return{body:{saved:saved.length,failed:failed.length,stations:saved,errors:failed,mode:'browser-scout'}};
}

export async function scoutStatus(){
 if(!dbConfigured())return{body:{configured:false,wanted:0,priced:0}};
 const q=sql();
 const wanted=await q`SELECT COUNT(*)::int AS n FROM scout_wanted`;
 const pricedRows=await q`SELECT COUNT(*)::int AS n FROM station_prices WHERE prices <> '{}'::jsonb OR (previous_prices IS NOT NULL AND previous_prices <> '{}'::jsonb)`;
 return{body:{configured:true,wanted:wanted[0]?.n||0,priced:pricedRows[0]?.n||0}};
}
