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

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.env.SHOTS || '';
const log = (...a) => console.log(...a);
const flat = (s) => s.replace(/\s*\n+\s*/g, ' | ');

// ---------- stand-ins for Congress.gov and Claude ----------
const draft = { plainSummary: 'Funds rural broadband grants.', keyProvisions: ['Creates a grant program.', 'Caps grants at 60 percent.'], whoItAffects: 'Rural households and providers.', fiscalImpact: 'Not stated in the material.', talkingPoints: ['Closes the rural gap.', 'Providers share the cost.'], objections: [{ objection: 'Too costly', response: 'Grants are capped.' }], needsChecking: ['Program cost'] };
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/v3/bill/119/hr/1234') return j(200, { bill: { title: 'Rural Broadband Access Act', introducedDate: '2025-03-04', sponsors: [{ fullName: 'Rep. Smith, Ann [D-IA-2]', party: 'D', state: 'IA', district: 2 }], cosponsors: { count: 12 }, latestAction: { actionDate: '2025-06-01', text: 'Referred to the Subcommittee on Communications and Technology.' } } });
    if (u.pathname === '/v3/bill/119/hr/1234/summaries') return j(200, { summaries: [{ actionDate: '2025-03-04', actionDesc: 'Introduced in House', text: '<p>This bill creates grants for rural broadband.</p>' }] });
    if (u.pathname === '/v3/bill/119/hr/1234/committees') return j(200, { committees: [{ name: 'Energy and Commerce Committee' }] });
    if (u.pathname === '/v1/messages') return j(200, { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    j(404, {});
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const M = `http://127.0.0.1:${mock.address().port}`;

// ---------- the app ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headcount-e2e-'));
const port = 3400 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AUTH_MODE: 'dev', NODE_ENV: 'test', CONGRESS_API_KEY: 'k', CONGRESS_API_BASE: `${M}/v3`, ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: M },
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('Headcount on')) resolve(); }));
const BASE = `http://localhost:${port}`;

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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
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

  // ===== Alice signs in with Google; the example becomes an account campaign =====
  const alice = await person('Alice', 'google');
  await alice.page.goto(BASE); await alice.page.waitForSelector('.seat');
  await signIn(alice);
  await alice.page.locator('#rows select[data-pos]').first().selectOption('3');
  await settle(alice.page);
  assert.equal(await alice.page.evaluate(() => S.cloud), true);
  assert.match(await alice.page.locator('#saveState').innerText(), /Saved to your account/);
  log('ok  first edit after sign-in saves the campaign to the account');

  // Bill brief: look up, draft, print view
  await alice.page.click('[data-page=brief]');
  await alice.page.click('[data-act=briefLookup]');
  await alice.page.selectOption('#lk_j', 'US'); await alice.page.fill('#lk_n', 'H.R. 1234'); await alice.page.fill('#lk_s', '119');
  await alice.page.click('#lkForm .primary');
  await alice.page.waitForSelector('#lkForm .primary:has-text("clear the old analysis")');
  await alice.page.click('#lkForm .primary');
  await alice.page.waitForFunction(() => S.brief.number === 'H.R. 1234' && !S.brief.supporters);
  assert.doesNotMatch(await alice.page.locator('.brief').innerText(), /\(D-IA-2\)/);
  assert.match(await alice.page.locator('.brief').innerText(), /Referred to the Subcommittee on Communications and Technology/);
  await alice.page.click('[data-act=briefDraft]');
  await alice.page.fill('#df_text', 'Section 2. The Secretary shall award grants.');
  assert.equal(await alice.page.locator('#dfGo').innerText(), 'Draft it');
  await alice.page.click('#dfGo');
  await alice.page.waitForFunction(() => S.brief.plainSummary === 'Funds rural broadband grants.');
  const briefTxt = await alice.page.locator('.brief').innerText();
  assert.match(briefTxt, /Talking points/); assert.match(briefTxt, /Too costly/); assert.match(briefTxt, /drafted with Claude/);
  await shot(alice.page, 'brief', true);
  await alice.page.emulateMedia({ media: 'print' }); await shot(alice.page, 'brief-print', true);
  assert.equal(await alice.page.locator('.brieftools').isVisible(), false);
  await alice.page.emulateMedia({ media: 'screen' });
  log('ok  bill brief: lookup from Congress.gov, drafted analysis, print layout');

  // Request by Gmail with times from Google Calendar
  await alice.page.click('[data-page=count]');
  await alice.page.locator('#calls .who').first().click();
  const memberName = await alice.page.locator('#drawer h2').innerText();
  await alice.page.click('[data-tab=staff]'); await alice.page.click('[data-act=addStaff]');
  await alice.page.fill('#st_name', 'Jamie Ortiz'); await alice.page.fill('#st_role', 'Scheduler'); await alice.page.fill('#st_email', 'jamie@senate.example.gov'); await alice.page.click('#stForm .primary');
  await alice.page.locator('[data-act=rq][data-sid]').click();
  await alice.page.click('[data-act=rqFind]');
  await alice.page.waitForFunction(() => /Offering/.test(document.querySelector('#rqMsg').textContent));
  const t0 = new Date(await alice.page.inputValue('#rq_t0')), tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.ok(!(t0.toDateString() === tomorrow.toDateString() && t0.getHours() < 13), 'first offer avoids the busy morning');
  assert.match(await alice.page.inputValue('#rq_body'), /H\.R\. 1234 \(Rural Broadband Access Act\)/);
  await shot(alice.page, 'request');
  await alice.page.click('[data-act=rqSend]');
  await alice.page.waitForFunction(() => S.meetings.some((x) => x.status === 'requested'));
  const sent = alice.rec.find((r) => r.who === 'gmail');
  const raw = JSON.parse(sent.body).raw, mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /^To: jamie@senate\.example\.gov\r\n/); assert.match(mime, /Subject: Meeting request: H\.R\. 1234/);
  const text = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text, /^Hi Jamie,/); assert.match(text, /Would one of these times work\?/);
  assert.match(text, /I'm Alice\./); assert.match(text, /Thank you,\r?\nAlice/);
  log('ok  meeting request sent from Gmail with open times from Google Calendar');

  // They replied: book a time and send a real invitation
  await alice.page.click('[data-act=close]');
  await alice.page.locator('#meets [data-act=bookTime]').click();
  await alice.page.check('#rq_video');
  await alice.page.click('[data-act=rqInvite]');
  await alice.page.waitForFunction(() => S.meetings.some((x) => x.status === 'invited' && x.eventId === 'gev1'));
  const ins = alice.rec.find((r) => r.who === 'google' && r.method === 'POST');
  assert.match(ins.url, /sendUpdates=all/); assert.match(ins.url, /conferenceDataVersion=1/);
  const ev = JSON.parse(ins.body);
  assert.deepEqual(ev.attendees, [{ email: 'jamie@senate.example.gov' }]); assert.equal(ev.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  alice.rec.start = ev.start.dateTime; alice.rec.end = ev.end.dateTime;
  await alice.page.keyboard.press('Escape');
  assert.match(await alice.page.locator('#meets').innerText(), /No reply yet/);
  await alice.page.click('[data-act=checkReplies]');
  await alice.page.waitForFunction(() => /Accepted/.test(document.querySelector('#meets').textContent));
  assert.equal(await alice.page.evaluate(() => S.meetings.filter((x) => x.status === 'requested').length), 0, 'request became the invitation');
  await shot(alice.page, 'agenda');
  log('ok  invitation sent from Google Calendar with a Meet link; reply shows as Accepted');

  // Invite teammates
  await alice.page.click('.tools [data-act=setup]');
  await alice.page.waitForSelector('#teamBody .people');
  await alice.page.selectOption('#inv_role', 'editor'); await alice.page.click('[data-act=mkInvite]');
  await alice.page.waitForSelector('#inv_for:has-text("an editor")');
  const editorLink = await alice.page.inputValue('#inv_link');
  await alice.page.selectOption('#inv_role', 'viewer'); await alice.page.click('[data-act=mkInvite]');
  await alice.page.waitForSelector('#inv_for:has-text("a viewer")');
  const viewerLink = await alice.page.inputValue('#inv_link');
  await alice.page.keyboard.press('Escape');
  await settle(alice.page);

  // ===== Bob joins with Microsoft and works the same count =====
  const bob = await person('Bob', 'microsoft');
  await bob.page.goto(editorLink); await bob.page.waitForSelector('.seat');
  assert.match(await bob.page.locator('#banner').innerText(), /Alice invited you to work on .* as an editor/);
  await signIn(bob);
  await bob.page.waitForFunction(() => S.cloud && S.members.length === 41 && S.brief.number === 'H.R. 1234');
  assert.equal(new URL(bob.page.url()).pathname, '/');
  const before = await alice.page.locator('#odds').innerText();
  await bob.page.locator('#rows select[data-pos]').nth(25).selectOption('4');
  await settle(bob.page);
  await alice.page.waitForFunction((o) => document.querySelector('#odds').textContent !== o, before, { timeout: 15000 });
  log('ok  Bob joined with an invite link; his change reached Alice');

  // Bob requests and books through Outlook
  await bob.page.fill('#q', memberName); await bob.page.locator('#rows .who').first().click();
  await bob.page.click('[data-act=rq]');
  await bob.page.click('[data-act=rqFind]'); await bob.page.waitForFunction(() => /Offering/.test(document.querySelector('#rqMsg').textContent));
  await bob.page.click('[data-act=rqSend]');
  await bob.page.waitForFunction(() => S.meetings.filter((x) => x.status === 'requested').length === 1);
  const mail = bob.rec.find((r) => r.who === 'graph' && r.url.endsWith('/sendMail'));
  const msg = JSON.parse(mail.body).message;
  assert.equal(msg.toRecipients[0].emailAddress.address, 'jamie@senate.example.gov'); assert.match(msg.body.content, /^Hi Jamie,/);
  assert.ok(bob.rec.find((r) => r.url.includes('/calendarView')).prefer.includes('UTC'));
  await bob.page.click('[data-act=close]');
  await bob.page.locator('#meets [data-act=bookTime]').click();
  await bob.page.click('[data-act=rqInvite]');
  await bob.page.waitForFunction(() => S.meetings.some((x) => x.eventId === 'msev1'));
  const mev = JSON.parse(bob.rec.find((r) => r.who === 'graph' && r.method === 'POST' && r.url.endsWith('/events')).body);
  assert.equal(mev.attendees[0].emailAddress.address, 'jamie@senate.example.gov'); assert.equal(mev.start.timeZone, 'UTC'); assert.equal(mev.onlineMeetingProvider, 'teamsForBusiness');
  await settle(bob.page);
  await alice.page.waitForFunction(() => S.meetings.some((x) => x.eventId === 'msev1'), null, { timeout: 15000 });
  await alice.page.waitForFunction(() => /On a teammate's calendar/.test(document.querySelector('#meets').textContent), null, { timeout: 5000 });
  log('ok  Bob sent a request and an invitation through Outlook; Alice sees both');

  // ===== Carol can only look =====
  const carol = await person('Carol', 'google');
  await carol.page.goto(viewerLink); await carol.page.waitForSelector('.seat');
  await signIn(carol);
  await carol.page.waitForFunction(() => S.cloud && S.members.length === 41);
  assert.match(await carol.page.locator('#warn').innerText(), /view-only/);
  assert.equal(await carol.page.locator('[data-act=addMember]').count() > 0, true);
  await carol.page.locator('#calls .who').first().click();
  assert.equal(await carol.page.locator('#drawer [data-act=rq]').count(), 0);
  assert.equal(await carol.page.locator('#drawer select[data-pos]').isDisabled(), true);
  await carol.page.keyboard.press('Escape');
  log('ok  Carol joined as a viewer and cannot change anything');

  // Cancel the Google meeting; the cancellation goes to the attendee
  const n0 = alice.rec.length;
  await alice.page.locator('#meets li', { hasText: 'Accepted' }).locator('[data-act=cancelMeet]').click();
  await alice.page.locator('#meets li', { hasText: 'Accepted' }).locator('[data-act=cancelMeet]').click();
  await alice.page.waitForFunction(() => S.meetings.some((x) => x.eventId === 'gev1' && x.status === 'cancelled'));
  const del = alice.rec.slice(n0).find((r) => r.method === 'DELETE');
  assert.match(del.url, /gev1\?sendUpdates=all/);
  log('ok  cancelling a meeting withdraws the calendar invitation');

  // Team list, role change, account deletion
  await alice.page.click('.tools [data-act=setup]'); await alice.page.waitForSelector('#teamBody .people');
  assert.match(await alice.page.locator('#teamBody').innerText(), /Bob[\s\S]*Carol/);
  await alice.page.keyboard.press('Escape');
  await carol.page.click('#acct [data-act=account]'); await carol.page.click('#drawer details.sect summary'); await carol.page.click('[data-act=delAccount]'); await carol.page.click('[data-act=delAccount]');
  await carol.page.waitForFunction(() => ME === null);
  log('ok  team list shows everyone; Carol deleted her account');

  // Layout checks
  await alice.page.setViewportSize({ width: 390, height: 844 });
  for (const pg of ['count', 'brief']) {
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
