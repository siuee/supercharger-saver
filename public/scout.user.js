// ==UserScript==
// @name         Supercharger Saver Scout
// @namespace    https://supercharger-saver.vercel.app/
// @version      1.1.0
// @description  Free residential scout: when you browse Tesla.com, harvest public Supercharger schedules into Supercharger Saver's Neon DB (datacenter scrapers are blocked).
// @author       Supercharger Saver
// @match        https://www.tesla.com/*
// @match        https://tesla.com/*
// @connect      supercharger-saver.vercel.app
// @connect      www.tesla.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// ==/UserScript==

(function(){
 'use strict';
 const APP='https://supercharger-saver.vercel.app';
 const MAX_WANTED=8;
 const gm=typeof GM!=='undefined'?GM:null;

 function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

 function request(opts){
  return new Promise((resolve,reject)=>{
   const xhr=gm?.xmlHttpRequest||(typeof GM_xmlhttpRequest!=='undefined'?GM_xmlhttpRequest:null);
   if(xhr){
    xhr({
     method:opts.method||'GET',
     url:opts.url,
     headers:opts.headers||{},
     data:opts.data,
     onload:r=>{
      try{resolve({status:r.status,json:()=>JSON.parse(r.responseText),text:()=>r.responseText});}
      catch(e){reject(e);}
     },
     onerror:()=>reject(Error('network'))
    });
    return;
   }
   fetch(opts.url,{method:opts.method||'GET',headers:opts.headers,body:opts.data,mode:'cors'})
    .then(async r=>({status:r.status,json:()=>r.json(),text:()=>r.text()}))
    .then(resolve).catch(reject);
  });
 }

 async function postScout(items){
  const r=await request({
   method:'POST',
   url:APP+'/api/scout',
   headers:{'Content-Type':'application/json'},
   data:JSON.stringify({items})
  });
  const body=await r.json().catch(()=>({}));
  console.info('[Supercharger Saver Scout]', r.status, body);
  return body;
 }

 async function fetchDetail(id){
  const url=new URL('https://www.tesla.com/api/findus/get-charger-details');
  url.search=new URLSearchParams({
   locationSlug:id,
   programType:'supercharger',
   locale:'en-US',
   isInHkMoTw:'false'
  });
  const r=await fetch(url.toString(),{
   headers:{
    Accept:'application/json, text/plain, */*',
    'Accept-Language':'en-US,en;q=0.9'
   },
   credentials:'include'
  });
  if(!r.ok)throw Error('Tesla HTTP '+r.status);
  const json=await r.json();
  const detail=json?.data?.data;
  if(!detail?.name)throw Error('Missing detail');
  return detail;
 }

 async function contributeFromPage(){
  const node=document.getElementById('__NEXT_DATA__');
  if(!node)return;
  try{
   const page=JSON.parse(node.textContent).props?.pageProps;
   const detail=page?.formattedData?.chargerDetails;
   const id=page?.locationSlug;
   if(id&&detail?.name)await postScout([{id,detail}]);
  }catch(e){console.warn('[Supercharger Saver Scout] page parse', e);}
 }

 async function harvestWanted(){
  try{
   const r=await request({url:APP+'/api/scout?limit='+MAX_WANTED});
   if(r.status!==200)return;
   const body=await r.json();
   const ids=Array.isArray(body.ids)?body.ids:[];
   for(const id of ids.slice(0,MAX_WANTED)){
    try{
     const detail=await fetchDetail(id);
     await postScout([{id,detail}]);
    }catch(e){console.warn('[Supercharger Saver Scout] fail', id, e.message||e);}
    await sleep(1500+Math.floor(Math.random()*2000));
   }
  }catch(e){console.warn('[Supercharger Saver Scout] wanted', e);}
 }

 (async()=>{
  await sleep(1200);
  await contributeFromPage();
  await sleep(800);
  await harvestWanted();
 })();
})();
