import {chromium} from 'playwright';

const ids = process.argv.slice(2);
const secret = process.env.CRON_SECRET;
const base = process.env.APP_URL || 'https://supercharger-saver.vercel.app';
if (!secret) {
  console.error('CRON_SECRET required');
  process.exit(1);
}
if (!ids.length) {
  console.error('Usage: node scripts/seed-prices.mjs <stationId>...');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  locale: 'en-US',
  viewport: {width: 1280, height: 900},
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
});
const page = await context.newPage();
await page.goto('https://www.tesla.com/findus', {waitUntil: 'networkidle', timeout: 90000});
await page.waitForTimeout(8000);

const items = [];
for (const id of ids) {
  const url =
    'https://www.tesla.com/api/findus/get-charger-details?' +
    new URLSearchParams({
      locationSlug: id,
      programType: 'supercharger',
      locale: 'en-US',
      isInHkMoTw: 'false',
    });
  try {
    const data = await page.evaluate(async (u) => {
      const r = await fetch(u, {headers: {Accept: 'application/json'}});
      const text = await r.text();
      return {ok: r.ok, status: r.status, text};
    }, url);
    if (!data.ok) throw new Error('HTTP ' + data.status + ' ' + data.text.slice(0, 120));
    const json = JSON.parse(data.text);
    const detail = json?.data?.data;
    if (!detail?.name) throw new Error('Missing detail payload');
    items.push({id, detail});
    console.log('fetched', id, detail.name);
  } catch (e) {
    console.error('failed', id, e.message || e);
  }
}
await browser.close();

if (!items.length) {
  console.error('No stations fetched');
  process.exit(1);
}

const res = await fetch(base + '/api/ingest', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + secret,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({items}),
});
console.log('ingest', res.status, await res.text());
