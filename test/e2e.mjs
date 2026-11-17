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
    if (u.pathname === '/v1/messages') return j(200, { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    if (u.pathname === '/v1/customers') return j(200, { id: 'cus_e2e' });
    if (u.pathname === '/v1/checkout/sessions') { const f = new URLSearchParams(body); stripeState.org = f.get('client_reference_id'); stripeState.seats = +f.get('line_items[0][quantity]'); stripeState.success = f.get('success_url'); return j(200, { id: 'cs_e2e', url: `${M}/checkout` }); }
    if (u.pathname === '/v1/subscriptions/sub_e2e') return j(200, { id: 'sub_e2e', customer: 'cus_e2e', status: 'active', metadata: { org_id: stripeState.org }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ id: 'si_e2e', quantity: stripeState.seats, price: { id: 'price_team' } }] } });
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
    STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_e2e', STRIPE_PRICE_TEAM: 'price_team', STRIPE_API_BASE: M, PUBLIC_URL: BASE, PRICE_LABEL_TEAM: 'per seat, monthly' },
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
const settle = (page) => page.waitForFunction(() => !SYNC.busy && !SYNC.timer && !SYNC.creating && !SYNC.loading, null, { timeout: 20000 });
const shot = async (page, name, full) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: Boolean(full) }); };

try {
  // ===== Signed out: everything works in the browser =====
  const guest = await person('Guest', 'google');
  await guest.page.goto(BASE); await guest.page.waitForSelector('.seat');
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
  await alice.page.goto(BASE); await alice.page.waitForSelector('.seat');
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
  await Promise.all([alice.page.waitForURL(`${M}/checkout`), alice.page.click('[data-act=billCheckout][data-plan=team]')]);
  assert.equal(stripeState.seats, 5);
  await stripeHook({ id: 'evt_e2e', type: 'checkout.session.completed', data: { object: { client_reference_id: stripeState.org, customer: 'cus_e2e', subscription: 'sub_e2e' } } });
  await alice.page.goto(stripeState.success);
  await alice.page.waitForFunction(() => ORG && ORG.plan.key === 'team' && page === 'workspace', null, { timeout: 15000 });
  assert.match(await alice.page.locator('#workspacePage').innerText(), /Team · Active/);
  assert.match(await alice.page.locator('#workspacePage').innerText(), /People using seats\s*2 of 5/);
  assert.equal(new URL(alice.page.url()).search, '');
  log('ok  Stripe checkout and webhook moved the workspace to Team with 5 seats');

  // Carol deletes her account
  await carol.page.click('#acct [data-act=account]'); await carol.page.click('#drawer details.sect summary'); await carol.page.click('[data-act=delAccount]'); await carol.page.click('[data-act=delAccount]');
  await carol.page.waitForFunction(() => ME === null);
  log('ok  Carol deleted her account');

  // Layout checks
  await alice.page.setViewportSize({ width: 390, height: 844 });
  for (const pg of ['count', 'brief', 'portfolio', 'workspace']) {
    await alice.page.click(`[data-page=${pg}]`);
    assert.equal(await alice.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no sideways scroll on ${pg}`);
  }
  await alice.page.click('[data-page=count]'); await shot(alice.page, 'phone');
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
