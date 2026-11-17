import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stand-ins for Google's signing keys, Congress.gov, Open States, Stripe and the Claude API.
const mocks = { claude: [], claudeReply: null, stripe: [], sub: null, fedStatus: 'Referred to the Subcommittee on Communications.', scored: [], geo: [] };
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fixtures = {
  '/v3/bill/119/hr/1234': { bill: { title: 'Rural Broadband Access Act', introducedDate: '2025-03-04', sponsors: [{ fullName: 'Rep. Smith, Ann [D-IA-2]', party: 'D', state: 'IA', district: 2 }], cosponsors: { count: 12 }, latestAction: { actionDate: '2025-06-01', text: 'Referred to the Subcommittee on Communications.' }, policyArea: { name: 'Science, Technology, Communications' } } },
  '/v3/bill/119/hr/1234/summaries': { summaries: [{ actionDate: '2025-03-04', actionDesc: 'Introduced in House', updateDate: '2025-04-01', text: '<p>This bill expands <b>grants</b> for rural broadband &amp; requires reports.</p>' }] },
  '/v3/bill/119/hr/1234/committees': { committees: [{ name: 'Energy and Commerce Committee' }] },
  '/bills': { results: [{ identifier: 'HB 123', title: 'Property Insurance', session: '2026', first_action_date: '2026-01-13', latest_action_date: '2026-03-01', latest_action_description: 'Passed House', openstates_url: 'https://openstates.org/fl/bills/2026/HB123/', abstracts: [{ abstract: 'Revises property insurance requirements.' }], sponsorships: [{ name: 'Jane Doe', primary: true, person: { party: 'Republican', current_role: { district: '12' } } }, { name: 'Co Sponsor', primary: false }], actions: [{ date: '2026-02-01', related_entities: [{ entity_type: 'organization', name: 'Insurance & Banking Subcommittee' }] }], subject: ['Insurance'] }] },
};
const subscription = (orgId, qty, status = 'active') => ({ id: 'sub_1', object: 'subscription', customer: 'cus_1', status, metadata: { org_id: orgId }, current_period_end: 1900000000, items: { data: [{ id: 'si_1', quantity: qty, price: { id: 'price_team' } }] } });
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/jwks') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' }); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (u.pathname === '/v1/messages') { mocks.claude.push({ headers: req.headers, body: JSON.parse(body) }); return j(200, mocks.claudeReply); }
    if (u.pathname.startsWith('/v1/')) {
      mocks.stripe.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, form: new URLSearchParams(body) });
      if (u.pathname === '/v1/customers') return j(200, { id: 'cus_1' });
      if (u.pathname === '/v1/checkout/sessions') return j(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
      if (u.pathname === '/v1/billing_portal/sessions') return j(200, { url: 'https://billing.stripe.com/p/session/1' });
      if (u.pathname === '/v1/subscriptions/sub_1') return j(200, mocks.sub);
      return j(404, { error: { message: 'no' } });
    }
    if (u.pathname.startsWith('/v3/') && req.headers['x-api-key'] !== 'cg-key') return j(403, {});
    // Monitor, intelligence and action center sources
    if (u.pathname === '/v3/bill') return j(200, { bills: [
      { congress: 119, type: 'HR', number: '1234', title: 'Rural Broadband Access Act', latestAction: { actionDate: '2026-11-16', text: mocks.fedStatus }, updateDate: '2026-11-16T10:00:00Z' },
      { congress: 119, type: 'S', number: '99', title: 'Highway Funding Act', latestAction: { actionDate: '2026-11-15', text: 'Introduced.' }, updateDate: '2026-11-15T10:00:00Z' },
    ] });
    if (u.pathname === '/bills' && u.searchParams.get('q') && req.headers['x-api-key'] === 'os-key') return j(200, { results: [{ id: 'ocd-bill/fl77', identifier: 'HB 77', title: 'Broadband Infrastructure Grants', session: '2026', jurisdiction: { id: 'ocd-jurisdiction/country:us/state:fl/government', name: 'Florida' }, latest_action_description: 'Filed', latest_action_date: '2026-11-10', updated_at: '2026-11-10T00:00:00', openstates_url: 'https://openstates.org/fl/bills/2026/HB77/' }] });
    if (u.pathname === '/people' && req.headers['x-api-key'] === 'os-key') return j(200, { pagination: { max_page: 1 }, results: [
      { id: 'ocd-person/aaaa-1111', name: 'Corey Simon', party: 'Republican', current_role: { district: '3', org_classification: 'upper' }, email: 'simon.corey@flsenate.gov', openstates_url: 'https://openstates.org/person/corey-simon/', offices: [{ classification: 'capitol', address: '404 S. Monroe St., Tallahassee, FL 32399', voice: '850-487-5003' }, { classification: 'district', address: '1 Main St, Tallahassee, FL', voice: '850-555-0100' }] },
      { id: 'ocd-person/bbbb-2222', name: 'Ana Ruiz', party: 'Democratic', current_role: { district: '12', org_classification: 'upper' }, email: '', offices: [] },
    ] });
    if (u.pathname === '/fr/documents.json') return j(200, { results: [{ document_number: '2026-12345', title: 'Broadband Equity Program Requirements', type: 'Proposed Rule', abstract: 'Proposes requirements for broadband grant recipients.', html_url: 'https://www.federalregister.gov/d/2026-12345', publication_date: '2026-11-12', agencies: [{ name: 'National Telecommunications and Information Administration' }], comments_close_on: '2027-01-12', docket_ids: ['NTIA-2026-0001'] }] });
    if (u.pathname === '/sam/opportunities/v2/search') {
      if (u.searchParams.get('api_key') !== 'sam-key') return j(403, {});
      return j(200, { opportunitiesData: [{ noticeId: 'abc123', title: 'Rural Broadband Network Services', solicitationNumber: 'RUS-26-001', fullParentPathName: 'AGRICULTURE, DEPARTMENT OF.RURAL UTILITIES SERVICE', type: 'Solicitation', postedDate: '2026-11-14', responseDeadLine: '2026-12-15T17:00:00-05:00', naicsCode: '517111', typeOfSetAsideDescription: 'Total Small Business', uiLink: 'https://sam.gov/opp/abc123/view', active: 'Yes' }] });
    }
    if (u.pathname === '/lda/filings/') return j(200, { results: [
      { filing_uuid: 'f1', filing_year: 2026, filing_period_display: '3rd Quarter (Jul 1 - Sep 30)', income: '50000.00', registrant: { name: 'Akin Strategies' }, client: { name: 'Rural Telecom Coalition' }, lobbying_activities: [{ description: 'H.R.1234, Rural Broadband Access Act', government_entities: [{ name: 'HOUSE OF REPRESENTATIVES' }] }], filing_document_url: 'https://lda.gov/filings/f1/', dt_posted: '2026-10-20T10:00:00' },
      { filing_uuid: 'f2', filing_year: 2026, filing_period_display: '3rd Quarter', income: '10000.00', registrant: { name: 'Other LLC' }, client: { name: 'Unrelated Co' }, lobbying_activities: [{ description: 'H.R. 12345, something else' }], dt_posted: '2026-10-21T10:00:00' },
    ] });
    if (u.pathname === '/usa/search/spending_by_category/recipient/') return j(200, { results: [{ name: 'ACME NETWORKS', amount: 3000000 }, { name: 'BETA FIBER', amount: 1000000 }] });
    if (u.pathname === '/geo/geographies/onelineaddress') {
      mocks.geo.push(u.searchParams.get('address'));
      if (/nowhere/i.test(u.searchParams.get('address'))) return j(200, { result: { addressMatches: [] } });
      return j(200, { result: { addressMatches: [{ matchedAddress: '100 MAIN ST, TALLAHASSEE, FL, 32301', geographies: { States: [{ STUSAB: 'FL', STATE: '12' }], '119th Congressional Districts': [{ CD119: '02', BASENAME: '2', STATE: '12' }], '2024 State Legislative Districts - Upper': [{ SLDU: '003', BASENAME: '3', STATE: '12' }], '2024 State Legislative Districts - Lower': [{ SLDL: '008', BASENAME: '8', STATE: '12' }] } }] } });
    }
    if (u.pathname === '/bills') {
      if (req.headers['x-api-key'] !== 'os-key') return j(401, {});
      const hit = u.searchParams.get('identifier') === 'HB 123' && u.searchParams.get('jurisdiction') === 'ocd-jurisdiction/country:us/state:fl/government';
      return j(200, hit ? fixtures['/bills'] : { results: [] });
    }
    const f = fixtures[u.pathname]; j(f ? 200 : 404, f || {});
  });
});

const txt = new Map();
let base, server, store, mods;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const m = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, {
    AUTH_MODE: 'dev', CONGRESS_API_KEY: 'cg-key', CONGRESS_API_BASE: `${m}/v3`, OPENSTATES_API_KEY: 'os-key', OPENSTATES_API_BASE: m, FIREBASE_JWKS_URL: `${m}/jwks`,
    ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: m,
    FEDREG_API_BASE: `${m}/fr`, SAM_API_KEY: 'sam-key', SAM_API_BASE: `${m}/sam`, LDA_API_BASE: `${m}/lda`, USASPENDING_API_BASE: `${m}/usa`, GEOCODER_BASE: `${m}/geo`, MONITOR: 'off',
    STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1', STRIPE_PRICE_TEAM: 'price_team', STRIPE_API_BASE: m, PUBLIC_URL: 'https://app.example.org', TRIAL_SEATS: '3', SALES_EMAIL: 'sales@headcount.test',
  });
  mods = { db: await import('../server/db.js'), auth: await import('../server/auth.js'), bills: await import('../server/bills.js'), ai: await import('../server/ai.js'), index: await import('../server/index.js'), config: (await import('../server/config.js')).config };
  store = mods.db.openDb(':memory:', mods.config);
  const score = async ({ items }) => { mocks.scored.push(...items); return items.map((i) => ({ id: i.id, score: /broadband/i.test(i.title) ? 92 : 15, reason: /broadband/i.test(i.title) ? 'Directly about rural broadband.' : 'Not about broadband.' })); };
  server = mods.index.createServer({ store, keyFile: null, backupDir: null, draft: (x) => mods.ai.draftBrief(x), score, resolveTxt: async (d) => { if (!txt.has(d)) throw new Error('ENOTFOUND'); return txt.get(d); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

const tok = (id, extra = {}) => 'dev.' + Buffer.from(JSON.stringify({ id, name: id[0].toUpperCase() + id.slice(1), email: `${id}@${extra.domain || 'example.org'}`, ...extra })).toString('base64url');
async function api(who, method, p, body, extra) {
  const res = await fetch(base + p, { method, headers: { ...(who ? { Authorization: 'Bearer ' + tok(who, extra) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const ok = (r) => { assert.ok(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

// ---------- sign-in ----------
function signJwt(payload, kid = 'k1', key = privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
test('Identity Platform tokens are verified: signature, project, expiry', async () => {
  const t = Math.floor(Date.now() / 1000), opts = { projectId: 'proj-1', jwksUrl: process.env.FIREBASE_JWKS_URL };
  const good = { aud: 'proj-1', iss: 'https://securetoken.google.com/proj-1', sub: 'uid42', iat: t - 10, exp: t + 3000, auth_time: t - 10, email: 'a@b.org', email_verified: true, name: 'Ann', firebase: { sign_in_provider: 'microsoft.com' } };
  assert.deepEqual(await mods.auth.verifyFirebaseToken(signJwt(good), opts), { id: 'fb:uid42', email: 'a@b.org', emailVerified: true, name: 'Ann', provider: 'microsoft' });
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt({ ...good, aud: 'other' }), opts), /different project/);
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt({ ...good, exp: t - 600 }), opts), /expired/);
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt(good, 'k1', crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), opts), /signature/);
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt(good, 'nope'), opts), /unknown key/);
  const parts = signJwt(good).split('.'); parts[1] = Buffer.from(JSON.stringify({ ...good, sub: 'someone-else' })).toString('base64url');
  await assert.rejects(mods.auth.verifyFirebaseToken(parts.join('.'), opts), /signature/);
  assert.equal((await api(null, 'GET', '/api/workspaces')).status, 401);
});

// ---------- workspaces, roles and visibility ----------
let W, C1, C2, memberLink, guestLink;
test('a workspace starts on a trial; campaigns sync by cursor', async () => {
  const w = ok(await api('alice', 'POST', '/api/workspaces', { name: 'Capitol Strategies' })); W = w.id;
  const info = ok(await api('alice', 'GET', `/api/workspaces/${W}`));
  assert.equal(info.plan.key, 'trial'); assert.equal(info.plan.seats, 3); assert.equal(info.role, 'owner'); assert.ok(info.plan.trialEnds > Date.now());
  const client = ok(await api('alice', 'POST', `/api/workspaces/${W}/clients`, { name: 'Prairie Co-ops' }));
  C1 = 'camp1'; ok(await api('alice', 'POST', '/api/campaigns', { id: C1, workspaceId: W, name: 'SB 214', clientId: client.id }));
  const w1 = ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [
    { kind: 'meta', data: { campaign: { bill: 'SB 214: Broadband', clientId: client.id, chamber: 'State Senate' } } },
    { kind: 'members', id: 'm1', data: { name: 'Vega', party: 'D', district: '4', pos: 2, history: [{ d: '2026-02-10', type: 'Meeting', who: 'Jamie', from: 2, to: 3, note: 'Good meeting', by: 'dev:alice' }, { d: '2026-02-11', type: 'Count update', from: 3, to: 4 }] } },
    { kind: 'members', id: 'm2', data: { name: 'Lind', pos: 4, history: [{ d: '2026-05-02', type: 'Call', from: 4, to: 4, by: 'dev:alice' }] } },
    { kind: 'summary', data: { odds: 0.62, yes: 18 } },
  ] }));
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [{ kind: 'members', id: 'm2', data: null }] }));
  const delta = ok(await api('alice', 'GET', `/api/campaigns/${C1}/records?since=${w1.cursor}`));
  assert.deepEqual(delta.records.map((r) => [r.id, r.data]), [['m2', null]]);
  const list = ok(await api('alice', 'GET', `/api/workspaces/${W}/campaigns`)).campaigns;
  assert.deepEqual([list[0].name, list[0].client, list[0].summary.odds, list[0].visibility], ['SB 214: Broadband', 'Prairie Co-ops', 0.62, 'org']);
});

test('members see open campaigns; closed campaigns only by invitation; guests only what they were given', async () => {
  memberLink = ok(await api('alice', 'POST', `/api/workspaces/${W}/invites`, { role: 'member' })).code;
  const preview = ok(await api(null, 'GET', `/api/workspace-invites/${memberLink}`));
  assert.deepEqual([preview.workspace, preview.role, preview.invitedBy], ['Capitol Strategies', 'member', 'Alice']);
  ok(await api('bob', 'POST', `/api/workspace-invites/${memberLink}`));
  C2 = 'camp2'; ok(await api('alice', 'POST', '/api/campaigns', { id: C2, workspaceId: W, name: 'Closed one', visibility: 'team' }));
  assert.deepEqual(ok(await api('bob', 'GET', `/api/workspaces/${W}/campaigns`)).campaigns.map((c) => [c.id, c.role]), [[C1, 'editor']]);
  assert.equal((await api('bob', 'GET', `/api/campaigns/${C2}/records?since=0`)).status, 404);
  assert.equal(ok(await api('bob', 'POST', `/api/campaigns/${C1}/records`, { ops: [{ kind: 'members', id: 'm3', data: { name: 'New' } }] })).cursor > 0, true);
  // A guest arrives through a campaign link and sees only that campaign.
  guestLink = ok(await api('alice', 'POST', `/api/campaigns/${C2}/invites`, { role: 'viewer' })).code;
  assert.equal(ok(await api(null, 'GET', `/api/invites/${guestLink}`)).workspace, 'Capitol Strategies');
  assert.equal(ok(await api('gina', 'POST', `/api/invites/${guestLink}`)).role, 'viewer');
  assert.deepEqual(ok(await api('gina', 'GET', `/api/workspaces/${W}/campaigns`)).campaigns.map((c) => c.id), [C2]);
  assert.equal((await api('gina', 'POST', `/api/campaigns/${C2}/records`, { ops: [{ kind: 'members', id: 'x', data: {} }] })).status, 403);
  assert.equal((await api('gina', 'GET', `/api/workspaces/${W}/members`)).status, 403);
  assert.equal((await api('gina', 'POST', '/api/campaigns', { id: 'g1', workspaceId: W, name: 'x' })).status, 403);
  // Members cannot manage the workspace; admins see everything.
  assert.equal((await api('bob', 'POST', `/api/workspaces/${W}/invites`, { role: 'member' })).status, 403);
  ok(await api('alice', 'PATCH', `/api/workspaces/${W}/members/dev:bob`, { role: 'admin' }));
  assert.equal(ok(await api('bob', 'GET', `/api/workspaces/${W}/campaigns`)).campaigns.length, 2);
  const people = ok(await api('alice', 'GET', `/api/workspaces/${W}/members`)).members;
  assert.deepEqual(people.map((p) => [p.name, p.role]), [['Alice', 'owner'], ['Bob', 'admin'], ['Gina', 'guest']]);
  assert.equal((await api('bob', 'DELETE', `/api/workspaces/${W}/members/dev:alice`)).status, 403);
  assert.equal((await api('alice', 'DELETE', `/api/workspaces/${W}/members/dev:alice`)).status, 400);
});

test('email-addressed invitations only work for that person', async () => {
  const inv = ok(await api('alice', 'POST', `/api/workspaces/${W}/invites`, { role: 'member', email: 'cara@example.org' }));
  const wrong = await api('dan', 'POST', `/api/workspace-invites/${inv.code}`);
  assert.equal(wrong.status, 403); assert.match(wrong.body.error, /cara@example\.org/);
  ok(await api('cara', 'POST', `/api/workspace-invites/${inv.code}`));
  assert.equal((await api('cara', 'POST', `/api/workspace-invites/${inv.code}`)).status, 404, 'single use');
});

test('seat, campaign and guest limits follow the plan', async () => {
  // Trial: 3 seats, now used by Alice, Bob and Cara.
  const full = await api('alice', 'POST', `/api/workspaces/${W}/invites`, { role: 'member' });
  assert.equal(full.status, 402); assert.equal(full.body.upgrade, true); assert.match(full.body.error, /All 3 seats/);
  assert.equal((await api('dan', 'POST', `/api/workspace-invites/${memberLink}`)).status, 402);
  // When the trial ends without a subscription, the Free plan applies to new things.
  store.db.prepare('UPDATE orgs SET trial_ends = 0 WHERE id = ?').run(W);
  const info = ok(await api('alice', 'GET', `/api/workspaces/${W}`));
  assert.equal(info.plan.key, 'free'); assert.equal(info.plan.campaigns, 3);
  ok(await api('alice', 'POST', '/api/campaigns', { id: 'camp3', workspaceId: W, name: 'Third' }));
  const four = await api('alice', 'POST', '/api/campaigns', { id: 'camp4', workspaceId: W, name: 'Fourth' });
  assert.equal(four.status, 402); assert.match(four.body.error, /3 active campaigns/);
  ok(await api('alice', 'PATCH', '/api/campaigns/camp3', { archived: true }));
  ok(await api('alice', 'POST', '/api/campaigns', { id: 'camp4', workspaceId: W, name: 'Fourth' }));
  assert.equal((await api('alice', 'PATCH', '/api/campaigns/camp3', { archived: false })).status, 402);
  assert.equal((await api('alice', 'GET', `/api/workspaces/${W}/audit`)).status, 402);
  assert.equal((await api('alice', 'GET', `/api/workspaces/${W}/activity?from=2026-01-01&to=2026-03-31`)).status, 402);
});

// ---------- billing ----------
function signed(event) {
  const raw = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
  return { raw, sig: `t=${t},v1=${crypto.createHmac('sha256', 'whsec_1').update(`${t}.${raw}`).digest('hex')}` };
}
const hook = (raw, sig) => fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: raw });
test('Stripe checkout, signed webhooks, seats and cancellation', async () => {
  assert.equal((await api('cara', 'POST', `/api/workspaces/${W}/billing/checkout`, { seats: 5 })).status, 403);
  assert.equal((await api('alice', 'POST', `/api/workspaces/${W}/billing/checkout`, { seats: 1 })).status, 400, 'fewer seats than people');
  const co = ok(await api('alice', 'POST', `/api/workspaces/${W}/billing/checkout`, { seats: 5 }));
  assert.equal(co.url, 'https://checkout.stripe.com/c/pay/cs_1');
  const sess = mocks.stripe.find((r) => r.path === '/v1/checkout/sessions');
  assert.equal(sess.auth, 'Bearer sk_test_1');
  assert.deepEqual([sess.form.get('mode'), sess.form.get('customer'), sess.form.get('client_reference_id'), sess.form.get('line_items[0][price]'), sess.form.get('line_items[0][quantity]'), sess.form.get('subscription_data[metadata][org_id]')], ['subscription', 'cus_1', W, 'price_team', '5', W]);
  assert.equal(sess.form.get('success_url'), 'https://app.example.org/app?billing=done');
  // Forged and stale webhooks are refused.
  const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: W, customer: 'cus_1', subscription: 'sub_1' } } };
  const s1 = signed(ev);
  assert.equal((await hook(s1.raw, s1.sig.replace(/v1=./, 'v1=0'))).status, 400);
  assert.equal((await hook(s1.raw, `t=${Math.floor(Date.now() / 1000) - 900},v1=${crypto.createHmac('sha256', 'whsec_1').update(`${Math.floor(Date.now() / 1000) - 900}.${s1.raw}`).digest('hex')}`)).status, 400);
  mocks.sub = subscription(W, 5);
  assert.equal((await hook(s1.raw, s1.sig)).status, 200);
  let info = ok(await api('alice', 'GET', `/api/workspaces/${W}`));
  assert.deepEqual([info.plan.key, info.plan.seats, info.plan.status, info.plan.guests, info.plan.campaigns], ['team', 5, 'active', 25, null]);
  assert.deepEqual(await (await hook(s1.raw, signed(ev).sig)).json(), { duplicate: true });
  ok(await api('dan', 'POST', `/api/workspace-invites/${memberLink}`));
  // Seat changes go to Stripe and come back through the webhook.
  assert.equal((await api('alice', 'POST', `/api/workspaces/${W}/billing/seats`, { seats: 2 })).status, 400);
  mocks.sub = subscription(W, 8);
  ok(await api('alice', 'POST', `/api/workspaces/${W}/billing/seats`, { seats: 8 }));
  const upd = mocks.stripe.filter((r) => r.path === '/v1/subscriptions/sub_1' && r.method === 'POST').at(-1);
  assert.deepEqual([upd.form.get('items[0][id]'), upd.form.get('items[0][quantity]')], ['si_1', '8']);
  assert.equal(ok(await api('alice', 'GET', `/api/workspaces/${W}`)).plan.seats, 8);
  assert.equal(ok(await api('alice', 'POST', `/api/workspaces/${W}/billing/portal`)).url, 'https://billing.stripe.com/p/session/1');
  assert.equal((await api('alice', 'DELETE', `/api/workspaces/${W}`)).status, 409, 'cancel billing before deleting');
  const del = signed({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: subscription(W, 8, 'canceled') } });
  assert.equal((await hook(del.raw, del.sig)).status, 200);
  info = ok(await api('alice', 'GET', `/api/workspaces/${W}`));
  assert.equal(info.plan.key, 'free');
  // Back on Team for the reports below.
  const again = signed({ id: 'evt_3', type: 'customer.subscription.updated', data: { object: subscription(W, 8) } });
  await hook(again.raw, again.sig);
  assert.equal(ok(await api('alice', 'GET', `/api/workspaces/${W}`)).plan.key, 'team');
});

// ---------- reports, audit, export ----------
test('lobbying activity report, audit log and export', async () => {
  const r = ok(await api('alice', 'GET', `/api/workspaces/${W}/activity?from=2026-01-01&to=2026-03-31`));
  assert.equal(r.rows.length, 1, 'count updates and other quarters are left out');
  assert.deepEqual([r.rows[0].client, r.rows[0].issue, r.rows[0].withWhom, r.rows[0].loggedBy, r.rows[0].chamber], ['Prairie Co-ops', 'SB 214: Broadband', 'Jamie', 'Alice', 'State Senate']);
  assert.deepEqual(r.summary[0], { client: 'Prairie Co-ops', contacts: 1, issues: ['SB 214: Broadband'], chambers: ['State Senate'], lobbyists: ['Alice'] });
  assert.equal((await api('cara', 'GET', `/api/workspaces/${W}/activity?from=2026-01-01&to=2026-03-31`)).status, 403);
  const log = ok(await api('alice', 'GET', `/api/workspaces/${W}/audit?limit=200`)).entries.map((e) => e.action);
  for (const a of ['workspace.created', 'client.added', 'campaign.created', 'member.joined', 'member.role_changed', 'campaign.archived', 'billing.subscription', 'billing.canceled', 'billing.seats_changed']) assert.ok(log.includes(a), a);
  const ex = ok(await api('alice', 'GET', `/api/workspaces/${W}/export`));
  assert.equal(ex.workspace.name, 'Capitol Strategies');
  assert.equal(ex.campaigns.find((c) => c.id === C1).members.length, 2);
  assert.equal((await api('cara', 'GET', `/api/workspaces/${W}/export`)).status, 403);
});

// ---------- sign-in domain ----------
test('a verified email domain lets colleagues join', async () => {
  assert.equal((await api('alice', 'POST', `/api/workspaces/${W}/domain`, { domain: 'gmail.com' })).status, 400);
  const d = ok(await api('alice', 'POST', `/api/workspaces/${W}/domain`, { domain: 'capstrat.com' }));
  assert.equal((await api('alice', 'POST', `/api/workspaces/${W}/domain/verify`)).status, 409);
  txt.set('capstrat.com', [['v=spf1 -all'], [d.record]]);
  ok(await api('alice', 'POST', `/api/workspaces/${W}/domain/verify`));
  ok(await api('alice', 'PATCH', `/api/workspaces/${W}/domain`, { join: true }));
  const me = ok(await api('eve', 'GET', '/api/me', null, { domain: 'capstrat.com' }));
  assert.deepEqual(me.domainMatches, [{ id: W, name: 'Capitol Strategies' }]);
  assert.deepEqual(ok(await api('mallory', 'GET', '/api/me', null, { domain: 'capstrat.com', emailVerified: false })).domainMatches, []);
  assert.equal((await api('mallory', 'POST', `/api/workspaces/${W}/join`, null, { domain: 'capstrat.com', emailVerified: false })).status, 403);
  assert.equal(ok(await api('eve', 'POST', `/api/workspaces/${W}/join`, null, { domain: 'capstrat.com' })).role, 'member');
});

// ---------- accounts ----------
test('deleting an account passes its workspaces on or deletes them', async () => {
  const solo = ok(await api('frank', 'POST', '/api/workspaces', { name: 'Solo shop' }));
  const shared = ok(await api('frank', 'POST', '/api/workspaces', { name: 'Shared shop' }));
  const inv = ok(await api('frank', 'POST', `/api/workspaces/${shared.id}/invites`, { role: 'member' }));
  ok(await api('hank', 'POST', `/api/workspace-invites/${inv.code}`));
  assert.deepEqual(ok(await api('frank', 'DELETE', '/api/me')), { transferred: 1, deleted: 1 });
  assert.equal(ok(await api('hank', 'GET', `/api/workspaces/${shared.id}`)).role, 'owner');
  assert.equal((await api('hank', 'GET', `/api/workspaces/${solo.id}`)).status, 404);
});

test('databases from the first version move into workspaces', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-mig-')), 'v1.db');
  const v1 = new DatabaseSync(file);
  v1.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, provider TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 0, records INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE access (campaign_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (campaign_id, user_id));
    INSERT INTO users VALUES ('u1','a@x.org','Ann','google',1,1), ('u2','b@x.org','Ben','google',1,1);
    INSERT INTO campaigns VALUES ('c1','u1','Old bill',0,0,1,1);
    INSERT INTO access VALUES ('c1','u1','owner',1), ('c1','u2','viewer',1);`);
  v1.close();
  const s = mods.db.openDb(file, { billing: false });
  const orgs = s.listOrgs('u1');
  assert.equal(orgs.length, 1); assert.equal(orgs[0].name, "Ann's workspace");
  assert.equal(s.campaignRole('c1', 'u1'), 'owner'); assert.equal(s.campaignRole('c1', 'u2'), 'viewer');
  assert.equal(s.orgRole(orgs[0].id, 'u2'), 'guest');
});

// ---------- bills and drafting ----------
test('bill numbers, Congress numbers and lookups', async () => {
  const { parseFederal, parseState, currentCongress } = mods.bills;
  assert.equal(parseFederal('H.R. 1234').label, 'H.R. 1234'); assert.equal(parseFederal('S.Con.Res.3').label, 'S.Con.Res. 3'); assert.equal(parseFederal('HB 12'), null);
  assert.equal(parseState('hb123'), 'HB 123');
  assert.equal(currentCongress(new Date('2026-11-17T12:00:00Z')), 119); assert.equal(currentCongress(new Date('2027-01-03T12:00:00Z')), 120);
  const fed = ok(await api('alice', 'GET', '/api/bills/lookup?jurisdiction=US&number=H.R.%201234&session=119'));
  assert.equal(fed.officialSummary, 'This bill expands grants for rural broadband & requires reports.');
  assert.equal(fed.url, 'https://www.congress.gov/bill/119th-congress/house-bill/1234');
  const fl = ok(await api('alice', 'GET', '/api/bills/lookup?jurisdiction=FL&number=hb123'));
  assert.deepEqual([fl.number, fl.jurisdiction, fl.cosponsors], ['HB 123', 'Florida Legislature', 1]);
  assert.equal((await api('alice', 'GET', '/api/bills/lookup?jurisdiction=US&number=banana')).status, 400);
});

const draft = { plainSummary: 'Expands rural broadband grants.', keyProvisions: ['Creates a grant program.'], whoItAffects: 'Rural providers.', fiscalImpact: 'Not stated.', talkingPoints: ['Closes the gap.'], objections: [{ objection: 'Cost', response: 'Capped.' }], needsChecking: ['Program cost'] };
test('drafting is metered per workspace and sends a structured request', async () => {
  mocks.claudeReply = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  assert.equal((await api('gina', 'POST', '/api/bills/draft', { campaignId: C2, bill: { officialSummary: 'x' } })).status, 403, 'viewers cannot draft');
  const r = ok(await api('alice', 'POST', '/api/bills/draft', { campaignId: C1, bill: { number: 'H.R. 1234', officialSummary: 'Expands grants.' }, side: 'pass', ask: 'Cosponsor' }));
  assert.equal(r.objections[0].response, 'Capped.');
  const sent = mocks.claude.at(-1);
  assert.equal(sent.body.model, 'claude-opus-5-5'); assert.equal(sent.body.fallbacks, 'default');
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.equal(ok(await api('alice', 'GET', `/api/workspaces/${W}`)).usage.drafts, 1);
  mocks.claudeReply = { ...mocks.claudeReply, content: [], stop_reason: 'refusal' };
  await new Promise((res) => setTimeout(res, 1100));
  const refused = await api('alice', 'POST', '/api/bills/draft', { campaignId: C1, bill: { officialSummary: 'x' } });
  assert.equal(refused.status, 422); assert.match(refused.body.error, /declined/);
});

test('pages carry security headers and paths cannot escape', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.auth, 'dev'); assert.equal(cfg.ai, true); assert.equal(cfg.billing.trialDays, 14);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /connect-src [^;]*https:\/\/graph\.microsoft\.com/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/invite/abcdefgh12')).status, 200);
  const raw = await new Promise((resolve) => http.get(base + '/..%2f..%2fpackage.json', (res) => { res.resume(); resolve(res.statusCode); }));
  assert.notEqual(raw, 200);
  const ct = await fetch(base + '/api/workspaces', { method: 'POST', headers: { Authorization: 'Bearer ' + tok('alice'), 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(ct.status, 415);
});

// ---------- email ----------
const outbox = async () => (await (await fetch(base + '/api/dev/outbox')).json()).emails;
test('being added to a campaign or assigned a follow-up sends an email, within each person\'s settings', async () => {
  ok(await api('alice', 'POST', `/api/campaigns/${C2}/people`, { userId: 'dev:cara', role: 'editor' }));
  const added = (await outbox()).find((x) => x.to_addr === 'cara@example.org' && x.kind === 'added');
  assert.match(added.subject, /Alice added you to Closed one/); assert.match(added.unsubscribe, /^https:\/\/app\.example\.org\/api\/unsubscribe\?t=/);
  const task = (id, extra) => ({ kind: 'tasks', id, data: { id, text: 'Send the fiscal note', due: '2026-11-20', done: false, ...extra } });
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [task('t1', { assignee: 'dev:cara' })] }));
  const count = async (to, kind) => (await outbox()).filter((x) => x.to_addr === to && x.kind === kind).length;
  const a = (await outbox()).find((x) => x.kind === 'assigned');
  assert.match(a.subject, /^Alice assigned you a follow-up: Send the fiscal note/); assert.equal(a.to_addr, 'cara@example.org'); assert.equal(a.reply_to, 'alice@example.org');
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [task('t1', { assignee: 'dev:cara', text: 'Send the revised fiscal note' })] }));
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [task('t9', { assignee: 'dev:alice' })] }));
  assert.equal(await count('cara@example.org', 'assigned'), 1, 'no repeat, and nothing for assigning yourself');
  assert.equal(await count('alice@example.org', 'assigned'), 0);
  ok(await api('cara', 'PATCH', '/api/me/prefs', { notifyAssigned: false }));
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [task('t2', { assignee: 'dev:cara' })] }));
  assert.equal(await count('cara@example.org', 'assigned'), 1, 'turned off');
  assert.equal((await api('cara', 'PATCH', '/api/me/prefs', { digest: 'hourly' })).status, 400);
  assert.equal((await api('cara', 'PATCH', '/api/me/prefs', { tz: 'Mars/Olympus' })).status, 400);
});

test('unsubscribe links are signed, work in one click and refuse tampering', async () => {
  const added = (await outbox()).find((x) => x.kind === 'added'), u = new URL(added.unsubscribe);
  const page = await fetch(base + u.pathname + u.search);
  assert.equal(page.status, 200); assert.match(await page.text(), /You are unsubscribed/);
  assert.equal(ok(await api('cara', 'GET', '/api/me')).prefs.notifyAdded, false);
  const forged = u.search.replace('.added.', '.digest.');
  assert.equal((await fetch(base + u.pathname + forged)).status, 400);
  const one = await fetch(base + u.pathname + u.search, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(one.status, 200);
});

test('a daily digest arrives at the chosen hour in the person\'s time zone, once a day', async () => {
  ok(await api('alice', 'PATCH', '/api/me/prefs', { digest: 'daily', tz: 'America/New_York', digestHour: 8 }));
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [
    { kind: 'members', id: 'm1', data: { name: 'Vega', party: 'D', district: '4', pos: 3, history: [{ d: '2026-11-16', type: 'Meeting', from: 2, to: 3, by: 'dev:bob' }] } },
    { kind: 'tasks', id: 't3', data: { id: 't3', text: 'Call the district office', due: '2026-11-10', done: false } },
    { kind: 'summary', data: { odds: 0.6, side: 'pass', cmteDate: '2026-11-20', trend: [{ d: '2026-11-10', p: 0.5 }], meetings: [] } },
  ] }));
  // 2026-11-17 is a Tuesday, so weekly digests wait for Monday.
  assert.equal(server.jobs.digests(new Date('2026-11-17T12:00:00Z')), 0, '7 a.m. in New York is too early');
  assert.equal(server.jobs.digests(new Date('2026-11-17T14:00:00Z')), 1);
  assert.equal(server.jobs.digests(new Date('2026-11-17T20:00:00Z')), 0, 'once a day');
  const d = (await outbox()).find((x) => x.kind === 'digest');
  assert.equal(d.to_addr, 'alice@example.org'); assert.match(d.subject, /^Headcount for Tue, Nov 17: 1 position change/);
  for (const line of ['SB 214: Broadband (Prairie Co-ops · Capitol Strategies)', 'Odds of passage: 60% (up 10 points)', 'Moved: Vega: Undecided to Lean yes', '1 contact logged by the team', 'Committee vote Fri, Nov 20', 'Overdue follow-up: Call the district office']) assert.ok(d.text_body.includes(line), line);
});

test('admins hear when a trial is about to end, once', async () => {
  const t = ok(await api('ivan', 'POST', '/api/workspaces', { name: 'Trial Co' }));
  store.db.prepare('UPDATE orgs SET trial_ends = ? WHERE id = ?').run(Date.now() + 2.5 * 864e5, t.id);
  assert.equal(server.jobs.trialNotices(Date.now()), 1);
  assert.equal(server.jobs.trialNotices(Date.now()), 0);
  assert.match((await outbox()).find((x) => x.to_addr === 'ivan@example.org').subject, /Trial Co: your Headcount trial ends in 3 days/);
});

test('workspace invitations can be emailed by the server', async () => {
  const r = ok(await api('alice', 'POST', `/api/workspaces/${W}/invites`, { role: 'guest', email: 'client@prairie.org', send: true }));
  assert.equal(r.emailed, true);
  const m = (await outbox()).find((x) => x.to_addr === 'client@prairie.org');
  assert.match(m.subject, /Alice invited you to Capitol Strategies on Headcount/); assert.ok(m.text_body.includes(`/invite/${r.code}`));
});

test('the mail worker sends queued email with unsubscribe headers and retries failures', async () => {
  const { makeMailer } = await import('../server/mail.js');
  const sent = []; let failNext = true;
  const transport = { sendMail: async (msg) => { if (failNext) { failNext = false; throw new Error('421 try again later'); } sent.push(msg); } };
  const s2 = mods.db.openDb(':memory:', { billing: false });
  s2.touchUser({ id: 'u1', email: 'u1@x.org', name: 'U' });
  const mailer = makeMailer({ smtpTransport: transport, emailFrom: 'Headcount <n@headcount.test>', publicUrl: 'https://app.test' }, s2);
  assert.equal(mailer.queue({ to: 'u1@x.org', subject: 'Hello', text: 'Body', kind: 'digest', userId: 'u1', unsubscribeKind: 'digest' }), true);
  assert.equal(await mailer.work(), 0);
  const row = s2.db.prepare('SELECT attempts, next_at, error FROM email_queue').get();
  assert.equal(row.attempts, 1); assert.match(row.error, /421/); assert.ok(row.next_at > Date.now() + 50e3);
  assert.equal(await mailer.work(Date.now() + 61e3), 1);
  assert.equal(sent[0].from, 'Headcount <n@headcount.test>');
  assert.equal(sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent[0].headers['List-Unsubscribe'], /^<https:\/\/app\.test\/api\/unsubscribe\?t=/);
});

test('the demo request form stores the lead and emails sales', async () => {
  const post = (b) => fetch(base + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post({ name: 'Pat', email: 'nope' })).status, 400);
  assert.equal((await post({ name: 'Bot', email: 'b@x.org', website: 'http://spam' })).status, 200);
  assert.equal((await post({ name: 'Pat Lee', email: 'pat@firm.org', firm: 'Lee Partners', size: '6 to 20', message: 'Florida House' })).status, 200);
  assert.deepEqual(store.db.prepare('SELECT name FROM leads').all().map((l) => l.name), ['Pat Lee']);
  const m = (await outbox()).find((x) => x.kind === 'lead');
  assert.equal(m.to_addr, 'sales@headcount.test'); assert.equal(m.reply_to, 'pat@firm.org'); assert.match(m.text_body, /Lee Partners/);
});

// ---------- single sign-on ----------
test('single sign-on: Firm plan, verified domain, required for members but not owners, joins on sign-in', async () => {
  const f = ok(await api('olga', 'POST', '/api/workspaces', { name: 'Big Firm' }));
  assert.equal((await api('olga', 'PATCH', `/api/workspaces/${f.id}/sso`, { provider: 'saml.bigfirm' })).status, 402, 'not on the trial');
  store.db.prepare("UPDATE orgs SET plan = 'firm', status = 'active', stripe_subscription = 'sub_bf', seats = 10 WHERE id = ?").run(f.id);
  assert.equal((await api('olga', 'PATCH', `/api/workspaces/${f.id}/sso`, { provider: 'saml.bigfirm' })).status, 400, 'domain not verified');
  const d = ok(await api('olga', 'POST', `/api/workspaces/${f.id}/domain`, { domain: 'bigfirm.com' }));
  txt.set('bigfirm.com', [[d.record]]); ok(await api('olga', 'POST', `/api/workspaces/${f.id}/domain/verify`));
  assert.equal((await api('olga', 'PATCH', `/api/workspaces/${f.id}/sso`, { provider: 'not a provider' })).status, 400);
  ok(await api('olga', 'PATCH', `/api/workspaces/${f.id}/sso`, { provider: 'saml.bigfirm', required: true }));
  assert.deepEqual(ok(await api(null, 'GET', '/api/sso/lookup?email=someone@BigFirm.com')), { provider: 'saml.bigfirm', workspace: 'Big Firm' });
  assert.equal((await api(null, 'GET', '/api/sso/lookup?email=someone@other.org')).status, 404);
  const inv = ok(await api('olga', 'POST', `/api/workspaces/${f.id}/invites`, { role: 'member' }));
  ok(await api('paul', 'POST', `/api/workspace-invites/${inv.code}`));
  const blocked = await api('paul', 'GET', `/api/workspaces/${f.id}/campaigns`);
  assert.equal(blocked.status, 403); assert.equal(blocked.body.sso, true); assert.equal(blocked.body.workspace, 'Big Firm');
  assert.equal(ok(await api('paul', 'GET', '/api/workspaces')).workspaces.find((w) => w.id === f.id).ssoRequired, true);
  ok(await api('olga', 'POST', '/api/campaigns', { id: 'bf1', workspaceId: f.id, name: 'Firm bill' }));
  assert.equal((await api('paul', 'GET', '/api/campaigns/bf1/records?since=0')).status, 403);
  const sso = { provider: 'saml.bigfirm', domain: 'bigfirm.com' };
  const me = ok(await api('quinn', 'GET', '/api/me', null, sso));
  assert.equal(me.workspaces.find((w) => w.id === f.id).role, 'member');
  assert.equal(ok(await api('quinn', 'GET', '/api/campaigns/bf1/records?since=0', null, sso)).role, 'editor');
  assert.ok(ok(await api('olga', 'GET', `/api/workspaces/${f.id}/audit`)).entries.some((e) => e.action === 'member.joined' && e.detail.via === 'single sign-on'));
});

// ---------- website ----------
test('the website and the app have their own addresses', async () => {
  const home = await fetch(base + '/'); assert.equal(home.status, 200);
  const h = await home.text();
  assert.match(h, /Know the count/); assert.match(h, /<svg/); assert.doesNotMatch(h, /\{\{\w+\}\}/);
  const pricing = await (await fetch(base + '/pricing')).text();
  assert.match(pricing, /<td>3<\/td>/); assert.match(pricing, /Single sign-on \(SAML, OIDC\)/); assert.doesNotMatch(pricing, /\{\{\w+\}\}/);
  for (const pth of ['/security', '/privacy', '/terms', '/site/site.css', '/site/site.js', '/app', '/app/', '/invite/abcdefgh12']) assert.equal((await fetch(base + pth)).status, 200, pth);
  assert.match(await (await fetch(base + '/app')).text(), /<script src="\/app\.js\?v=[0-9a-f]{10}" defer>/, 'asset links carry a content version');
  for (const pth of ['/site/_header.html', '/site/_hemicycle.svg']) assert.equal((await fetch(base + pth)).status, 403, pth);
  assert.match(await (await fetch(base + '/security')).text(), /mailto:sales@headcount\.test/);
});

// ---------- Monitor, intelligence, rosters, action center, stakeholders ----------
const emailsTo = (to, kind) => store.db.prepare('SELECT * FROM email_queue WHERE to_addr = ?' + (kind ? ' AND kind = ?' : '') + ' ORDER BY id').all(...(kind ? [to, kind] : [to]));
let MW, MC;
test('the Monitor finds bills in Congress and the states, rules and contract notices, scores them and alerts', async () => {
  MW = ok(await api('mona', 'POST', '/api/workspaces', { name: 'Mona Group' })).id;
  ok(await api('mona', 'PATCH', '/api/me/prefs', { monitor: 'instant' }));
  const bills = ok(await api('mona', 'POST', `/api/workspaces/${MW}/watches`, { kind: 'bill', query: 'broadband, digital equity', states: ['US', 'FL'], priorities: 'Grants for rural broadband co-ops' }));
  assert.equal(bills.name, 'broadband'); assert.equal(bills.total, 2, 'H.R. 1234 from Congress (S. 99 does not match) and HB 77 from Florida'); assert.equal(bills.fresh, 2);
  const inbox = ok(await api('mona', 'GET', `/api/workspaces/${MW}/items?view=new`)).items;
  const hr = inbox.find((i) => i.number === 'H.R. 1234');
  assert.equal(hr.url, 'https://www.congress.gov/bill/119th-congress/house-bill/1234'); assert.equal(hr.juris, 'US'); assert.equal(hr.score, 92); assert.match(hr.reason, /rural broadband/);
  assert.equal(inbox.find((i) => i.number === 'HB 77').juris, 'FL');
  const alert = emailsTo('mona@example.org', 'monitor');
  assert.equal(alert.length, 1); assert.match(alert[0].subject, /Mona Group Monitor: 2 new items/); assert.match(alert[0].text_body, /H\.R\. 1234: Rural Broadband Access Act \(Congress\)\. Directly about rural broadband\./); assert.ok(alert[0].unsubscribe);

  const regs = ok(await api('mona', 'POST', `/api/workspaces/${MW}/watches`, { kind: 'reg', query: 'broadband equity' }));
  const rule = ok(await api('mona', 'GET', `/api/workspaces/${MW}/items?view=new&watch=${regs.id}`)).items[0];
  assert.equal(rule.number, 'NTIA-2026-0001'); assert.equal(rule.deadline, '2027-01-12'); assert.equal(rule.docType, 'Proposed rule'); assert.match(rule.agency, /Telecommunications/);
  const gov = ok(await api('mona', 'POST', `/api/workspaces/${MW}/watches`, { kind: 'contract', query: 'broadband', naics: '517111' }));
  const opp = ok(await api('mona', 'GET', `/api/workspaces/${MW}/items?kind=contract`)).items[0];
  assert.equal(gov.total, 1); assert.equal(opp.agency, 'Agriculture, Department of: Rural Utilities Service'); assert.equal(opp.deadline, '2026-12-15'); assert.equal(opp.extra.naics, '517111');

  // Tracking a bill alerts when it moves
  ok(await api('mona', 'PATCH', `/api/workspaces/${MW}/items/${hr.id}`, { state: 'tracked' }));
  mocks.fedStatus = 'Passed House.';
  const again = ok(await api('mona', 'POST', `/api/workspaces/${MW}/watches/${bills.id}/run`));
  assert.equal(again.added, 0); assert.equal(again.changed, 1);
  const tracked = ok(await api('mona', 'GET', `/api/workspaces/${MW}/items?view=tracked`)).items;
  assert.equal(tracked[0].status, 'Passed House.'); assert.equal(tracked[0].prevStatus, 'Referred to the Subcommittee on Communications.');
  assert.match(emailsTo('mona@example.org', 'monitor').at(-1).text_body, /H\.R\. 1234: Rural Broadband Access Act: now "Passed House\."/);
  // Scheduled checks: bill watches every few hours; contract watches once a day (SAM.gov's limit)
  const later = Date.now() + 7 * 3600e3;
  const before = store.db.prepare('SELECT id, last_run FROM watches WHERE org_id = ?').all(MW);
  await server.monitor.tick(later);
  const after = new Map(store.db.prepare('SELECT id, last_run FROM watches WHERE org_id = ?').all(MW).map((r) => [r.id, r.last_run]));
  assert.equal(after.get(bills.id), later, 'bill watch checked again after 7 hours');
  assert.equal(after.get(gov.id), before.find((r) => r.id === gov.id).last_run, 'contract watch waits a day');
  const dayLater = Date.now() + 25 * 3600e3;
  await server.monitor.tick(dayLater);
  assert.equal(store.db.prepare('SELECT last_run FROM watches WHERE id = ?').get(gov.id).last_run, dayLater, 'contract watch checked after a day');
  // Dismissed items leave the inbox
  const hb = inbox.find((i) => i.number === 'HB 77');
  ok(await api('mona', 'PATCH', `/api/workspaces/${MW}/items/${hb.id}`, { state: 'dismissed' }));
  assert.ok(!ok(await api('mona', 'GET', `/api/workspaces/${MW}/items?view=new`)).items.some((i) => i.id === hb.id));
  // The digest has a Monitor section
  const d = server.notifier.digestFor({ id: 'dev:mona', email: 'mona@example.org', tz: 'UTC', monitor: 'digest' }, '2000-01-01', new Date().toISOString().slice(0, 10), 'daily');
  assert.match(d.text, /Monitor: Mona Group/); assert.match(d.subject, /new Monitor item/);
  // Guests do not see the Monitor; watches are limited by plan; other workspaces cannot reach items
  const inv = ok(await api('mona', 'POST', `/api/workspaces/${MW}/invites`, { role: 'guest' }));
  ok(await api('gus', 'POST', `/api/workspace-invites/${inv.code}`));
  assert.equal((await api('gus', 'GET', `/api/workspaces/${MW}/watches`)).status, 403);
  assert.equal((await api('alice', 'PATCH', `/api/workspaces/${MW}/items/${hr.id}`, { state: 'new' })).status, 404);
  assert.equal((await api('mona', 'POST', `/api/workspaces/${MW}/watches`, { kind: 'bill', query: '', states: ['US'] })).status, 400);
});

test('who is lobbying on a bill, and who wins contracts like this one', async () => {
  const l = ok(await api('mona', 'GET', `/api/intel/lobbying?number=${encodeURIComponent('H.R. 1234')}`));
  assert.equal(l.filings.length, 1, 'H.R. 12345 is not H.R. 1234'); assert.equal(l.clients[0].client, 'Rural Telecom Coalition'); assert.equal(l.clients[0].amount, 50000); assert.deepEqual(l.clients[0].registrants, ['Akin Strategies']);
  assert.ok(mods.config && mods.index);
  const re = (await import('../server/sources.js')).billPattern('S. 56');
  assert.ok(re.test('S.56 and more')); assert.ok(re.test('S 56')); assert.ok(!re.test('S. 560'));
  const inc = ok(await api('mona', 'GET', '/api/intel/incumbents?agency=Department%20of%20Agriculture&naics=517111'));
  assert.equal(inc.recipients[0].name, 'ACME NETWORKS'); assert.equal(inc.recipients[0].share, 0.75);
  const { usaAgencyName } = await import('../server/sources.js');
  assert.equal(usaAgencyName('Agriculture, Department of'), 'Department of Agriculture');
  assert.equal(usaAgencyName('Dept of Defense'), 'Department of Defense');
  assert.equal(usaAgencyName('Interior, Department of the'), 'Department of the Interior');
  assert.equal(usaAgencyName('General Services Administration'), 'General Services Administration');
});

test('rosters for any state chamber load from Open States with offices', async () => {
  const r = ok(await api('mona', 'GET', '/api/rosters/state?state=FL&chamber=upper'));
  assert.equal(r.label, 'Florida Senate'); assert.deepEqual(r.juris, { level: 'state', state: 'FL', chamber: 'upper' });
  assert.deepEqual(r.members[0], { k: 'aaaa-1111', n: 'Corey Simon', p: 'R', d: '3', ph: '850-487-5003', of: '404 S. Monroe St., Tallahassee, FL 32399', em: 'simon.corey@flsenate.gov', dph: '850-555-0100', dof: '1 Main St, Tallahassee, FL', url: 'https://openstates.org/person/corey-simon/' });
  assert.equal(r.members[1].p, 'D');
  assert.equal((await api('mona', 'GET', '/api/rosters/state?state=ZZ&chamber=upper')).status, 400);
});

test('action center: supporters find their own legislators by address and their letters reach the office', async () => {
  MC = 'campact1'; ok(await api('mona', 'POST', '/api/campaigns', { id: MC, workspaceId: MW, name: 'SB 214' }));
  const targets = [{ id: 'm1', name: 'Corey Simon', district: '3', email: 'simon.corey@flsenate.gov', phone: '850-487-5003' }, { id: 'm2', name: 'Ana Ruiz', district: '12', email: 'ruiz@flsenate.gov' }];
  const saved = ok(await api('mona', 'PUT', `/api/campaigns/${MC}/action`, { title: 'Back rural broadband', intro: 'SB 214 brings internet to rural Florida.', subject: 'Please support SB 214', letter: 'As your constituent, I ask you to vote yes on SB 214.', juris: { level: 'state', state: 'FL', chamber: 'upper' }, targets }));
  const id = saved.action.id; assert.equal(saved.action.url, `https://app.example.org/act/${id}`);
  const pub = await (await fetch(`${base}/api/act/${id}`)).json();
  assert.equal(pub.title, 'Back rural broadband'); assert.equal(pub.org, 'Mona Group');
  const page = await fetch(`${base}/act/${id}`); assert.equal(page.status, 200); assert.match(await page.text(), /Find my legislators/);
  const post = (p, b) => fetch(`${base}/api/act/${id}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const look = await post('/lookup', { address: '100 Main St, Tallahassee FL 32301' });
  assert.equal(look.status, 200); assert.deepEqual(look.body.members.map((x) => x.name), ['Corey Simon']);
  assert.equal((await post('/lookup', { address: '1 Nowhere Rd, Nowhere' })).status, 404);
  const sent = await post('/send', { name: 'Pat Voter', email: 'pat@example.net', address: '100 Main St, Tallahassee FL 32301', message: 'As your constituent, I ask you to vote yes on SB 214. It matters to my farm.', optin: true });
  assert.equal(sent.status, 200); assert.deepEqual(sent.body.emailed, ['Corey Simon']); assert.deepEqual(sent.body.call, [{ name: 'Corey Simon', phone: '850-487-5003' }]);
  const letter = emailsTo('simon.corey@flsenate.gov', 'constituent');
  assert.equal(letter.length, 1); assert.equal(letter[0].reply_to, 'pat@example.net'); assert.equal(letter[0].subject, 'Please support SB 214');
  assert.match(letter[0].text_body, /^Dear Senator Simon,\n\nAs your constituent/); assert.match(letter[0].text_body, /Pat Voter\n100 MAIN ST, TALLAHASSEE, FL, 32301/);
  assert.equal(emailsTo('ruiz@flsenate.gov').length, 0, 'other districts get nothing');
  assert.equal((await post('/send', { name: 'Pat Voter', email: 'PAT@example.net', address: '100 Main St, Tallahassee FL 32301' })).status, 409, 'once a day per person');
  const stats = ok(await api('mona', 'GET', `/api/campaigns/${MC}/action`));
  assert.equal(stats.stats.responses, 1); assert.equal(stats.stats.byMember.m1, 1);
  const resp = ok(await api('mona', 'GET', `/api/campaigns/${MC}/action/responses`)).responses;
  assert.equal(resp[0].email, 'pat@example.net'); assert.deepEqual(resp[0].members, ['Corey Simon']); assert.equal(resp[0].edited, true);
  // U.S. House targets match by congressional district
  ok(await api('mona', 'PUT', `/api/campaigns/${MC}/action`, { title: 'Back H.R. 1234', letter: 'Please cosponsor.', juris: { level: 'us', chamber: 'lower' }, targets: [{ id: 'h1', name: 'Rep One', district: 'FL-1' }, { id: 'h2', name: 'Rep Two', district: 'FL-2', phone: '202-225-5235' }] }));
  assert.deepEqual((await post('/lookup', { address: '100 Main St, Tallahassee FL 32301' })).body.members.map((x) => x.name), ['Rep Two']);
  // Turned off, the page is gone; guests and other workspaces cannot change it
  assert.equal((await api('gus', 'PUT', `/api/campaigns/${MC}/action`, { letter: 'x', targets })).status, 404);
  ok(await api('mona', 'PUT', `/api/campaigns/${MC}/action`, { title: 'Off', letter: 'x', targets, active: false }));
  assert.equal((await fetch(`${base}/api/act/${id}`)).status, 404);
});

test('stakeholder contacts: add, import, log interactions in bulk, export', async () => {
  const dana = ok(await api('mona', 'POST', `/api/workspaces/${MW}/contacts`, { name: 'Dana Lee', title: 'Policy Advisor', organization: 'NTIA', email: 'dana@ntia.example', tags: 'Agency, broadband' }));
  assert.deepEqual(dana.tags, ['agency', 'broadband']); assert.equal(dana.ownerId, 'dev:mona');
  const imp = ok(await api('mona', 'POST', `/api/workspaces/${MW}/contacts/import`, { rows: [{ name: 'Dana Lee', email: 'DANA@ntia.example', tags: 'priority' }, { name: 'Sam Roe', organization: 'Gulf Co-op', email: 'sam@coop.example' }, { name: '', email: 'bad' }] }));
  assert.deepEqual([imp.added, imp.updated, imp.skipped.length], [1, 1, 1]);
  const all = ok(await api('mona', 'GET', `/api/workspaces/${MW}/contacts`)).contacts;
  assert.deepEqual(all.map((c) => c.name), ['Dana Lee', 'Sam Roe']); assert.deepEqual(all[0].tags, ['agency', 'broadband', 'priority']);
  const logged = ok(await api('mona', 'POST', `/api/workspaces/${MW}/interactions`, { contactIds: all.map((c) => c.id), type: 'Email', note: 'Coalition letter on SB 214', campaignId: MC, day: '2026-11-16' }));
  assert.equal(logged.logged, 2);
  const tl = ok(await api('mona', 'GET', `/api/workspaces/${MW}/contacts/${dana.id}/interactions`)).interactions;
  assert.equal(tl[0].note, 'Coalition letter on SB 214'); assert.equal(tl[0].by, 'Mona'); assert.equal(tl[0].campaignId, MC);
  assert.equal(ok(await api('mona', 'GET', `/api/workspaces/${MW}/contacts`)).contacts[0].lastTouch, '2026-11-16');
  assert.equal((await api('gus', 'GET', `/api/workspaces/${MW}/contacts`)).status, 403);
  assert.equal((await api('mona', 'POST', `/api/workspaces/${MW}/contacts`, { name: 'X', email: 'nope' })).status, 400);
  const ex = ok(await api('mona', 'GET', `/api/workspaces/${MW}/export`));
  assert.equal(ex.contacts.length, 2); assert.equal(ex.interactions.length, 2); assert.equal(ex.watches.length, 3); assert.equal(ex.actionResponses[0].name, 'Pat Voter');
});

// ---------- built-in accounts ----------
test('built-in accounts: sign up, operator, sign in, confirm email, reset, sign out, invite-only, delete', async () => {
  const post = (p, b, token) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const me = (token) => fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + token } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await (await fetch(base + '/api/config')).json()).accounts.setup, true, 'no accounts yet');
  assert.equal((await post('/api/auth/signup', { name: 'Olivia Operator', email: 'olivia@firm.test', password: 'short' })).status, 400);
  const first = await post('/api/auth/signup', { name: 'Olivia Operator', email: 'Olivia@Firm.test', password: 'correct horse battery' });
  assert.equal(first.status, 200); assert.equal(first.body.operator, true); assert.match(first.body.token, /^s\./);
  const m1 = await me(first.body.token);
  assert.equal(m1.body.operator, true); assert.equal(m1.body.local, true); assert.equal(m1.body.user.email, 'olivia@firm.test'); assert.equal(m1.body.user.emailVerified, false); assert.equal(m1.body.user.session, undefined);
  assert.equal((await post('/api/auth/signup', { name: 'Dup', email: 'olivia@firm.test', password: 'another long one' })).status, 409);
  // A second person is not the operator
  const pat = await post('/api/auth/signup', { name: 'Pat Partner', email: 'pat@firm.test', password: 'partner password 1' });
  assert.equal(pat.body.operator, false); assert.equal((await me(pat.body.token)).body.operator, false);
  // Sign in
  assert.equal((await post('/api/auth/login', { email: 'olivia@firm.test', password: 'wrong password!!' })).status, 401);
  const login = await post('/api/auth/login', { email: 'OLIVIA@firm.test', password: 'correct horse battery' });
  assert.equal(login.status, 200);
  // Confirm email from the link in the welcome email
  const welcome = store.db.prepare("SELECT * FROM email_queue WHERE kind = 'verify' AND to_addr = 'olivia@firm.test'").get();
  const vt = /confirm\?t=([A-Za-z0-9_-]+)/.exec(welcome.text_body)[1];
  const page = await fetch(`${base}/api/auth/confirm?t=${vt}`); assert.equal(page.status, 200); assert.match(await page.text(), /is confirmed/);
  assert.equal((await me(login.body.token)).body.user.emailVerified, true);
  assert.equal((await fetch(`${base}/api/auth/confirm?t=${vt}`)).status, 400, 'links work once');
  // Reset the password: old sessions end
  assert.equal((await post('/api/auth/reset-request', { email: 'nobody@firm.test' })).status, 200, 'no hint whether an account exists');
  await post('/api/auth/reset-request', { email: 'olivia@firm.test' });
  const resetMail = store.db.prepare("SELECT * FROM email_queue WHERE kind = 'reset' AND to_addr = 'olivia@firm.test'").get();
  const rt = /#reset=([A-Za-z0-9_-]+)/.exec(resetMail.text_body)[1];
  const reset = await post('/api/auth/reset', { token: rt, password: 'a brand new password' });
  assert.equal(reset.status, 200);
  assert.equal((await me(login.body.token)).status, 401, 'old sessions end after a reset');
  assert.equal((await post('/api/auth/login', { email: 'olivia@firm.test', password: 'correct horse battery' })).status, 401);
  assert.equal((await post('/api/auth/reset', { token: rt, password: 'yet another password' })).status, 400, 'reset links work once');
  // Change password and sign out
  assert.equal((await post('/api/auth/password', { current: 'nope nope nope', next: 'whatever whatever' }, reset.body.token)).status, 400);
  assert.equal((await post('/api/auth/password', { current: 'a brand new password', next: 'the final password' }, reset.body.token)).status, 200);
  assert.equal((await post('/api/auth/logout', {}, reset.body.token)).status, 200);
  assert.equal((await me(reset.body.token)).status, 401);
  // Built-in accounts work with workspaces like any other
  const o = await post('/api/auth/login', { email: 'olivia@firm.test', password: 'the final password' });
  const ws = await post('/api/workspaces', { name: 'Olivia Firm' }, o.body.token); assert.equal(ws.status, 200);
  // Invite-only sign-up
  store.putSetting('signups', 'invite');
  assert.equal((await post('/api/auth/signup', { name: 'Stranger', email: 'stranger@else.test', password: 'stranger password' })).status, 403);
  const inv = await post(`/api/workspaces/${ws.body.id}/invites`, { role: 'member' }, o.body.token);
  const invited = await post('/api/auth/signup', { name: 'Invited Ivy', email: 'ivy@firm.test', password: 'ivy long password', invite: inv.body.code });
  assert.equal(invited.status, 200);
  store.putSetting('signups', 'open');
  // Deleting the account removes the sign-in too
  assert.equal((await fetch(base + '/api/me', { method: 'DELETE', headers: { Authorization: 'Bearer ' + pat.body.token } })).status, 200);
  assert.equal((await post('/api/auth/login', { email: 'pat@firm.test', password: 'partner password 1' })).status, 401);
});

// ---------- server settings ----------
test('server settings: operator only, secrets encrypted and hidden, applied live, environment wins, backups', async () => {
  const post = (p, b, token, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const op = (await post('/api/auth/login', { email: 'olivia@firm.test', password: 'the final password' }, '')).body.token;
  const ivy = (await post('/api/auth/login', { email: 'ivy@firm.test', password: 'ivy long password' }, '')).body.token;
  assert.equal((await fetch(base + '/api/settings', { headers: { Authorization: 'Bearer ' + ivy } })).status, 403, 'only the operator');
  const get = async () => (await fetch(base + '/api/settings', { headers: { Authorization: 'Bearer ' + op } })).json();
  let s = await get();
  assert.equal(s.fields.congressKey.env, true, 'set by the environment in this test run, so locked');
  assert.equal(s.fields.ldaKey.env, false);
  // A secret is stored encrypted, never returned, and applied at once
  const saved = await post('/api/settings', { ldaKey: 'lda-secret-1234', supportEmail: 'help@firm.test', congressKey: 'ignored' }, op, 'PUT');
  assert.equal(saved.status, 200); assert.equal(saved.body.fields.ldaKey.set, true); assert.equal(saved.body.fields.ldaKey.hint, '…1234'); assert.equal(JSON.stringify(saved.body).includes('lda-secret-1234'), false);
  assert.match(store.setting('cfg.ldaKey'), /^enc:v1:/); assert.equal(store.setting('cfg.congressKey'), null, 'environment wins');
  assert.equal(mods.config.ldaKey, 'lda-secret-1234'); assert.equal(mods.config.congressKey, 'cg-key');
  assert.equal((await (await fetch(base + '/api/config')).json()).supportEmail, 'help@firm.test');
  // Validation
  assert.equal((await post('/api/settings', { smtpPort: 'abc' }, op, 'PUT')).status, 400);
  assert.equal((await post('/api/settings', { supportEmail: 'not an address' }, op, 'PUT')).status, 400);
  assert.equal((await get()).fields.publicUrl.env, true, 'PUBLIC_URL from the host is locked');
  assert.equal((await post('/api/settings', { nope: 'x' }, op, 'PUT')).status, 400);
  // Clearing a secret
  await post('/api/settings', { ldaKey: '' }, op, 'PUT'); assert.equal(mods.config.ldaKey, ''); assert.equal((await get()).fields.ldaKey.set, false);
  // Testing a source runs the real code path (here against the stand-in)
  const t = await post('/api/settings/test-source', { source: 'lda' }, op);
  assert.equal(t.body.ok, true); assert.match(t.body.detail, /filings name H\.R\. 1/);
  // Sign-up policy
  await post('/api/settings', { signups: 'invite' }, op, 'PUT');
  assert.equal((await (await fetch(base + '/api/config')).json()).accounts.signups, 'invite');
  await post('/api/settings', { signups: 'open' }, op, 'PUT');
  // Backup download is a SQLite file, operator only
  const b = await fetch(base + '/api/settings/backup', { headers: { Authorization: 'Bearer ' + op } });
  assert.equal(b.status, 200); assert.equal(Buffer.from(await b.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(base + '/api/settings/backup', { headers: { Authorization: 'Bearer ' + ivy } })).status, 403);
});
