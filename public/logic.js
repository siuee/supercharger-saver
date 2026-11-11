export function distance(a,b){const r=Math.PI/180;const dlat=(b.lat-a.lat)*r,dlng=(b.lng-a.lng)*r;return 3958.7613*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlng/2)**2)));}
const formatters=new Map();
export function minuteAt(date,zone){if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));const p=formatters.get(zone).formatToParts(date);return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);}
export function parseTime(t){if(!/^\d\d:\d\d$/.test(t))return NaN;const [h,m]=t.split(':').map(Number);return h<=24&&m<60&&(h!==24||m===0)?h*60+m:NaN;}
export function validateSchedule(rows){if(!rows.length)throw Error('Add at least one price window.');const slots=new Uint8Array(1440);for(const w of rows){const a=parseTime(w.from),b=parseTime(w.to);if(!Number.isFinite(a)||!Number.isFinite(b)||a===1440||a===b||!Number.isFinite(w.rate)||w.rate<0||w.rate>10)throw Error('Use valid times and prices between 0 and 10 per kWh. Use 24:00 for the end of the day.');for(let m=0;m<1440;m++){if(a<b?m>=a&&m<b:m>=a||m<b)slots[m]++;}}if(slots.some(n=>n!==1))throw Error('Windows must cover all 24 hours without gaps or overlaps.');return rows;}
export function rateAt(schedule,m){return schedule.find(w=>{const a=parseTime(w.from),b=parseTime(w.to);return a<b?m>=a&&m<b:m>=a||m<b})?.rate??null;}
export function evaluate(pricing,now=new Date(),hours=24){if(!pricing?.schedule?.length||!pricing.zone)return null;try{validateSchedule(pricing.schedule);const current=rateAt(pricing.schedule,minuteAt(now,pricing.zone));let low=Infinity,start=null;const points=[];for(let i=0;i<hours*60;i++){const t=new Date(now.getTime()+i*60000);const rate=rateAt(pricing.schedule,minuteAt(t,pricing.zone));if(rate!==null&&rate<low){low=rate;start=t;}if(i%60===0)points.push(rate);}return{current,low:Number.isFinite(low)?low:null,start,points};}catch{return null;}}

// Rank the earliest occurrence of each station's minimum daily rate.
// Compare whole minutes so evaluation timing cannot break equal-time price ties.
export function compareEarliest(a,b){
 if(!a.e||!b.e)return (a.e?-1:b.e?1:0)||(a.d-b.d);
 if(a.p.currency!==b.p.currency)return a.p.currency.localeCompare(b.p.currency);
 return Math.floor(a.e.start.getTime()/60000)-Math.floor(b.e.start.getTime()/60000)||a.e.low-b.e.low||a.d-b.d;
}
