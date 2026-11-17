// Takes the product screenshots used on the website (site/img). Run with
// `npm run screenshots` after design changes. Uses the local test sign-in and
// invented data only: a fictional firm, clients and members.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'site', 'img');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headcount-shots-'));
const port = 3800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${port}`;
// Stand-ins for the public data sources and Claude, with invented bills,
// rules and notices, so the Monitor and the action page have something to show.
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const reasons = [[/Rural Broadband Deployment/, 98, 'Creates the grant program your co-ops would apply to, with a rural set-aside.'], [/Infrastructure Grant/, 91, 'State match for federal broadband grants; co-ops are eligible applicants.'], [/Subgrantee/, 86, 'Sets the rules co-ops must meet to receive broadband grants. Comments are open.'], [/Network Services/, 74, 'A federal contract for rural network buildout in your service area.'], [/Affordability/, 58, 'Related: subsidies for subscribers rather than buildout.']];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/v3/bill') return j({ bills: [
      { congress: 119, type: 'HR', number: '4821', title: 'Rural Broadband Deployment Act of 2026', latestAction: { actionDate: day(-1), text: 'Referred to the Subcommittee on Communications and Technology.' }, updateDate: day(0) },
      { congress: 119, type: 'S', number: '2290', title: 'Broadband Affordability and Access Act', latestAction: { actionDate: day(-3), text: 'Read twice and referred to the Committee on Commerce, Science, and Transportation.' }, updateDate: day(-1) },
      { congress: 119, type: 'HR', number: '5102', title: 'Highway Formula Modernization Act', latestAction: { actionDate: day(-2), text: 'Introduced.' }, updateDate: day(-1) }] });
    if (u.pathname === '/os/bills') return j({ results: [{ id: 'ocd-bill/ex1186', identifier: 'SB 1186', title: 'Broadband Infrastructure Grant Program', session: '2027', jurisdiction: { id: 'ocd-jurisdiction/country:us/state:fl/government' }, latest_action_description: 'Referred to Regulated Industries; Appropriations', latest_action_date: day(-2), updated_at: day(-1) }] });
    if (u.pathname === '/fr/documents.json') return j({ results: [{ document_number: '2026-90001', title: 'Broadband Equity Program: Subgrantee Requirements', type: 'Proposed Rule', abstract: 'Proposes requirements for entities receiving broadband deployment subgrants.', html_url: 'https://www.federalregister.gov/', publication_date: day(-4), agencies: [{ name: 'National Telecommunications and Information Administration' }], comments_close_on: day(26), docket_ids: ['NTIA-2026-0007'] }] });
    if (u.pathname === '/sam/opportunities/v2/search') return j({ opportunitiesData: [{ noticeId: 'ex1', title: 'Rural Broadband Network Services', solicitationNumber: 'RUS-27-0042', fullParentPathName: 'AGRICULTURE, DEPARTMENT OF.RURAL UTILITIES SERVICE', type: 'Solicitation', postedDate: day(-2), responseDeadLine: day(21), naicsCode: '517111', typeOfSetAsideDescription: 'Total Small Business Set-Aside', uiLink: 'https://sam.gov/', active: 'Yes' }] });
    if (u.pathname === '/geo/geographies/onelineaddress') return j({ result: { addressMatches: [{ matchedAddress: '1200 PARK AVE, SPRINGFIELD', geographies: { States: [{ STUSAB: 'FL' }], '2026 State Legislative Districts - Upper': [{ BASENAME: '19' }], '2026 State Legislative Districts - Lower': [{ BASENAME: '40' }] } }] } });
    if (u.pathname === '/v1/messages') {
      const items = [...body.matchAll(/<item id=\\"(\d+)\\">([^<]*)/g)].map((m) => { const r = reasons.find(([re]) => re.test(m[2])) || [null, 30, 'Mentions broadband in passing.']; return { id: m[1], score: r[1], reason: r[2] }; });
      return j({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ scores: items }) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const M = `http://127.0.0.1:${mock.address().port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AUTH_MODE: 'dev', NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_screenshots', STRIPE_WEBHOOK_SECRET: 'whsec_screenshots', STRIPE_PRICE_TEAM: 'price_team', STRIPE_PRICE_FIRM: 'price_firm',
  CONGRESS_API_KEY: 'k', CONGRESS_API_BASE: `${M}/v3`, OPENSTATES_API_KEY: 'k', OPENSTATES_API_BASE: `${M}/os`, FEDREG_API_BASE: `${M}/fr`, SAM_API_KEY: 'k', SAM_API_BASE: `${M}/sam`, GEOCODER_BASE: `${M}/geo`, ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: M, MONITOR: 'off', PUBLIC_URL: `http://localhost:${port}` } });
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

  // 5. The Monitor, with a few watches for the firm's broadband client
  await page.evaluate(async () => {
    const clientId = CLIENTS.find((k) => k.name === 'Prairie Co-ops Alliance').id, pri = 'Federal and state grants for rural electric co-ops building broadband';
    for (const w of [{ kind: 'bill', query: 'broadband', states: ['US', 'FL'], name: 'Broadband bills' }, { kind: 'reg', query: 'broadband', name: 'Broadband rules' }, { kind: 'contract', query: 'broadband', name: 'Broadband contracts' }]) await CLOUD.api('POST', `/api/workspaces/${ORG.id}/watches`, { ...w, priorities: pri, clientId });
  });
  await page.click('[data-page=monitor]'); await page.waitForFunction(() => MON.items && MON.items.length >= 4);
  await page.evaluate(() => window.scrollTo(0, 0)); await shot('monitor.png');

  // 6. A public action page, on a phone
  const actUrl = await page.evaluate(async () => {
    const camp = ACCOUNT.list.find((c) => /SB 214/.test(c.name));
    await cloudOpen(camp.id);
    const targets = S.members.map((m) => ({ id: m.id, name: m.name, party: m.party, district: m.district, email: `${m.name.split(' ').pop().toLowerCase()}@senate.example`, title: 'Senator' }));
    const r = await CLOUD.api('PUT', `/api/campaigns/${encodeURIComponent(camp.id)}/action`, { title: 'Tell your senator: bring broadband to rural communities', intro: 'SB 214 helps internet providers build high-speed service in rural areas with no broadband today. Your senator votes on it in committee soon.', subject: 'Please support SB 214', letter: 'As your constituent, I am asking you to vote yes on SB 214, the Rural Broadband Expansion Act.\n\nOur family runs a farm twenty miles from the nearest fiber line. Reliable internet would let our kids do their homework at home and let us sell directly to customers.\n\nPlease let me know where you stand.', callScript: 'Say you are a constituent, give your address, and ask the senator to vote yes on SB 214.', juris: { level: 'state', state: 'FL', chamber: 'upper' }, targets });
    return r.action.url;
  });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const pp = await phone.newPage(); await pp.goto(actUrl);
  await pp.waitForFunction(() => /broadband/.test(document.querySelector('#title').textContent));
  await pp.fill('#address', '1200 Park Ave, Springfield'); await pp.click('#where button');
  await pp.waitForSelector('#letter:not([hidden])'); await pp.fill('#name', 'Jordan Ellis');
  await pp.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); }); await pp.waitForTimeout(600);
  await pp.screenshot({ path: path.join(OUT, 'action.png') }); console.log('wrote action.png');
  await phone.close();
} finally {
  await browser.close(); server.kill(); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true });
}
