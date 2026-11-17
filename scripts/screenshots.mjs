// Takes the product screenshots used on the website (site/img). Run with
// `npm run screenshots` after design changes. Uses the local test sign-in and
// invented data only: a fictional firm, clients and members.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'site', 'img');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headcount-shots-'));
const port = 3800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AUTH_MODE: 'dev', NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_screenshots', STRIPE_WEBHOOK_SECRET: 'whsec_screenshots', STRIPE_PRICE_TEAM: 'price_team', STRIPE_PRICE_FIRM: 'price_firm' } });
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('Headcount on')) resolve(); }));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'light', timezoneId: 'America/New_York', locale: 'en-US' });
// Calendar and email stand-ins so the request shows real suggested times.
await ctx.route('https://www.googleapis.com/calendar/v3/**', (r) => r.fulfill({ json: { items: [] } }));
const page = await ctx.newPage();
const hide = () => page.addStyleTag({ content: '#banner, #warn, #toast { display: none !important; } footer { display: none !important; }' });
const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(OUT, name) }); console.log('wrote', name); };
fs.mkdirSync(OUT, { recursive: true });

try {
  // Sign in and set up a fictional firm.
  await page.goto(`${BASE}/app`); await page.waitForSelector('.seat', { state: 'attached' });
  await page.click('#acct [data-act=signin]');
  await page.fill('#dev_name', 'Alex Rivera'); await page.fill('#dev_email', 'alex@capstrat.example');
  await page.click('[data-act=signinWith][data-p=google]');
  await page.waitForSelector('#woForm'); await page.fill('#wo_name', 'Capitol Strategies'); await page.click('#woForm .primary');
  await page.waitForFunction(() => ORG && ORG.name === 'Capitol Strategies');
  for (const c of ['Prairie Co-ops Alliance', 'Gulf Coast Hospital Association', 'Sunshine State Credit Unions']) await page.evaluate((name) => CLOUD.api('POST', `/api/workspaces/${ORG.id}/clients`, { name }), c);
  await page.evaluate(() => loadOrg(ORG.id));

  // The example campaign becomes the firm's first campaign.
  await page.click('[data-page=count]');
  const first = page.locator('#rows select[data-pos]').first();
  await first.selectOption((await first.inputValue()) === '4' ? '3' : '4');
  await page.waitForFunction(() => S.cloud && !SYNC.busy && !SYNC.timer && !SYNC.creating, null, { timeout: 20000 });
  await page.click('.tools [data-act=setup]');
  await page.selectOption('#s_clientId', { label: 'Prairie Co-ops Alliance' });
  await page.fill('#s_ask', 'Vote yes on SB 214 without the cap amendment'); await page.fill('#s_me', 'Alex Rivera');
  await page.fill('#s_cd', await page.evaluate(() => daysAgo(-9)));
  await page.click('#sForm .primary');
  await page.waitForFunction(() => !SYNC.busy && !SYNC.timer);

  // 1. The vote count
  await hide(); await page.evaluate(() => window.scrollTo(0, 0)); await shot('count.png');

  // 2. A meeting request with times from the calendar
  await page.locator('#calls .who').first().click();
  await page.click('[data-tab=staff]'); await page.click('[data-act=addStaff]');
  await page.fill('#st_name', 'Jamie Ortiz'); await page.fill('#st_role', 'Scheduler'); await page.fill('#st_email', 'jamie.ortiz@senate.example'); await page.click('#stForm .primary');
  await page.locator('[data-act=rq][data-sid]').click();
  await page.click('[data-act=rqFind]'); await page.waitForFunction(() => /Offering/.test(document.querySelector('#rqMsg').textContent));
  await page.evaluate(() => { const d = document.querySelector('#drawer'), b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Request a meeting') || d.querySelector('[data-rqmode]'); d.scrollTop += b.getBoundingClientRect().top - d.getBoundingClientRect().top - 10; });
  await shot('request.png');
  await page.keyboard.press('Escape');

  // 3. The bill brief
  await page.click('[data-page=brief]'); await page.evaluate(() => window.scrollTo(0, 0)); await shot('brief.png');

  // 4. The portfolio, with three more invented campaigns
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const more = [
    { name: 'HB 1021: Property Insurance Reform', client: 'Sunshine State Credit Unions', odds: 0.41, was: 0.33, side: 'pass', n: 120, needF: 61, counts: [44, 13, 21, 15, 27], cmte: day(4), floor: '', bill: 'HB 1021', status: 'Passed Insurance & Banking Subcommittee', req: 2, meets: [[2, 9, 30]], due: [day(-2), day(3)], open: 4 },
    { name: 'SB 88: Hospital Price Caps', client: 'Gulf Coast Hospital Association', odds: 0.71, was: 0.74, side: 'defeat', n: 40, needF: 21, counts: [9, 4, 6, 8, 13], cmte: '', floor: day(11), bill: 'SB 88', status: 'On the special order calendar', req: 0, meets: [[1, 14, 0], [3, 11, 0]], due: [day(1)], open: 2 },
    { name: 'H.R. 2210: Rural Health Access Act', client: 'Gulf Coast Hospital Association', odds: 0.22, was: 0.18, side: 'pass', n: 433, needF: 217, counts: [151, 38, 54, 40, 150], cmte: day(16), floor: '', bill: 'H.R. 2210', status: 'Referred to Energy and Commerce', req: 3, meets: [], due: [], open: 1 },
  ];
  await page.evaluate(async (list) => {
    for (const c of list) {
      const id = 'shot' + Math.random().toString(36).slice(2, 9), clientId = CLIENTS.find((k) => k.name === c.client).id;
      await CLOUD.api('POST', '/api/campaigns', { id, workspaceId: ORG.id, name: c.name, clientId });
      const summary = { odds: c.odds, side: c.side, n: c.n, needF: c.needF, counts: c.counts, trend: [{ d: daysAgo(8), p: c.was }], cmteDate: c.cmte, floorDate: c.floor, bill: c.bill, billStatus: c.status, requested: c.req, meetings: c.meets.map(([days, h, m]) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return { start: d.toISOString(), title: `${c.bill}: meeting` }; }), openTasks: c.open, dueDates: c.due };
      await CLOUD.api('POST', `/api/campaigns/${id}/records`, { ops: [{ kind: 'meta', data: { campaign: { bill: c.name, clientId, side: c.side, chamber: '', rule: 'majority' } } }, { kind: 'summary', data: summary }] });
    }
    await refreshAccount();
  }, more);
  await page.click('[data-page=portfolio]'); await page.waitForSelector('#portfolioPage .prow >> nth=3');
  await page.evaluate(() => window.scrollTo(0, 0)); await shot('portfolio.png');
} finally {
  await browser.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true });
}
