import {validateSchedule,parseTime} from '../public/logic.js';
export function parseTesla(html,updated=new Date().toISOString()){
 const match=html.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);if(!match)throw Error('Public station data unavailable');
 const page=JSON.parse(match[1]).props?.pageProps;const detail=page?.formattedData?.chargerDetails;return parseDetail(detail,page.locationSlug,updated);
}
export function parseDetail(detail,slug,updated=new Date().toISOString()){
 if(!detail?.timeZone)throw Error('Station timezone unavailable');new Intl.DateTimeFormat('en-US',{timeZone:detail.timeZone});
 const result={};const books=detail.effectivePricebooks||[];
 for(const type of ['member','public']){
  const rows=books.filter(x=>x.feeType==='CHARGING'&&x.uom?.toLowerCase()==='kwh'&&(type==='member'?x.vehicleMakeType==='TSLA':x.vehicleMakeType==='NTSLA'&&!x.isMemberPricebook));
  // Demand-dependent prices and multi-tier charging are not predictable daily schedules.
  if(!rows.length||rows.some(x=>x.days&&new Set(x.days.split(',').map(d=>d.trim())).size!==7)||rows.some(x=>x.minSiteOccupancy!=null||x.maxSiteOccupancy!=null||x.rateTier1>0||x.rateTier2>0))continue;
  const tou=rows.filter(x=>x.isTou);let schedule;
  if(tou.length){if(tou.some(x=>x.days&&x.days.split(',').length!==7))continue;schedule=tou.map(x=>({from:x.startTime,to:x.endTime==='00:00'?'24:00':x.endTime,rate:x.rateBase}));}
  else {const flat=rows.filter(x=>!x.isTou);if(flat.length!==1)continue;schedule=[{from:'00:00',to:'24:00',rate:flat[0].rateBase}];}
  if(schedule.some(w=>typeof w.rate!=='number'||!Number.isFinite(w.rate)))continue;
  try{validateSchedule(schedule);}catch{continue;}schedule.sort((a,b)=>parseTime(a.from)-parseTime(b.from));
  if(new Set(rows.map(x=>x.currencyCode)).size!==1)continue;
  result[type]={schedule,zone:detail.timeZone,currency:rows[0].currencyCode,source:'Tesla public schedule',updated,sourceUrl:'https://www.tesla.com/findus/location/supercharger/'+encodeURIComponent(slug||''),manual:false};
 }
 return result;
}
