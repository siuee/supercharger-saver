import {readFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
for(const path of ['public/app.js','public/logic.js','lib/service.js','lib/tesla.js','lib/handler.js','lib/store.js','lib/sync.js','api/status.js','api/sync.js','api/stations.js','api/pricing.js','api/search.js'])execFileSync(process.execPath,['--check',path]);
const page=await readFile('public/index.html','utf8');assert.ok(page.includes('Supercharger Saver'));assert.ok(page.includes('data-sort="earliest"'));assert.ok(!page.includes('ChargeWindow'));assert.equal(JSON.parse(await readFile('vercel.json','utf8')).outputDirectory,'public');
console.log('Build verified: public assets + Vercel Node.js functions.');
