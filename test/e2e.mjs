// End-to-end check of the app in a real browser, with stand-ins for Google,
// Microsoft, Congress.gov and the Claude API. Run with `npm run e2e`.
// Needs Playwright with Chromium installed.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.env.SHOTS || '';
const log = (...a) => console.log(...a);
const flat = (s) => s.replace(/\s*\n+\s*/g, ' | ');

// ---------- stand-ins for Congress.gov, Claude and Stripe ----------
const draft = { plainSummary: 'Funds rural broadband grants.', keyProvisions: ['Creates a grant program.', 'Caps grants at 60 percent.'], whoItAffects: 'Rural households and providers.', fiscalImpact: 'Not stated in the material.', talkingPoints: ['Closes the rural gap.', 'Providers share the cost.'], objections: [{ objection: 'Too costly', response: 'Grants are capped.' }], needsChecking: ['Program cost'] };
const stripeState = { org: null, seats: 0 };
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/v3/bill/119/hr/1234') return j(200, { bill: { title: 'Rural Broadband Access Act', introducedDate: '2025-03-04', sponsors: [{ fullName: 'Rep. Smith, Ann [D-IA-2]', party: 'D', state: 'IA', district: 2 }], cosponsors: { count: 12 }, latestAction: { actionDate: '2025-06-01', text: 'Referred to the Subcommittee on Communications and Technology.' } } });
    if (u.pathname === '/v3/bill/119/hr/1234/summaries') return j(200, { summaries: [{ actionDate: '2025-03-04', actionDesc: 'Introduced in House', text: '<p>This bill creates grants for rural broadband.</p>' }] });
    if (u.pathname === '/v3/bill/119/hr/1234/committees') return j(200, { committees: [{ name: 'Energy and Commerce Committee' }] });
    if (u.pathname === '/v1/messages') {
      const b = JSON.parse(body || '{}'), screening = /You screen/.test(JSON.stringify(b.system || ''));
      const items = screening ? [...JSON.stringify(b.messages).matchAll(/<item id=\\"(\d+)\\">([^<]*)/g)].map((x) => ({ id: x[1], score: /broadband/i.test(x[2]) ? 88 : 20, reason: /broadband/i.test(x[2]) ? 'Directly about rural broadband grants.' : 'Not about broadband.' })) : null;
      return j(200, { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(screening ? { scores: items } : draft) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    // Monitor, intelligence, rosters and the action center
    if (u.pathname === '/v3/bill') return j(200, { bills: [{ congress: 119, type: 'HR', number: '1234', title: 'Rural Broadband Access Act', latestAction: { actionDate: '2026-11-16', text: 'Referred to the Subcommittee on Communications and Technology.' }, updateDate: '2026-11-16T10:00:00Z' }, { congress: 119, type: 'S', number: '99', title: 'Highway Funding Act', latestAction: { actionDate: '2026-11-15', text: 'Introduced.' }, updateDate: '2026-11-15T10:00:00Z' }] });
    if (u.pathname === '/bills' && u.searchParams.get('q')) return j(200, { results: [{ id: 'ocd-bill/fl77', identifier: 'HB 77', title: 'Broadband Infrastructure Grants', session: '2026', jurisdiction: { id: 'ocd-jurisdiction/country:us/state:fl/government' }, latest_action_description: 'Filed', latest_action_date: '2026-11-10', updated_at: '2026-11-10T00:00:00', openstates_url: 'https://openstates.org/fl/bills/2026/HB77/' }] });
    if (u.pathname === '/people') return j(200, { pagination: { max_page: 1 }, results: [
      { id: 'ocd-person/aaaa-1111', name: 'Corey Simon', party: 'Republican', current_role: { district: '3' }, email: 'simon.corey@flsenate.gov', offices: [{ classification: 'capitol', address: '404 S. Monroe St., Tallahassee, FL 32399', voice: '850-487-5003' }] },
      { id: 'ocd-person/bbbb-2222', name: 'Ana Ruiz', party: 'Democratic', current_role: { district: '12' }, email: 'ruiz.ana@flsenate.gov', offices: [] }] });
    if (u.pathname === '/lda/filings/') return j(200, { results: [{ filing_uuid: 'f1', filing_year: 2026, filing_period_display: '3rd Quarter', income: '50000.00', registrant: { name: 'Akin Strategies' }, client: { name: 'Rural Telecom Coalition' }, lobbying_activities: [{ description: 'H.R.1234, Rural Broadband Access Act', government_entities: [{ name: 'HOUSE OF REPRESENTATIVES' }] }], dt_posted: '2026-10-20T10:00:00' }] });
    if (u.pathname === '/geo/geographies/address' && /\bapt\b/i.test(u.searchParams.get('street') || '')) return j(200, { result: { addressMatches: [] } });
    if (u.pathname === '/geo/geographies/onelineaddress' || u.pathname === '/geo/geographies/address') return j(200, { result: { addressMatches: [{ matchedAddress: '100 MAIN ST, TALLAHASSEE, FL, 32301', geographies: { States: [{ STUSAB: 'FL' }], '119th Congressional Districts': [{ CD119: '02' }], '2024 State Legislative Districts - Upper': [{ BASENAME: '3' }], '2024 State Legislative Districts - Lower': [{ BASENAME: '8' }] } }] } });
    if (u.pathname === '/fr/documents.json') return j(200, { results: [] });
    if (u.pathname === '/v1/customers') return j(200, { id: 'cus_e2e' });
    if (u.pathname === '/v1/checkout/sessions') { const f = new URLSearchParams(body); stripeState.org = f.get('client_reference_id'); stripeState.seats = +f.get('line_items[0][quantity]'); stripeState.price = f.get('line_items[0][price]'); stripeState.success = f.get('success_url'); return j(200, { id: 'cs_e2e', url: `${M}/checkout` }); }
    if (u.pathname === '/v1/subscriptions/sub_e2e') return j(200, { id: 'sub_e2e', customer: 'cus_e2e', status: 'active', metadata: { org_id: stripeState.org }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ id: 'si_e2e', quantity: stripeState.seats, price: { id: stripeState.price } }] } });
    if (u.pathname === '/checkout') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Stripe Checkout (test)</title><h1>Pay</h1>'); }
    j(404, {});
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const M = `http://127.0.0.1:${mock.address().port}`;

// ---------- the app ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headcount-e2e-'));
const port = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AUTH_MODE: 'dev', NODE_ENV: 'test', CONGRESS_API_KEY: 'k', CONGRESS_API_BASE: `${M}/v3`, ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: M,
    STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_e2e', STRIPE_PRICE_TEAM: 'price_team', STRIPE_PRICE_FIRM: 'price_firm', STRIPE_API_BASE: M, PUBLIC_URL: BASE, PRICE_LABEL_TEAM: 'per seat, monthly', PRICE_LABEL_FIRM: 'per seat, with SSO', SALES_EMAIL: 'sales@headcount.test',
    OPENSTATES_API_KEY: 'os', OPENSTATES_API_BASE: M, FEDREG_API_BASE: `${M}/fr`, LDA_API_BASE: `${M}/lda`, GEOCODER_BASE: `${M}/geo`, MONITOR: 'off' },
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('Headcount on')) resolve(); }));
async function stripeHook(event) {
  const raw = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_e2e').update(`${t}.${raw}`).digest('hex')}`;
  const r = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: raw });
  assert.equal(r.status, 200);
}

// ---------- stand-ins for Google and Microsoft ----------
function fakeProviders(ctx, rec) {
  const now = new Date();
  ctx.route('https://www.googleapis.com/calendar/v3/**', async (route) => {
    const req = route.request(), u = new URL(req.url());
    rec.push({ who: 'google', method: req.method(), url: u.pathname + u.search, body: req.postData() });
    if (req.method() === 'GET' && u.pathname.endsWith('/events')) {
      // Busy all of tomorrow morning, so suggestions should skip it.
      const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0); const e = new Date(t); e.setHours(13, 0, 0, 0);
      return route.fulfill({ json: { items: [{ status: 'confirmed', start: { dateTime: t.toISOString() }, end: { dateTime: e.toISOString() } }] } });
    }
    if (req.method() === 'POST') { const b = JSON.parse(req.postData()); return route.fulfill({ json: { id: 'gev1', htmlLink: 'https://www.google.com/calendar/event?eid=gev1', hangoutLink: 'https://meet.google.com/abc-defg-hij', ...b } }); }
    if (req.method() === 'GET') return route.fulfill({ json: { status: 'confirmed', start: { dateTime: rec.start }, end: { dateTime: rec.end }, location: 'Room 214', htmlLink: 'https://www.google.com/calendar/event?eid=gev1', attendees: [{ email: 'jamie@senate.example.gov', responseStatus: 'accepted' }, { email: 'alice@example.org', responseStatus: 'accepted', organizer: true }] } });
    if (req.method() === 'DELETE') return route.fulfill({ status: 204, body: '' });
    route.fulfill({ status: 400, json: {} });
  });
  ctx.route('https://gmail.googleapis.com/**', async (route) => { const req = route.request(); rec.push({ who: 'gmail', method: req.method(), url: req.url(), body: req.postData() }); route.fulfill({ json: { id: 'm1' } }); });
  ctx.route('https://graph.microsoft.com/**', async (route) => {
    const req = route.request(), u = new URL(req.url());
    rec.push({ who: 'graph', method: req.method(), url: u.pathname + u.search, body: req.postData(), prefer: req.headers().prefer });
    if (u.pathname.endsWith('/calendarView')) return route.fulfill({ json: { value: [] } });
    if (u.pathname.endsWith('/sendMail')) return route.fulfill({ status: 202, body: '' });
    if (req.method() === 'POST' && u.pathname.endsWith('/events')) return route.fulfill({ status: 201, json: { id: 'msev1', webLink: 'https://outlook.office.com/calendar/item/msev1', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' } } });
    route.fulfill({ status: 400, json: {} });
  });
}

const browser = await chromium.launch();
const errors = [];
async function person(name, provider) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, acceptDownloads: true });
  const rec = []; fakeProviders(ctx, rec);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 404/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  return { ctx, page, rec, name, provider };
}
async function signIn(p) {
  await p.page.click('#acct [data-act=signin]');
  await p.page.fill('#dev_name', p.name); await p.page.fill('#dev_email', `${p.name.toLowerCase()}@example.org`);
  await p.page.click(`[data-act=signinWith][data-p=${p.provider}]`);
  await p.page.waitForFunction(() => typeof ME === 'string' && ME.length > 0);
}
const outbox = async () => (await (await fetch(`${BASE}/api/dev/outbox`)).json()).emails;
const settle = (page) => page.waitForFunction(() => !SYNC.busy && !SYNC.timer && !SYNC.creating && !SYNC.loading, null, { timeout: 20000 });
const shot = async (page, name, full) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: Boolean(full) }); };

try {
  // ===== Signed out: everything works in the browser =====
  const guest = await person('Guest', 'google');
  await guest.page.goto(`${BASE}/app`); await guest.page.waitForSelector('.seat');
  assert.match(await guest.page.locator('#banner').innerText(), /Example campaign/);
  await guest.page.locator('#calls .who').first().click();
  await guest.page.click('[data-tab=staff]'); await guest.page.click('[data-act=addStaff]');
  await guest.page.fill('#st_name', 'Jamie Ortiz'); await guest.page.fill('#st_role', 'Scheduler'); await guest.page.fill('#st_email', 'jamie@senate.example.gov'); await guest.page.click('#stForm .primary');
  await guest.page.click('[data-tab=act]'); await guest.page.click('[data-act=rq]');
  const body = await guest.page.inputValue('#rq_body');
  assert.match(body, /^Hi Jamie,/); assert.match(body, /Would one of these times work\?/); assert.match(body, /In short: Creates a state grant program/);
  await guest.page.click('[data-act=rqMailto]');
  await guest.page.click('[data-act=rqLogged]');
  assert.match(await guest.page.locator('#meets').innerText(), /Requested/);
  await guest.page.keyboard.press('Escape');
  assert.match(await guest.page.locator('#tasks').innerText(), /Follow up with Jamie Ortiz on the meeting request/);
  await guest.page.locator('#meets [data-act=bookTime]').click();
  const [dl] = await Promise.all([guest.page.waitForEvent('download'), guest.page.click('[data-act=rqIcs]')]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(ics, /BEGIN:VEVENT/); assert.match(ics, /ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:jamie@senate\.example\.gov/);
  await guest.page.reload(); await guest.page.waitForSelector('.seat');
  assert.equal(await guest.page.evaluate(() => S.meetings.length), 1);
  log('ok  signed out: meeting request via email app, invitation file, saved in the browser');

  // ===== Alice signs in with Google and sets up her firm's workspace =====
  const alice = await person('Alice', 'google');
  await alice.page.goto(`${BASE}/app`); await alice.page.waitForSelector('.seat');
  await signIn(alice);
  await alice.page.waitForSelector('#woForm');
  await alice.page.fill('#wo_name', 'Capitol Strategies'); await alice.page.click('#woForm .primary');
  await alice.page.waitForFunction(() => ORG && ORG.name === 'Capitol Strategies' && /Team trial · 14 days left/.test(document.querySelector('#workspacePage').textContent), null, { polling: 200 });
  await alice.page.fill('#ck_name', 'Prairie Co-ops Alliance'); await alice.page.click('#ckForm .btn');
  await alice.page.waitForFunction(() => CLIENTS.length === 1);
  log('ok  workspace created on a 14-day trial; client added');

  // The example becomes a campaign in the workspace on first edit
  await alice.page.click('[data-page=count]');
  await alice.page.locator('#rows select[data-pos]').first().selectOption('3');
  await settle(alice.page);
  assert.equal(await alice.page.evaluate(() => S.cloud), true);
  await alice.page.click('.tools [data-act=setup]');
  await alice.page.selectOption('#s_clientId', { label: 'Prairie Co-ops Alliance' });
  await alice.page.click('#sForm .primary'); await settle(alice.page);
  assert.match(await alice.page.locator('#hSub').innerText(), /for Prairie Co-ops Alliance/);
  log('ok  first edit saves the campaign to the workspace; client set');

  // Bill brief: look up, draft, print view
  await alice.page.click('[data-page=brief]');
  await alice.page.click('[data-act=briefLookup]');
  await alice.page.selectOption('#lk_j', 'US'); await alice.page.fill('#lk_n', 'H.R. 1234'); await alice.page.fill('#lk_s', '119');
  await alice.page.click('#lkForm .primary');
  await alice.page.waitForSelector('#lkForm .primary:has-text("clear the old analysis")');
  await alice.page.click('#lkForm .primary');
  await alice.page.waitForFunction(() => S.brief.number === 'H.R. 1234' && !S.brief.supporters);
  await alice.page.click('[data-act=briefDraft]');
  await alice.page.fill('#df_text', 'Section 2. The Secretary shall award grants.');
  await alice.page.click('#dfGo');
  await alice.page.waitForFunction(() => S.brief.plainSummary === 'Funds rural broadband grants.');
  assert.match(await alice.page.locator('.brief').innerText(), /on behalf of Prairie Co-ops Alliance/);
  await shot(alice.page, 'brief', true);
  log('ok  bill brief: lookup from Congress.gov and drafted analysis');

  // Request by Gmail with times from Google Calendar
  await alice.page.click('[data-page=count]');
  await alice.page.locator('#calls .who').first().click();
  const memberName = await alice.page.locator('#drawer h2').innerText();
  await alice.page.click('[data-tab=staff]'); await alice.page.click('[data-act=addStaff]');
  await alice.page.fill('#st_name', 'Jamie Ortiz'); await alice.page.fill('#st_role', 'Scheduler'); await alice.page.fill('#st_email', 'jamie@senate.example.gov'); await alice.page.click('#stForm .primary');
  await alice.page.locator('[data-act=rq][data-sid]').click();
  await alice.page.click('[data-act=rqFind]');
  await alice.page.waitForFunction(() => /Offering/.test(document.querySelector('#rqMsg').textContent));
  await alice.page.click('[data-act=rqSend]');
  await alice.page.waitForFunction(() => S.meetings.some((x) => x.status === 'requested'));
  const raw = JSON.parse(alice.rec.find((r) => r.who === 'gmail').body).raw, mime = Buffer.from(raw, 'base64url').toString('utf8');
  const text = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text, /I'm Alice with Capitol Strategies, on behalf of Prairie Co-ops Alliance\./);
  await alice.page.keyboard.press('Escape');
  await alice.page.locator('#meets [data-act=bookTime]').click();
  await alice.page.click('[data-act=rqInvite]');
  await alice.page.waitForFunction(() => S.meetings.some((x) => x.status === 'invited' && x.eventId === 'gev1'));
  const ev = JSON.parse(alice.rec.find((r) => r.who === 'google' && r.method === 'POST').body);
  alice.rec.start = ev.start.dateTime; alice.rec.end = ev.end.dateTime;
  await alice.page.keyboard.press('Escape');
  await alice.page.click('[data-act=checkReplies]');
  await alice.page.waitForFunction(() => /Accepted/.test(document.querySelector('#meets').textContent));
  await settle(alice.page);
  log('ok  meeting request from Gmail names the firm and client; invitation accepted');

  // ===== Bob joins the workspace from an invitation and signs in with Microsoft =====
  await alice.page.click('[data-page=workspace]');
  await alice.page.waitForSelector('#oiForm');
  await alice.page.selectOption('#oi_role', 'member'); await alice.page.uncheck('#oi_send'); await alice.page.click('#oiForm .primary');
  await alice.page.waitForFunction(() => WS.lastInvite);
  const memberLink = await alice.page.inputValue('#oi_link');
  const bob = await person('Bob', 'microsoft');
  await bob.page.goto(memberLink); await bob.page.waitForSelector('.seat');
  assert.match(await bob.page.locator('#banner').innerText(), /Alice invited you to join Capitol Strategies as a member/);
  await signIn(bob);
  await bob.page.waitForFunction(() => ORG && ORG.name === 'Capitol Strategies' && page === 'portfolio' && ACCOUNT.list.length === 1);
  await bob.page.waitForSelector('#portfolioPage .prow');
  assert.match(await bob.page.locator('#portfolioPage').innerText(), /Prairie Co-ops Alliance/);
  await shot(bob.page, 'portfolio');
  await bob.page.locator('#portfolioPage .prow').first().click();
  await bob.page.waitForFunction(() => S.cloud && S.members.length === 41 && S.brief.number === 'H.R. 1234');
  const before = await alice.page.evaluate(() => S.members[25].pos);
  await bob.page.locator('#rows select[data-pos]').nth(25).selectOption('4');
  await settle(bob.page);
  await alice.page.click('[data-page=count]');
  await alice.page.waitForFunction((b) => S.members.some((m) => m.pos !== b) && S.members.filter((m) => m.pos === 4).length > 0, before, { timeout: 15000 });
  log('ok  Bob joined from a workspace invitation, found the campaign in the portfolio, and his change reached Alice');

  // Alice assigns Bob a follow-up; Bob gets an email
  await alice.page.reload(); await alice.page.waitForFunction(() => S.cloud && S.members.length === 41);
  await alice.page.waitForFunction(() => WS.members && WS.members.some((x) => x.name === 'Bob') && document.querySelector('#t_for option[value="dev:bob"]'));
  await alice.page.fill('#t_text', 'Send Bob the fiscal note'); await alice.page.selectOption('#t_for', 'dev:bob'); await alice.page.click('#tForm .btn');
  await alice.page.waitForFunction(() => /for Bob/.test(document.querySelector('#tasks').textContent));
  await settle(alice.page);
  for (let i = 0; i < 20 && !(await outbox()).some((x) => x.kind === 'assigned'); i++) await alice.page.waitForTimeout(250);
  const asg = (await outbox()).find((x) => x.kind === 'assigned');
  assert.equal(asg.to_addr, 'bob@example.org'); assert.match(asg.subject, /Alice assigned you a follow-up: Send Bob the fiscal note/);
  await alice.page.click('#acct [data-act=account]');
  await alice.page.selectOption('#pf_digest', 'daily');
  await alice.page.waitForFunction(() => PREFS && PREFS.digest === 'daily');
  await alice.page.keyboard.press('Escape');
  log('ok  a follow-up assigned to Bob emailed him; Alice switched to a daily digest');

  // Bob requests through Outlook
  await bob.page.fill('#q', memberName); await bob.page.locator('#rows .who').first().click();
  await bob.page.click('[data-act=rq]');
  await bob.page.click('[data-act=rqSend]');
  await bob.page.waitForFunction(() => S.meetings.filter((x) => x.status === 'requested').length === 1);
  const msg = JSON.parse(bob.rec.find((r) => r.who === 'graph' && r.url.endsWith('/sendMail')).body).message;
  assert.equal(msg.toRecipients[0].emailAddress.address, 'jamie@senate.example.gov');
  await bob.page.keyboard.press('Escape'); await settle(bob.page);
  log('ok  Bob sent a meeting request through Outlook');

  // ===== Carol, a client, gets view-only access to one campaign =====
  await alice.page.click('.tools [data-act=setup]');
  await alice.page.waitForSelector('#teamBody .people');
  await alice.page.selectOption('#inv_role', 'viewer'); await alice.page.click('[data-act=mkInvite]');
  await alice.page.waitForSelector('#inv_for:has-text("a viewer")');
  const viewerLink = await alice.page.inputValue('#inv_link');
  await alice.page.keyboard.press('Escape');
  const carol = await person('Carol', 'google');
  await carol.page.goto(viewerLink); await carol.page.waitForSelector('.seat');
  await signIn(carol);
  await carol.page.waitForFunction(() => S.cloud && S.members.length === 41 && ORG && ORG.role === 'guest');
  assert.match(await carol.page.locator('#warn').innerText(), /view-only/);
  await carol.page.locator('#calls .who').first().click();
  assert.equal(await carol.page.locator('#drawer [data-act=rq]').count(), 0);
  await carol.page.keyboard.press('Escape');
  log('ok  Carol joined as a guest with view-only access');

  // ===== Reports for the firm =====
  await alice.page.click('[data-page=workspace]');
  await alice.page.waitForSelector('#rpForm');
  await alice.page.click('#rpForm .primary');
  await alice.page.waitForFunction(() => WS.report && WS.report.rows.length >= 2);
  const rep = await alice.page.locator('#workspacePage').innerText();
  assert.match(rep, /Prairie Co-ops Alliance/); assert.match(rep, /H\.R\. 1234: Rural Broadband Access Act/);
  const [csvDl] = await Promise.all([alice.page.waitForEvent('download'), alice.page.click('[data-act=rpCsv]')]);
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  assert.match(csvText, /^Date,Client,Issue,Chamber,Member/); assert.match(csvText, /Alice/); assert.match(csvText, /Bob/);
  await alice.page.reload(); await alice.page.waitForFunction(() => ORG); await alice.page.click('[data-page=workspace]');
  await alice.page.waitForFunction(() => WS.audit && WS.audit.length > 0);
  const log1 = await alice.page.locator('#workspacePage').innerText();
  assert.match(log1, /created the workspace/); assert.match(log1, /Bob joined/); assert.match(log1, /ran the activity report/);
  await shot(alice.page, 'workspace', true);
  log('ok  lobbying activity report (with CSV) and activity log');

  // ===== Closing a campaign takes it away from members who were not added =====
  await alice.page.click('[data-page=count]');
  await alice.page.click('.tools [data-act=setup]');
  await alice.page.waitForSelector('#camp_vis');
  await alice.page.selectOption('#camp_vis', 'team');
  await alice.page.waitForFunction(() => /Only the people listed/.test(document.querySelector('#toast').textContent));
  await alice.page.keyboard.press('Escape');
  await bob.page.waitForFunction(() => /access to it was removed/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
  assert.equal(await bob.page.evaluate(() => ACCOUNT.list.length), 0);
  log('ok  closing the campaign removed it for Bob');

  // ===== Subscribing through Stripe =====
  await alice.page.click('[data-page=workspace]');
  await alice.page.fill('#bill_seats', '5');
  await Promise.all([alice.page.waitForURL(`${M}/checkout`), alice.page.click('[data-act=billCheckout][data-plan=firm]')]);
  assert.equal(stripeState.seats, 5);
  await stripeHook({ id: 'evt_e2e', type: 'checkout.session.completed', data: { object: { client_reference_id: stripeState.org, customer: 'cus_e2e', subscription: 'sub_e2e' } } });
  await alice.page.goto(stripeState.success);
  await alice.page.waitForFunction(() => ORG && ORG.plan.key === 'firm' && page === 'workspace', null, { timeout: 15000 });
  assert.match(await alice.page.locator('#workspacePage').innerText(), /Firm · Active/);
  assert.match(await alice.page.locator('#workspacePage').innerText(), /People \(paid seats\)\s*2 of 5/);
  assert.equal(new URL(alice.page.url()).search, '');
  log('ok  Stripe checkout and webhook moved the workspace to Firm with 5 seats');

  // ===== Single sign-on =====
  await alice.page.fill('#dm_name', 'capstrat.test'); await alice.page.click('#dmForm .btn');
  await alice.page.click('[data-act=dmVerify]');
  await alice.page.waitForFunction(() => ORG.domain && ORG.domain.verified);
  await alice.page.fill('#ss_provider', 'saml.capstrat'); await alice.page.check('#ss_required'); await alice.page.click('#ssForm .primary');
  await alice.page.waitForFunction(() => ORG.sso && ORG.sso.required && ORG.sso.provider === 'saml.capstrat');
  const dana = await person('Dana', 'google');
  await dana.page.goto(`${BASE}/app`); await dana.page.waitForSelector('.seat', { state: 'attached' });
  await dana.page.click('#acct [data-act=signin]'); await dana.page.click('#drawer details.sect summary');
  await dana.page.fill('#sso_email', 'dana@capstrat.test'); await dana.page.click('#ssoForm .btn');
  await dana.page.click('[data-act=ssoGo]');
  await dana.page.waitForFunction(() => ORG && ORG.name === 'Capitol Strategies' && ORG.role === 'member', null, { timeout: 15000 });
  await bob.page.reload();
  await bob.page.waitForFunction(() => /Capitol Strategies<\/b> requires single sign-on/.test(document.querySelector('#banner').innerHTML), null, { timeout: 15000 });
  log('ok  single sign-on: Dana joined through the firm\'s identity provider; Bob is asked to use it');

  // ===== The Monitor =====
  await alice.page.click('[data-page=monitor]');
  await alice.page.click('[data-x=newWatch]');
  await alice.page.fill('#mw_query', 'broadband'); await alice.page.fill('#mw_pri', 'Rural broadband grants for co-ops'); await alice.page.fill('#mw_states', 'FL');
  await alice.page.click('#mwGo');
  await alice.page.waitForFunction(() => MON.items && MON.items.length === 2 && page === 'monitor', null, { timeout: 20000 });
  const mon = await alice.page.locator('#monitorPage').innerText();
  assert.match(mon, /H\.R\. 1234: Rural Broadband Access Act/); assert.match(mon, /HB 77: Broadband Infrastructure Grants/); assert.match(mon, /Directly about rural broadband grants\./);
  await shot(alice.page, 'monitor', true);
  await alice.page.locator('.item:has-text("H.R. 1234") [data-x=lobbying]').click();
  await alice.page.waitForFunction(() => /Rural Telecom Coalition/.test(document.querySelector('#drawer').textContent));
  assert.match(await alice.page.locator('#drawer').innerText(), /Akin Strategies/);
  await alice.page.keyboard.press('Escape');
  log('ok  Monitor: a watch over Congress and Florida found and scored bills; who is lobbying on H.R. 1234');

  // ===== Custom dropdowns =====
  assert.equal(await alice.page.evaluate(() => [...document.querySelectorAll('select')].filter((x) => !x.closest('.cs')).length), 0, 'every select is custom');
  assert.equal(await alice.page.evaluate(() => [...document.querySelectorAll('.cs')].filter((w) => w.querySelectorAll(':scope > .cs-trigger').length !== 1 || w.querySelector('.cs .cs')).length), 0, 'one button per dropdown, never nested');
  assert.equal(await alice.page.evaluate(() => getComputedStyle(document.querySelector('#mon_kind')).opacity), '0');
  const kindBtn = alice.page.locator('#mon_kind-cs');
  assert.equal(await kindBtn.getAttribute('role'), 'combobox'); assert.equal(await kindBtn.getAttribute('aria-expanded'), 'false');
  await kindBtn.click();
  await alice.page.waitForSelector('.cs-list[role=listbox]:not([hidden])');
  assert.equal(await kindBtn.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await alice.page.locator('.cs-list [role=option]').allInnerTexts(), ['Bills, rules and contracts', 'Bills', 'Regulations', 'Contracts']);
  await alice.page.evaluate(() => { window.__kindBtn = document.querySelector('#mon_kind-cs'); });
  await alice.page.click('.cs-list [role=option]:text-is("Bills")');
  // The Monitor redraws with the filter applied; focus stays on the dropdown
  await alice.page.waitForFunction(() => MON.kind === 'bill' && document.querySelector('#mon_kind-cs') !== window.__kindBtn && document.activeElement && document.activeElement.id === 'mon_kind-cs' && document.querySelector('#mon_kind-cs .cs-value').textContent === 'Bills');
  await alice.page.keyboard.press('Home');
  assert.match(await alice.page.locator('#mon_kind-cs').getAttribute('aria-activedescendant'), /-o0$/);
  await alice.page.keyboard.press('Enter');
  await alice.page.waitForFunction(() => MON.kind === '' && document.querySelector('.cs-list').hidden);
  log('ok  custom dropdowns: combobox and listbox roles, mouse, Home and Enter, and the page sees the change');

  // A campaign from a bill, with the Florida Senate loaded live, and an action page
  await alice.page.locator('.item:has-text("HB 77") [data-x=itemCampaign]').click();
  await alice.page.waitForFunction(() => S.cloud && /^HB 77/.test(S.campaign.bill) && page === 'count');
  await settle(alice.page);
  await alice.page.click('.tools [data-act=setup]');
  await alice.page.click('#drawer summary:has-text("Load any state legislature")');
  await alice.page.selectOption('#os_state', 'FL'); await alice.page.selectOption('#os_chamber', 'upper'); await alice.page.click('[data-x=osRoster]');
  await alice.page.waitForFunction(() => document.querySelector('#s_preset') && document.querySelector('#s_preset').value === 'os-fl-upper');
  await alice.page.click('[data-act=preset]');
  await alice.page.waitForTimeout(300);
  if (await alice.page.locator('[data-act=preset]').isVisible()) await alice.page.click('[data-act=preset]'); // asks again only when it would replace members
  await alice.page.waitForFunction(() => S.members.length === 2 && S.campaign.juris && S.campaign.juris.state === 'FL');
  await settle(alice.page);
  assert.equal(await alice.page.evaluate(() => contact(S.members[0]).email), 'simon.corey@flsenate.gov');
  await alice.page.click('#moreMenu summary'); await alice.page.click('[data-x=actionCenter]');
  await alice.page.waitForSelector('#acForm');
  assert.equal(await alice.page.inputValue('#ac_juris'), 'st-upper'); assert.equal(await alice.page.inputValue('#ac_state'), 'FL');
  await alice.page.click('#acGo');
  await alice.page.waitForFunction(() => ACT.data && ACT.data.action && ACT.data.action.active);
  const actUrl = await alice.page.evaluate(() => ACT.data.action.url);
  const supporter = await person('Supporter', 'google');
  await supporter.page.goto(actUrl);
  await supporter.page.waitForFunction(() => /^Tell your legislators/.test(document.querySelector('#title').textContent));
  // Filled in the way a browser fills a saved address, with an apartment number the Census lookup does not know
  assert.equal(await supporter.page.inputValue('#state'), 'FL', 'the form starts on the campaign state');
  await supporter.page.fill('#street', '100 Main St Apt 2'); await supporter.page.fill('#city', 'Tallahassee'); await supporter.page.fill('#zip', '32301');
  await supporter.page.click('#where button');
  await supporter.page.waitForSelector('#letter:not([hidden])');
  assert.match(await supporter.page.locator('#matched').innerText(), /We found 100 MAIN ST, TALLAHASSEE, FL, 32301/);
  assert.match(await supporter.page.locator('#members').innerText(), /Corey Simon/);
  await supporter.page.fill('#name', 'Pat Voter'); await supporter.page.fill('#email', 'pat@example.net'); await supporter.page.check('#optin');
  await shot(supporter.page, 'action-page', true);
  await supporter.page.click('#sendBtn');
  await supporter.page.waitForSelector('#done:not([hidden])');
  assert.match(await supporter.page.locator('#done').innerText(), /on its way to Corey Simon/);
  const letter = (await outbox()).find((x) => x.kind === 'constituent' && x.to_addr === 'simon.corey@flsenate.gov');
  assert.ok(letter); assert.equal(letter.reply_to, 'pat@example.net');
  await alice.page.keyboard.press('Escape'); await alice.page.click('#moreMenu summary'); await alice.page.click('[data-x=actionCenter]');
  await alice.page.waitForFunction(() => /1 supporter took action/.test(document.querySelector('#drawer').textContent));
  await alice.page.keyboard.press('Escape'); await alice.page.click('[data-page=count]');
  await alice.page.waitForFunction(() => /1 constituent letter/.test(document.querySelector('#rows').textContent));
  log('ok  campaign started from a Monitor bill; Florida Senate loaded live; a supporter found their senator and the letter went out');

  // Keyboard on a whip row: open, type to jump, Enter; Escape closes the list but not the drawer around it
  const rowBtn = alice.page.locator('#rows .cs-trigger').first();
  await rowBtn.focus(); await alice.page.keyboard.press('ArrowDown');
  assert.equal(await rowBtn.getAttribute('aria-expanded'), 'true');
  await alice.page.keyboard.press('y'); await alice.page.keyboard.press('Enter');
  await alice.page.waitForFunction(() => S.members.some((m) => m.pos === 4));
  await settle(alice.page);
  await alice.page.click('.tools [data-act=setup]');
  await alice.page.focus('#s_rule-cs'); await alice.page.keyboard.press('ArrowDown');
  await alice.page.waitForSelector('.cs-list:not([hidden])');
  await alice.page.keyboard.press('Escape');
  assert.equal(await alice.page.evaluate(() => document.querySelector('.cs-list').hidden && !document.querySelector('#drawer').hidden), true);
  await alice.page.keyboard.press('Escape');
  assert.equal(await alice.page.evaluate(() => document.querySelector('#drawer').hidden), true);
  assert.equal(await alice.page.locator('#tForm .cs-trigger').count(), 1, 'the follow-up dropdown is redrawn in place, not stacked');
  log('ok  custom dropdowns by keyboard: type-to-find on a whip row; Escape closes the list before the drawer');

  // ===== Contacts and bulk outreach =====
  await alice.page.click('[data-page=contacts]');
  await alice.page.waitForFunction(() => CRM.contacts !== null);
  await alice.page.click('[data-x=newContact]');
  await alice.page.fill('#ct_name', 'Dana Lee'); await alice.page.fill('#ct_org', 'NTIA'); await alice.page.fill('#ct_email', 'dana@ntia.example'); await alice.page.fill('#ct_tags', 'agency');
  await alice.page.click('#ctForm .primary');
  await alice.page.waitForFunction(() => CRM.contacts.length === 1);
  await alice.page.click('[data-x=importContacts]');
  await alice.page.fill('#im_text', 'name,organization,email,tags\nSam Roe,Gulf Co-op,sam@coop.example,coalition');
  await alice.page.click('#imForm .primary');
  await alice.page.waitForFunction(() => CRM.contacts && CRM.contacts.length === 2);
  await alice.page.keyboard.press('Escape');
  await alice.page.check('#ct_all'); await alice.page.click('[data-x=bulkMail]');
  await alice.page.fill('#bm_subject', 'Coalition letter for {organization}');
  const sentBefore = alice.rec.filter((x) => x.who === 'gmail').length;
  await alice.page.click('#bmGo');
  await alice.page.waitForFunction(() => /2 emails sent and logged/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
  const sends = alice.rec.filter((x) => x.who === 'gmail').slice(sentBefore);
  assert.equal(sends.length, 2);
  const bulkRaw = Buffer.from(JSON.parse(sends[0].body).raw, 'base64url').toString();
  assert.match(bulkRaw, /Subject: Coalition letter for (NTIA|Gulf Co-op)/);
  await alice.page.waitForFunction(() => CRM.contacts && CRM.contacts.every((c) => c.lastTouch));
  await alice.page.click('[data-x=openContact] >> nth=0');
  await alice.page.waitForFunction(() => /Coalition letter for/.test(document.querySelector('#ctTimeline').textContent));
  await alice.page.keyboard.press('Escape');
  await shot(alice.page, 'contacts', true);
  log('ok  contacts: added, imported, emailed one by one from Gmail, and logged on each contact');

  // ===== Installable =====
  const mf = await fetch(`${BASE}/manifest.webmanifest`);
  assert.match(mf.headers.get('content-type'), /manifest\+json/); assert.equal((await mf.json()).start_url, '/app');
  assert.equal((await fetch(`${BASE}/sw.js`)).status, 200);
  log('ok  installable: manifest and offline service worker');

  // Carol deletes her account
  await carol.page.click('#acct [data-act=account]'); await carol.page.click('#drawer details.sect summary:has-text("Delete my account")'); await carol.page.click('[data-act=delAccount]'); await carol.page.click('[data-act=delAccount]');
  await carol.page.waitForFunction(() => ME === null);
  log('ok  Carol deleted her account');

  // ===== The website =====
  const visitor = await person('Visitor', 'google');
  await visitor.page.goto(`${BASE}/`);
  assert.match(await visitor.page.locator('h1').innerText(), /Know the count/);
  await shot(visitor.page, 'site-home', true);
  await visitor.page.fill('form.lead [name=name]', 'Pat Lee'); await visitor.page.fill('form.lead [name=email]', 'pat@leepartners.example');
  await visitor.page.fill('form.lead [name=firm]', 'Lee Partners'); await visitor.page.click('form.lead button[type=submit]');
  await visitor.page.waitForFunction(() => /Thank you/.test(document.querySelector('form.lead .status').textContent));
  assert.ok((await outbox()).some((x) => x.kind === 'lead' && x.to_addr === 'sales@headcount.test'));
  await visitor.page.goto(`${BASE}/pricing`); await shot(visitor.page, 'site-pricing', true);
  assert.match(await visitor.page.locator('table.plans').innerText(), /Sign in through your firm's own login page/);
  await visitor.page.setViewportSize({ width: 390, height: 844 });
  for (const pg of ['/', '/pricing', '/security', '/privacy', '/terms']) {
    await visitor.page.goto(BASE + pg);
    assert.equal(await visitor.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll on ${pg}`);
  }
  await visitor.page.goto(`${BASE}/`); await shot(visitor.page, 'site-phone');
  log('ok  website pages, demo request and phone layout');

  // Layout checks
  await alice.page.setViewportSize({ width: 390, height: 844 });
  for (const pg of ['count', 'brief', 'portfolio', 'monitor', 'contacts', 'workspace']) {
    await alice.page.click(`[data-page=${pg}]`);
    assert.equal(await alice.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll on ${pg}`);
  }
  await alice.page.click('[data-page=count]');
  await alice.page.locator('#rows .cs-trigger').last().click();
  const box = await alice.page.locator('.cs-list').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, `dropdown list fits the phone screen: ${JSON.stringify(box)}`);
  await shot(alice.page, 'phone-dropdown');
  await alice.page.keyboard.press('Escape');
  await shot(alice.page, 'phone');
  await alice.page.setViewportSize({ width: 1280, height: 950 });
  await alice.page.emulateMedia({ colorScheme: 'dark' }); await shot(alice.page, 'dark');
  log('ok  phone width and dark mode');

  assert.deepEqual(errors, []);
  log('\nAll end-to-end checks passed.');
} catch (e) {
  console.error('FAILED:', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
  if (errors.length) console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close(); server.kill(); mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
