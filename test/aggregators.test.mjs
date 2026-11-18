import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 parseUsdPerKwh,
 parseChargeAlongCost,
 syntheticSchedulePrices,
 matchCatalogStation,
 metersBetween,
 pricesNeedAggregatorFill,
 bookIsTeslaLive,
 fillStationFromAggregators,
 resolveAggregatorPrices,
 bulkFillFromAfdc,
 drainEmptyStationsWithAggregators,
 US_STATES
} from '../scraper/aggregators.mjs';
import {evaluate} from '../public/logic.js';

test('parses AFDC / OCM $/kWh strings into rates',()=>{
 assert.equal(parseUsdPerKwh('$0.51 per kWh'),.51);
 assert.equal(parseUsdPerKwh('$0.28/kWh'),.28);
 assert.equal(parseUsdPerKwh('$0.26 per kWh; other tariffs for older cars'),.26);
 assert.equal(parseUsdPerKwh('0.40 USD / kWh'),.4);
 assert.equal(parseUsdPerKwh('Free'),0);
 assert.equal(parseUsdPerKwh('Call for pricing'),null);
 assert.equal(parseUsdPerKwh(null),null);
});

test('parses ChargeAlong flat cost.per_kwh fields',()=>{
 assert.equal(parseChargeAlongCost({per_kwh_min:.26,per_kwh_max:.26,currency:'USD'}),.26);
 assert.equal(parseChargeAlongCost({per_kwh_min:.3,per_kwh_max:.4}),.3);
 assert.equal(parseChargeAlongCost({text:'$0.22 per kWh'}),.22);
 assert.equal(parseChargeAlongCost({kind:'unknown'}),null);
});

test('synthetic schedule is all-day member+public with via metadata',()=>{
 const prices=syntheticSchedulePrices({
  rate:.44,zone:'America/Chicago',via:'afdc',
  source:'AFDC approximate · $0.44 per kWh',updated:'2026-11-18T12:00:00.000Z'
 });
 assert.equal(prices.member.via,'afdc');
 assert.equal(prices.public.approximate,true);
 assert.equal(prices.member.schedule[0].rate,.44);
 assert.equal(evaluate(prices.member,new Date('2026-11-18T18:00:00Z')).current,.44);
 assert.throws(()=>syntheticSchedulePrices({rate:.2,via:'nope'}));
});

test('matches catalog stations by lat/lng proximity',()=>{
 const catalog=[
  {id:'near',name:'Irving Story Road',lat:32.8716,lng:-96.9946},
  {id:'far',name:'Dallas Far',lat:32.78,lng:-96.8}
 ];
 const hit=matchCatalogStation({name:'Irving Story',lat:32.8717,lng:-96.9947},catalog,{maxMeters:250});
 assert.equal(hit.station.id,'near');
 assert.ok(hit.meters<50);
 assert.equal(matchCatalogStation({lat:32.9,lng:-97.1},catalog,{maxMeters:250}),null);
 assert.ok(metersBetween({lat:0,lng:0},{lat:0,lng:0})===0);
});

test('pricesNeedAggregatorFill skips fresh Tesla books and allows empty/stale',()=>{
 const now=Date.parse('2026-11-18T12:00:00Z');
 const tesla={member:{schedule:[{from:'00:00',to:'24:00',rate:.2}],via:'actions-scraper',source:'Tesla public schedule'}};
 assert.equal(pricesNeedAggregatorFill(null,{now}),true);
 assert.equal(pricesNeedAggregatorFill({rawCurrent:{},prices:{}},{now}),true);
 assert.equal(pricesNeedAggregatorFill({rawCurrent:tesla,prices:tesla,fetchedAt:'2026-11-18T08:00:00Z'},{now}),false);
 assert.equal(pricesNeedAggregatorFill({rawCurrent:tesla,prices:tesla,fetchedAt:'2026-10-01T08:00:00Z'},{now}),true);
 const agg={member:{schedule:[{from:'00:00',to:'24:00',rate:.3}],via:'afdc',approximate:true}};
 assert.equal(bookIsTeslaLive(agg.member),false);
 assert.equal(bookIsTeslaLive(tesla.member),true);
 assert.equal(pricesNeedAggregatorFill({rawCurrent:agg,prices:agg,fetchedAt:'2026-11-18T08:00:00Z'},{now}),false);
 assert.equal(pricesNeedAggregatorFill({rawCurrent:agg,prices:agg,fetchedAt:'2026-10-01T08:00:00Z'},{now}),true);
});

test('scraper continues when Tesla blocked but aggregator fills',async()=>{
 const original=globalThis.fetch;
 const station={id:'GrapevineTXsupercharger',name:'Grapevine, TX',lat:32.941942,lng:-97.065861,address:'Grapevine, TX 76051'};
 let upserted=null;
 globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes('chargealong.io/v1/nearby')){
   return Response.json({data:{sites:[{
    public_id:'abc12345',name:'Grapevine Supercharger',network:'tesla',
    lat:32.94195,lng:-97.06585,cost_kind:'paid',address:'Grapevine TX'
   }]}});
  }
  if(u.includes('chargealong.io/v1/sites/')){
   return Response.json({data:{
    locality:{time_zone:'America/Chicago'},
    site:{
     public_id:'abc12345',name:'Grapevine Supercharger',lat:32.94195,lng:-97.06585,
     cost:{kind:'paid',currency:'USD',per_kwh_min:.37,per_kwh_max:.37,text:'$0.37/kWh'},
     path:'/en/united-states/texas/grapevine/tesla/x/'
    }
   }});
  }
  throw Error('unexpected '+u);
 };
 try{
  const fill=await fillStationFromAggregators(station,{
   existing:null,
   upsert:async(s,prices,updated)=>{upserted={id:s.id,prices,updated};}
  });
  assert.equal(fill.filled,true);
  assert.equal(fill.via,'chargealong');
  assert.equal(upserted.prices.member.schedule[0].rate,.37);
  assert.equal(upserted.prices.member.via,'chargealong');
 }finally{globalThis.fetch=original;}
});

test('resolveAggregatorPrices returns null when no published rate matches',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes('chargealong'))return Response.json({data:{sites:[]}});
  if(u.includes('alt-fuel-stations'))return Response.json({fuel_stations:[]});
  throw Error('unexpected '+u);
 };
 try{
  const prices=await resolveAggregatorPrices({id:'x',name:'Nowhere',lat:40,lng:-100,address:'Nowhere, ND'});
  assert.equal(prices,null);
 }finally{globalThis.fetch=original;}
});

test('status and UI copy do not require Tampermonkey or localhost',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
 const service=readFileSync(new URL('../lib/service.js',import.meta.url),'utf8');
 const scraper=readFileSync(new URL('../scraper/index.mjs',import.meta.url),'utf8');
 assert.match(app,/cloud|Neon|automatically/i);
 assert.doesNotMatch(app,/Install <a[^>]*Tampermonkey/i);
 assert.doesNotMatch(service,/Install the free browser scout/i);
 assert.match(readme,/No localhost \/ Tampermonkey dependency/i);
 assert.match(readme,/DATABASE_URL/i);
 assert.match(scraper,/aggregator|AFDC|chargealong/i);
 assert.match(scraper,/FULL SWEEP|full-sweep|SCRAPER_FULL_SWEEP/i);
 assert.doesNotMatch(scraper,/Install public\/scout\.user\.js \(Tampermonkey\)/i);
});

test('bulkFillFromAfdc fullSweep matches priced AFDC rows to entire catalog',async()=>{
 const original=globalThis.fetch;
 const catalog=[
  {id:'a',name:'Austin Domain',lat:30.401,lng:-97.725,address:'Austin, TX'},
  {id:'b',name:'No Price Match',lat:40.0,lng:-105.0,address:'Boulder, CO'}
 ];
 let upserts=0;
 globalThis.fetch=async url=>{
  const u=String(url);
  assert.match(u,/alt-fuel-stations/);
  return Response.json({fuel_stations:[
   {station_name:'Austin Domain Tesla',latitude:30.4011,longitude:-97.7251,state:'TX',
    street_address:'1 Domain',city:'Austin',zip:'78758',ev_pricing:'$0.42 per kWh',
    ev_network_web:'https://afdc.energy.gov/stations/'},
   {station_name:'Boulder no $',latitude:40.0001,longitude:-105.0001,state:'CO',
    street_address:'1 Pearl',city:'Boulder',zip:'80302',ev_pricing:'Call for pricing'}
  ]});
 };
 try{
  const report=await bulkFillFromAfdc(catalog,{
   fullSweep:true,
   upsert:async()=>{upserts++;}
  });
  assert.equal(report.mode,'full');
  assert.equal(report.filled,1);
  assert.equal(upserts,1);
  assert.ok(report.afdcPricedRows>=1);
 }finally{globalThis.fetch=original;}
});

test('drainEmptyStationsWithAggregators fills ChargeAlong matches and skips fresh rows',async()=>{
 const original=globalThis.fetch;
 const stations=[
  {id:'need',name:'Grapevine, TX',lat:32.941942,lng:-97.065861,address:'Grapevine, TX 76051'},
  {id:'fresh',name:'Already Priced',lat:33.0,lng:-97.0,address:'TX'}
 ];
 const freshBook={member:{schedule:[{from:'00:00',to:'24:00',rate:.2}],via:'afdc',approximate:true}};
 const existingById=new Map([
  ['fresh',{rawCurrent:freshBook,prices:freshBook,fetchedAt:new Date().toISOString()}]
 ]);
 let filledIds=[];
 globalThis.fetch=async url=>{
  const u=String(url);
  if(u.includes('chargealong.io/v1/nearby')){
   return Response.json({data:{sites:[{
    public_id:'abc12345',name:'Grapevine Supercharger',network:'tesla',
    lat:32.94195,lng:-97.06585,cost_kind:'paid',address:'Grapevine TX'
   }]}});
  }
  if(u.includes('chargealong.io/v1/sites/')){
   return Response.json({data:{
    locality:{time_zone:'America/Chicago'},
    site:{
     public_id:'abc12345',name:'Grapevine Supercharger',lat:32.94195,lng:-97.06585,
     cost:{kind:'paid',currency:'USD',per_kwh_min:.37,per_kwh_max:.37,text:'$0.37/kWh'},
     path:'/en/united-states/texas/grapevine/tesla/x/'
    }
   }});
  }
  if(u.includes('alt-fuel-stations'))return Response.json({fuel_stations:[]});
  throw Error('unexpected '+u);
 };
 try{
  const report=await drainEmptyStationsWithAggregators(stations,{
   existingById,
   concurrency:2,
   delayMs:0,
   upsert:async(s)=>{filledIds.push(s.id);}
  });
  assert.equal(report.filled,1);
  assert.equal(report.skipped,1);
  assert.deepEqual(filledIds,['need']);
  assert.equal(report.byVia.chargealong,1);
  assert.ok(US_STATES.includes('TX'));
 }finally{globalThis.fetch=original;}
});

test('workflow exposes full_sweep dispatch input',()=>{
 const yml=readFileSync(new URL('../.github/workflows/daily-price-scraper.yml',import.meta.url),'utf8');
 assert.match(yml,/full_sweep:/);
 assert.match(yml,/SCRAPER_FULL_SWEEP/);
 assert.match(yml,/timeout-minutes:/);
});
