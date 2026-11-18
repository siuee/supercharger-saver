#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {neon} from '@neondatabase/serverless';

function loadEnvLocal(){
 try{
  const raw=readFileSync(new URL('../.env.local',import.meta.url),'utf8');
  for(const line of raw.split(/\r?\n/)){
   if(!line||line.startsWith('#')||!line.includes('='))continue;
   const i=line.indexOf('=');
   const key=line.slice(0,i).trim();
   let val=line.slice(i+1).trim();
   if((val.startsWith('"')&&val.endsWith('"'))||(val.startsWith("'")&&val.endsWith("'")))val=val.slice(1,-1);
   if(!(key in process.env))process.env[key]=val;
  }
 }catch{/* optional */}
}

loadEnvLocal();
const url=process.env.DATABASE_URL||process.env.POSTGRES_URL;
if(!url){
 console.error('DATABASE_URL required');
 process.exit(1);
}

const sql=neon(url);
const schema=readFileSync(new URL('../lib/schema.sql',import.meta.url),'utf8');
const statements=schema
 .split(/;\s*(?:\r?\n|$)/)
 .map(s=>s.replace(/--[^\n]*/g,'').trim())
 .filter(Boolean);

for(const statement of statements){
 await sql.query(statement);
 console.log('applied:', statement.slice(0,72).replace(/\s+/g,' '));
}

const tables=await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`;
console.log('tables:', tables.map(t=>t.table_name).join(', '));
