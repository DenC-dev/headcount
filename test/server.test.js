import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stand-ins for Google's signing keys, Congress.gov, Open States, Stripe and the Claude API.
const mocks = { claude: [], claudeReply: null, stripe: [], so: { products: [], prices: [], hooks: [], portals: [], n: 0 }, sub: null, fedStatus: 'Referred to the Subcommittee on Communications.', scored: [], geo: [] };
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
      mocks.stripe.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, version: req.headers['stripe-version'], form: new URLSearchParams(body) });
      if (u.pathname === '/v1/charges/ch_1') return j(200, { id: 'ch_1', object: 'charge', customer: 'cus_1', amount: 22500, currency: 'usd' });
      if (u.pathname === '/v1/customers') return j(200, { id: 'cus_1' });
      if (u.pathname === '/v1/checkout/sessions') return j(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', managed_payments: { enabled: new URLSearchParams(body).get('managed_payments[enabled]') === 'true' } });
      if (u.pathname === '/v1/checkout/sessions/cs_1/expire') return j(200, { id: 'cs_1', status: 'expired' });
      if (u.pathname === '/v1/billing_portal/sessions') return j(200, { url: 'https://billing.stripe.com/p/session/1' });
      if (u.pathname === '/v1/subscriptions/sub_1') return j(200, mocks.sub);
      // What Headcount's one-step Stripe setup uses
      const S = mocks.so, f = new URLSearchParams(body), get = req.method === 'GET';
      if (u.pathname === '/v1/tax/registrations') return j(200, { data: S.taxRegs || [] });
      if (/^\/v1\/prices\/price_\d+$/.test(u.pathname) && req.method === 'POST') { const p = S.prices.find((x) => x.id === u.pathname.split('/').pop()); p.tax_behavior = f.get('tax_behavior'); return j(200, p); }
      if (u.pathname === '/v1/account' && /rk_test_/.test(req.headers.authorization || '')) return j(403, { error: { message: 'The provided key does not have the required permissions' } });
      if (u.pathname === '/v1/account') return /bad/.test(req.headers.authorization || '') ? j(401, { error: { message: 'Invalid API Key provided' } }) : j(200, { id: 'acct_1', settings: { dashboard: { display_name: 'Capitol Strategies' } }, charges_enabled: false, details_submitted: false });
      if (u.pathname === '/v1/products') {
        if (get) return j(200, { data: S.products });
        const p = { id: 'prod_' + (S.products.length + 1), name: f.get('name'), tax_code: f.get('tax_code'), metadata: { headcount_plan: f.get('metadata[headcount_plan]') } }; S.products.push(p); return j(200, p);
      }
      if (/^\/v1\/products\/prod_\d+$/.test(u.pathname) && req.method === 'POST') { const p = S.products.find((x) => x.id === u.pathname.split('/').pop()); p.tax_code = f.get('tax_code'); return j(200, p); }
      if (u.pathname === '/v1/prices') {
        if (get) return j(200, { data: S.prices.filter((p) => p.product === u.searchParams.get('product')) });
        const p = { id: 'price_' + (S.prices.length + 1), product: f.get('product'), unit_amount: Number(f.get('unit_amount')), currency: f.get('currency'), recurring: { interval: f.get('recurring[interval]'), usage_type: 'licensed' }, tax_behavior: f.get('tax_behavior') || 'unspecified', metadata: { headcount_plan: f.get('metadata[headcount_plan]') } };
        S.prices.push(p); return j(200, p);
      }
      if (u.pathname === '/v1/webhook_endpoints') {
        if (get) return j(200, { data: S.hooks.map(({ secret, ...h }) => h) });
        S.n++; const h = { id: 'we_' + S.n, url: f.get('url'), apiVersion: f.get('api_version'), events: [...f.entries()].filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v), secret: 'whsec_made_' + S.n };
        S.hooks.push(h); return j(200, h);
      }
      if (u.pathname.startsWith('/v1/webhook_endpoints/') && req.method === 'DELETE') { S.hooks = S.hooks.filter((h) => h.id !== u.pathname.split('/').pop()); return j(200, { deleted: true }); }
      if (u.pathname === '/v1/billing_portal/configurations') {
        if (get) return j(200, { data: S.portals });
        const c = { id: 'bpc_' + (S.portals.length + 1), active: true, metadata: { headcount: f.get('metadata[headcount]') }, cancelMode: f.get('features[subscription_cancel][mode]'), returnUrl: f.get('default_return_url') };
        S.portals.push(c); return j(200, c);
      }
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
    if (u.pathname === '/geo/geographies/address') {
      const sp = u.searchParams; mocks.geo.push('S:' + ['street', 'city', 'state', 'zip'].map((k) => sp.get(k) || '').join('|'));
      // Like the Census: units and unknown streets are not found
      if (/nowhere|\bapt\b|#/i.test(sp.get('street') || '')) return j(200, { result: { addressMatches: [] } });
      return j(200, { result: { addressMatches: [{ matchedAddress: '100 MAIN ST, TALLAHASSEE, FL, 32301', geographies: { States: [{ STUSAB: 'FL', STATE: '12' }], '119th Congressional Districts': [{ CD119: '02', BASENAME: '2', STATE: '12' }], '2024 State Legislative Districts - Upper': [{ SLDU: '003', BASENAME: '3', NAME: 'State Senate District 3', STATE: '12' }], '2024 State Legislative Districts - Lower': [{ SLDL: '008', BASENAME: '8', STATE: '12' }] } }] } });
    }
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
  assert.equal((await hook(s1.raw, s1.sig.replace(/v1=(.)/, (_, c) => 'v1=' + (c === '0' ? '1' : '0')))).status, 400);
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
  const setup = ok(await api('alice', 'GET', `/api/workspaces/${W}`)).setup;
  assert.ok(setup && ['clients', 'invites', 'watches', 'contacts'].every((k) => Number.isInteger(setup[k])), 'getting-started counts');
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

test('when Gmail refuses the password, the person running Headcount is told how to fix it, and waiting email goes out after the fix', async () => {
  const { makeMailer, explainMailError } = await import('../server/mail.js');
  const { makeSettings } = await import('../server/settings.js');
  const s2 = mods.db.openDb(':memory:', { billing: false });
  let refuse = true; const sent = [];
  const cfg = { smtpTransport: { sendMail: async (msg) => { if (refuse) { const e = new Error('Invalid login: 535-5.7.8 Username and Password not accepted.'); e.code = 'EAUTH'; throw e; } sent.push(msg); } },
    smtp: { host: 'smtp.gmail.com' }, emailFrom: 'Headcount <n@headcount.test>', publicUrl: 'https://app.test', emailMode: 'smtp' };
  const mailer = makeMailer(cfg, s2);
  mailer.queue({ to: 'new@x.org', subject: 'Confirm your email for Headcount', text: 'Click', kind: 'verify' });
  mailer.queue({ to: 'other@x.org', subject: 'Confirm your email for Headcount', text: 'Click', kind: 'verify' });
  assert.equal(await mailer.work(), 0);
  const pr = mailer.problem();
  assert.ok(pr, 'a failed login is reported'); assert.match(pr.explain, /app password/); assert.match(pr.explain, /myaccount\.google\.com\/apppasswords/);
  assert.equal(s2.db.prepare('SELECT SUM(attempts) n FROM email_queue').get().n, 1, 'stops after the first refusal instead of failing every message');
  assert.ok(makeMailer(cfg, s2).problem(), 'remembered across a restart');
  refuse = false; mailer.reconfigure(); await new Promise((r) => setTimeout(r, 120));
  assert.equal(sent.length, 2, 'both confirmations go out once the password works'); assert.equal(mailer.problem(), null);
  assert.match(explainMailError('connect ETIMEDOUT 1.2.3.4:465', 'smtp.gmail.com'), /could not reach/);
  // Google shows app passwords in four groups; Gmail wants them without the spaces
  const s3 = mods.db.openDb(':memory:', { billing: false }), c3 = {};
  makeSettings(c3, s3).save({ smtpHost: 'smtp.gmail.com', smtpPort: '465', smtpUser: 'me@gmail.com', smtpPass: 'abcd efgh ijkl mnop' });
  assert.equal(c3.smtp.auth.pass, 'abcdefghijklmnop');
});

test('a workspace staff list (a LegiStorm export) fills in staff with real emails, matched to the right office', async () => {
  const rows = [
    ['Ashley Smith', 'Chief of Staff', 'ashley.smith@mail.house.gov', '202-225-5765', 'Rep. Nicholas Begich (R-Alaska)', 'AK', 'At-Large', 'House'],
    ['Pat Lee', 'Scheduler', 'pat.lee@mail.house.gov', '', 'Rep. Nicholas Begich (R-Alaska)', 'AK', 'At-Large', 'House'],
    ['Sam Ruiz', 'Scheduler', 'sam.ruiz@mail.house.gov', '', 'Rep. Adam Smith (D-Wash.)', 'WA', '9', 'House'],
    ['Lee Park', 'Scheduler', 'lee.park@mail.house.gov', '', 'Rep. Jason Smith (R-Mo.)', 'MO', '8', 'House'],
    ['Kim Doe', 'Legislative Aide', 'kim.doe@flsenate.gov', '', 'Sen. Ben Albritton', 'FL', '27', 'Senate'],
    ['', 'No name', 'x@y.org', '', 'Somebody', '', '', ''],
  ];
  ok(await api('alice', 'PATCH', `/api/workspaces/${W}/members/dev:bob`, { role: 'member' }));
  assert.equal((await api('bob', 'PUT', `/api/workspaces/${W}/staff-list`, { rows })).status, 403, 'only admins upload');
  const up = ok(await api('alice', 'PUT', `/api/workspaces/${W}/staff-list`, { source: 'LegiStorm', rows }));
  assert.equal(up.list.count, 5); assert.equal(up.skipped, 1);
  assert.equal(ok(await api('bob', 'GET', `/api/workspaces/${W}/staff-list`)).list.count, 5, 'members see it');
  assert.ok([403, 404].includes((await api('gina', 'GET', `/api/workspaces/${W}/staff-list`)).status), 'guests do not');
  const r = ok(await api('bob', 'POST', `/api/workspaces/${W}/staff-list/match`, { level: 'us', chamber: 'lower', members: [
    { id: 'a', name: 'Nicholas J. Begich III', district: 'AK-AL' }, { id: 'b', name: 'Adam Smith', district: 'WA-9' }, { id: 'c', name: 'Jason Smith', district: 'MO-8' }, { id: 'd', name: 'Nobody Here', district: 'TX-1' }] }));
  assert.deepEqual(r.staff.a.map((x) => x[0]), ['Pat Lee', 'Ashley Smith'], 'scheduler first');
  assert.equal(r.staff.a[1][3], 'ashley.smith@mail.house.gov');
  assert.deepEqual(r.staff.b.map((x) => x[0]), ['Sam Ruiz'], 'two Smiths kept apart by state');
  assert.deepEqual(r.staff.c.map((x) => x[0]), ['Lee Park']);
  assert.equal(r.staff.d, undefined);
  const fl = ok(await api('alice', 'POST', `/api/workspaces/${W}/staff-list/match`, { level: 'state', state: 'FL', chamber: 'upper', members: [{ id: 'e', name: 'Ben Albritton', district: '27' }] }));
  assert.equal(fl.staff.e[0][3], 'kim.doe@flsenate.gov');
  assert.equal(ok(await api('alice', 'DELETE', `/api/workspaces/${W}/staff-list`)).list, null);
  ok(await api('alice', 'PATCH', `/api/workspaces/${W}/members/dev:bob`, { role: 'admin' }));
});

test('the public record: which questions count as a vote on the bill, and reading House and Senate roll calls', async () => {
  const { stance, parseHouseRoll, parseSenateRoll } = await import('../server/record.js');
  assert.equal(stance('On Passage'), 'for'); assert.equal(stance('On Motion to Concur in the Senate Amendment'), 'for');
  assert.equal(stance('Passage, Third Reading'), 'for'); assert.equal(stance('Favorable with Committee Substitute'), 'for');
  assert.equal(stance('On Motion to Recommit'), ''); assert.equal(stance('On the Cloture Motion'), ''); assert.equal(stance('On the Amendment (Smith Amdt. No. 3)'), '');
  assert.equal(stance('On the Motion (Warnock Motion to Commit H.R. 1 to the Committee on Finance)'), '');
  const h = parseHouseRoll('<rollcall-vote><vote-metadata><vote-question>On Passage</vote-question><vote-result>Passed</vote-result><action-date>10-Apr-2025</action-date></vote-metadata><vote-data><recorded-vote><legislator name-id="B001323" sort-field="Begich" unaccented-name="Begich" party="R" state="AK" role="legislator">Begich</legislator><vote>Yea</vote></recorded-vote><recorded-vote><legislator name-id="A000370" unaccented-name="Adams" party="D" state="NC" role="legislator">Adams</legislator><vote>No</vote></recorded-vote></vote-data></rollcall-vote>');
  assert.equal(h.date, '2025-04-10'); assert.deepEqual(h.votes.map((v) => [v.id, v.v]), [['B001323', 'yes'], ['A000370', 'no']]);
  const sn = parseSenateRoll('<roll_call_vote><vote_date>July 1, 2025, 11:59 AM</vote_date><vote_question_text>On Passage of the Bill H.R. 1</vote_question_text><members><member><last_name>Alsobrooks</last_name><first_name>Angela</first_name><state>MD</state><vote_cast>Nay</vote_cast></member><member><last_name>Murkowski</last_name><state>AK</state><vote_cast>Not Voting</vote_cast></member></members></roll_call_vote>');
  assert.equal(sn.date, '2025-07-01'); assert.deepEqual(sn.votes.map((v) => [v.last, v.state, v.v]), [['Alsobrooks', 'MD', 'no'], ['Murkowski', 'AK', 'other']]);
});

test('Continue with Google: the token is checked against Google\'s keys and this site, then signs in or makes the account', async () => {
  const { verifyGoogleIdToken } = await import('../server/auth.js');
  const { makeAccounts } = await import('../server/accounts.js');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const certs = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => certs.listen(0, r));
  const certsUrl = `http://127.0.0.1:${certs.address().port}/certs`, clientId = '123-abc.apps.googleusercontent.com';
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims, key = privateKey) => { const h = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), p = b64u(claims); return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`; };
  const now = Math.floor(Date.now() / 1000), good = { iss: 'https://accounts.google.com', aud: clientId, sub: 'g-111', email: 'Dana@Example.org', email_verified: true, name: 'Dana Lee', iat: now, exp: now + 3600 };
  try {
    assert.deepEqual(await verifyGoogleIdToken(sign(good), { clientId, certsUrl }), { sub: 'g-111', email: 'dana@example.org', name: 'Dana Lee' });
    await assert.rejects(verifyGoogleIdToken(sign({ ...good, aud: 'someone-else.apps.googleusercontent.com' }), { clientId, certsUrl }), /different site/);
    await assert.rejects(verifyGoogleIdToken(sign({ ...good, exp: now - 600 }), { clientId, certsUrl }), /expired/);
    await assert.rejects(verifyGoogleIdToken(sign({ ...good, email_verified: false }), { clientId, certsUrl }), /not confirmed/);
    await assert.rejects(verifyGoogleIdToken(sign(good, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), { clientId, certsUrl }), /could not be checked/);
    // An existing account with that email is linked, not duplicated; a new email makes an account.
    const s2 = mods.db.openDb(':memory:', { billing: false }), acc = makeAccounts({}, s2);
    const first = await acc.signup({ name: 'Dana Lee', email: 'dana@example.org', password: 'a long sample password' }, 'test');
    const r = await acc.googleSignIn({ sub: 'g-111', email: 'dana@example.org', name: 'Dana' }, 'test');
    assert.equal(r.user.id, first.user.id); assert.equal(r.user.google, true); assert.equal(r.user.emailVerified, true); assert.ok(r.token);
    const n = await acc.googleSignIn({ sub: 'g-222', email: 'sam@example.org', name: 'Sam Ruiz' }, 'test');
    assert.equal(n.created, true); assert.equal(n.user.name, 'Sam Ruiz');
    assert.equal((await acc.googleSignIn({ sub: 'g-222', email: 'sam@example.org', name: 'Sam' }, 'test')).user.id, n.user.id);
    await assert.rejects(acc.googleSignIn({ sub: 'g-999', email: 'dana@example.org', name: 'Not Dana' }, 'test'), /different Google account/);
    s2.putSetting('cfg.signups', 'invite');
    await assert.rejects(acc.googleSignIn({ sub: 'g-333', email: 'new@example.org', name: 'New' }, 'test'), /need an invitation/);
  } finally { certs.close(); }
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
  assert.match(h, /Count the votes on your bill/); assert.match(h, /Start a 14-day trial/); assert.doesNotMatch(h, /aren&#39;t on sale|aren.t on sale/); assert.match(h, /<svg/); assert.doesNotMatch(h, /\{\{\w+\}\}/);
  const pricing = await (await fetch(base + '/pricing')).text();
  assert.match(pricing, /<td>3<\/td>/); assert.match(pricing, /Sign in through your firm&#39;s own login page|Sign in through your firm's own login page/); assert.doesNotMatch(pricing, /SAML|OIDC/); assert.doesNotMatch(pricing, /\{\{\w+\}\}/);
  const guide = await (await fetch(base + '/guide')).text();
  assert.match(guide, /How to use Headcount/); assert.doesNotMatch(guide, /\{\{\w+\}\}/, 'every placeholder filled'); assert.match(guide, /src="\/site\/img\/guide-new\.png"/);
  for (const pth of ['/security', '/privacy', '/terms', '/site/img/guide-start.png', '/site/site.css', '/site/site.js', '/app', '/app/', '/invite/abcdefgh12']) assert.equal((await fetch(base + pth)).status, 200, pth);
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
  const pat = await post('/api/auth/signup', { name: 'Pat Partner', email: 'pat@firm.test', password: 'partner password 1', workspace: '  Partner   Strategies ' });
  assert.equal(pat.body.operator, false); assert.equal((await me(pat.body.token)).body.operator, false);
  // Naming the firm at sign-up starts them in their own workspace, as its owner
  const patWs = (await me(pat.body.token)).body.workspaces;
  assert.equal(patWs.length, 1); assert.equal(patWs[0].name, 'Partner Strategies'); assert.equal(patWs[0].role, 'owner');
  assert.equal((await me(first.body.token)).body.workspaces.length, 0, 'no name, no workspace');
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
  // Customers: every workspace on the server, operator only
  const c = await fetch(base + '/api/settings/customers', { headers: { Authorization: 'Bearer ' + op } }).then((r) => r.json());
  assert.ok(c.totals.workspaces >= 1 && c.workspaces.length === c.totals.workspaces);
  assert.ok(c.workspaces.every((w) => typeof w.name === 'string' && typeof w.plan === 'string' && Number.isInteger(w.people)));
  assert.equal((await fetch(base + '/api/settings/customers', { headers: { Authorization: 'Bearer ' + ivy } })).status, 403);
});

// ---------- two-step sign-in ----------
test('two-step sign-in: authenticator codes, one use each, recovery codes, a reset does not get past it', async () => {
  const { totp } = await import('../server/accounts.js');
  mods.config.trustProxy = true; // its own address, so the sign-in limits of earlier tests do not apply
  try {
    const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' };
    const post = (p, b, token) => fetch(base + p, { method: 'POST', headers: { ...H, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const me = (token) => fetch(base + '/api/me', { headers: { ...H, Authorization: 'Bearer ' + token } }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const creds = { email: 'tess@firm.test', password: 'tess long password' };
    const tess = (await post('/api/auth/signup', { name: 'Tess Two', ...creds })).body.token;
    const other = (await post('/api/auth/login', creds)).body.token;
    assert.equal((await me(tess)).body.user.twoFactor, false);
    // Set up: a QR code and a key; a wrong code does not turn it on
    const st = await post('/api/auth/2fa/start', {}, tess);
    assert.match(st.body.uri, /^otpauth:\/\/totp\/Headcount%3Atess%40firm\.test\?secret=[A-Z2-7]{32}&issuer=Headcount/);
    assert.match(st.body.qr, /^<svg [^>]*viewBox/); assert.match(st.body.qr, /<path fill="#000" d="M/);
    const secret = st.body.secret.replace(/ /g, ''), step = Math.floor(Date.now() / 30000);
    const wrong = String((Number(totp(secret)) + 500000) % 1e6).padStart(6, '0');
    assert.equal((await post('/api/auth/2fa/enable', { code: wrong }, tess)).status, 400);
    const en = await post('/api/auth/2fa/enable', { code: totp(secret, step) }, tess);
    assert.equal(en.status, 200); assert.equal(en.body.recovery.length, 10); assert.match(en.body.recovery[0], /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    const row = store.db.prepare("SELECT totp_secret, recovery FROM accounts WHERE email = 'tess@firm.test'").get();
    assert.match(row.totp_secret, /^enc:v1:/, 'the secret is encrypted at rest'); assert.equal(row.recovery.includes(en.body.recovery[0]), false, 'recovery codes stored only as hashes');
    assert.equal((await me(other)).status, 401, 'other devices are signed out');
    const m = await me(tess); assert.equal(m.body.user.twoFactor, true); assert.equal(m.body.recoveryLeft, 10);
    // The password alone gives a ticket, not a session
    const l1 = await post('/api/auth/login', creds);
    assert.equal(l1.body.twoFactor, true); assert.equal(l1.body.token, undefined); assert.ok(l1.body.ticket);
    assert.equal((await post('/api/auth/login/code', { ticket: l1.body.ticket, code: totp(secret, step) })).status, 400, 'a code works once');
    const ok = await post('/api/auth/login/code', { ticket: l1.body.ticket, code: totp(secret, step + 1) });
    assert.equal(ok.status, 200); assert.match(ok.body.token, /^s\./); assert.equal(ok.body.recoveryLeft, undefined);
    assert.equal((await post('/api/auth/login/code', { ticket: l1.body.ticket, code: totp(secret, step + 1) })).status, 401, 'a ticket works once');
    // A recovery code, in any case and spacing, works once
    const rc = en.body.recovery[0];
    const l2 = await post('/api/auth/login', creds);
    const r2 = await post('/api/auth/login/code', { ticket: l2.body.ticket, code: ' ' + rc.toUpperCase().replace('-', ' ') });
    assert.equal(r2.status, 200); assert.equal(r2.body.recoveryLeft, 9);
    // Five wrong tries end the ticket
    const l3 = await post('/api/auth/login', creds);
    for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/login/code', { ticket: l3.body.ticket, code: i ? wrong : rc })).status, 400);
    assert.equal((await post('/api/auth/login/code', { ticket: l3.body.ticket, code: en.body.recovery[1] })).status, 401);
    // A password reset by email still asks for the code
    await post('/api/auth/reset-request', { email: 'tess@firm.test' });
    const mail = store.db.prepare("SELECT * FROM email_queue WHERE kind = 'reset' AND to_addr = 'tess@firm.test'").get();
    const rs = await post('/api/auth/reset', { token: /#reset=([A-Za-z0-9_-]+)/.exec(mail.text_body)[1], password: 'tess newer password' });
    assert.equal(rs.status, 200); assert.equal(rs.body.twoFactor, true); assert.equal(rs.body.token, undefined);
    const after = await post('/api/auth/login/code', { ticket: rs.body.ticket, code: en.body.recovery[2] });
    assert.equal(after.status, 200);
    // New recovery codes replace the old ones; turning it off needs the password and a code
    const nr = await post('/api/auth/2fa/recovery', { code: en.body.recovery[3] }, after.body.token);
    assert.equal(nr.body.recovery.length, 10);
    assert.equal((await post('/api/auth/2fa/disable', { password: 'wrong password!!', code: nr.body.recovery[0] }, after.body.token)).status, 400);
    assert.equal((await post('/api/auth/2fa/disable', { password: 'tess newer password', code: en.body.recovery[4] }, after.body.token)).status, 400, 'old recovery codes no longer work');
    assert.equal((await post('/api/auth/2fa/disable', { password: 'tess newer password', code: nr.body.recovery[0] }, after.body.token)).status, 200);
    const plain = await post('/api/auth/login', { email: 'tess@firm.test', password: 'tess newer password' });
    assert.match(plain.body.token, /^s\./, 'off again: the password is enough');
  } finally { mods.config.trustProxy = false; }
});

test('a workspace can require two-step sign-in: Team plan, the admin first, members blocked until they turn it on', async () => {
  const { totp } = await import('../server/accounts.js');
  mods.config.trustProxy = true;
  try {
    const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.78' };
    const call = (method, p, b, token) => fetch(base + p, { method, headers: { ...H, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const uma = (await call('POST', '/api/auth/signup', { name: 'Uma Owner', email: 'uma@firm.test', password: 'uma long password', workspace: 'Uma Strategies' })).body.token;
    const vic = (await call('POST', '/api/auth/signup', { name: 'Vic Member', email: 'vic@firm.test', password: 'vic long password' })).body.token;
    const UW = (await call('GET', '/api/me', null, uma)).body.workspaces[0].id;
    const inv = await call('POST', `/api/workspaces/${UW}/invites`, { role: 'member' }, uma);
    assert.equal((await call('POST', `/api/workspace-invites/${inv.body.code}`, {}, vic)).status, 200);
    let info = (await call('GET', `/api/workspaces/${UW}`, null, uma)).body;
    assert.deepEqual(info.security, { require2fa: false, people: 2, withCode: 0, elsewhere: 0 });
    assert.equal((await call('GET', `/api/workspaces/${UW}`, null, vic)).body.security.people, undefined, 'counts are for admins');
    // Members cannot change it; the admin needs it on first
    assert.equal((await call('PATCH', `/api/workspaces/${UW}/security`, { require2fa: true }, vic)).status, 403);
    const first = await call('PATCH', `/api/workspaces/${UW}/security`, { require2fa: true }, uma);
    assert.equal(first.status, 400); assert.match(first.body.error, /your own account first/);
    const st = await call('POST', '/api/auth/2fa/start', {}, uma), secret = st.body.secret.replace(/ /g, '');
    assert.equal((await call('POST', '/api/auth/2fa/enable', { code: totp(secret) }, uma)).status, 200);
    assert.equal((await call('PATCH', `/api/workspaces/${UW}/security`, { require2fa: true }, uma)).status, 200);
    info = (await call('GET', `/api/workspaces/${UW}`, null, uma)).body;
    assert.equal(info.security.require2fa, true); assert.equal(info.security.withCode, 1);
    // Vic is blocked from the workspace and told why, until Vic turns it on
    const me = (await call('GET', '/api/me', null, vic)).body.workspaces.find((w) => w.id === UW);
    assert.equal(me.twoFactorRequired, true);
    const blocked = await call('GET', `/api/workspaces/${UW}`, null, vic);
    assert.equal(blocked.status, 403); assert.equal(blocked.body.twoFactor, true); assert.equal(blocked.body.workspace, 'Uma Strategies');
    const vs = await call('POST', '/api/auth/2fa/start', {}, vic);
    assert.equal((await call('POST', '/api/auth/2fa/enable', { code: totp(vs.body.secret.replace(/ /g, '')) }, vic)).status, 200);
    assert.equal((await call('GET', `/api/workspaces/${UW}`, null, vic)).status, 200);
    assert.equal((await call('GET', '/api/me', null, vic)).body.workspaces.find((w) => w.id === UW).twoFactorRequired, false);
    // The change is in the audit log
    const audit = await call('GET', `/api/workspaces/${UW}/audit`, null, uma);
    assert.ok(JSON.stringify(audit.body).includes('two-step sign-in required'));
  } finally { mods.config.trustProxy = false; }
});

test('calendar feed: votes, sent meeting invitations and my follow-ups, on a private link that can be replaced', async () => {
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10), compact = (d) => d.replace(/-/g, '');
  ok(await api('alice', 'POST', `/api/campaigns/${C1}/records`, { ops: [
    { kind: 'summary', data: { odds: 0.6, side: 'pass', cmteDate: day(2), floorDate: day(9), trend: [], meetings: [] } },
    { kind: 'meetings', id: 'mt1', data: { id: 'mt1', status: 'invited', start: day(1) + 'T15:00:00.000Z', mins: 45, title: 'Meeting with Sen. Vega, re: SB 214', where: 'Capitol; Room 214' } },
    { kind: 'meetings', id: 'mt2', data: { id: 'mt2', status: 'requested', proposed: [], title: 'Not yet scheduled' } },
    { kind: 'tasks', id: 'tc1', data: { id: 'tc1', text: 'Send the one-pager, with the fiscal note and the coalition letter attached for the committee staff', due: day(3), done: false } },
    { kind: 'tasks', id: 'tc2', data: { id: 'tc2', text: 'Somebody else follows up', due: day(3), done: false, assignee: 'dev:bob' } },
  ] }));
  const { url } = ok(await api('alice', 'GET', '/api/me/calendar'));
  const path1 = new URL(url).pathname;
  assert.match(path1, /^\/api\/calendar\/[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{32}\.ics$/);
  const r = await fetch(base + path1);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/calendar/);
  const body = await r.text();
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n') && body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(body.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'long lines are folded');
  const flat = body.replace(/\r\n /g, '');
  assert.ok(flat.includes(`DTSTART;VALUE=DATE:${compact(day(2))}\r\nDTEND;VALUE=DATE:${compact(day(3))}`));
  assert.ok(flat.includes('SUMMARY:Committee vote: SB 214')); assert.ok(flat.includes('SUMMARY:Floor vote: SB 214'));
  assert.ok(flat.includes(`DTSTART:${compact(day(1))}T150000Z\r\nDTEND:${compact(day(1))}T154500Z`));
  assert.ok(flat.includes(String.raw`LOCATION:Capitol\; Room 214`));
  assert.ok(flat.includes('SUMMARY:Follow-up: Send the one-pager\\, with the fiscal note and the coalition letter attached for the committee staff'));
  assert.equal(flat.includes('Somebody else'), false, 'only my follow-ups and unassigned ones');
  assert.equal(flat.includes('Not yet scheduled'), false, 'only meetings with an invitation sent');
  // Bob sees his own feed: his follow-up, not alice's unassigned... both see unassigned
  const bob = await (await fetch(base + new URL(ok(await api('bob', 'GET', '/api/me/calendar')).url).pathname)).text();
  assert.ok(bob.replace(/\r\n /g, '').includes('Somebody else follows up'));
  // A forged link fails, and a new link ends the old one
  assert.equal((await fetch(base + path1.replace(/.{6}\.ics$/, 'AAAAAA.ics'))).status, 404);
  const { url: url2 } = ok(await api('alice', 'POST', '/api/me/calendar'));
  assert.notEqual(url2, url);
  assert.equal((await fetch(base + path1)).status, 404);
  assert.equal((await fetch(base + new URL(url2).pathname)).status, 200);
});

// ---------- payments setup ----------
test('connecting Stripe from one key: plans, prices, webhook and billing page made once; prices change safely', async () => {
  const { setupStripe, HOOK_EVENTS, readDollars } = await import('../server/stripe-setup.js');
  const { planForPrice } = await import('../server/billing.js');
  const sbase = mods.config.stripeBase, publicUrl = 'https://hc.example.org', key = 'sk_test_' + 'k'.repeat(24);
  await assert.rejects(setupStripe({ base: sbase, key: 'pk_test_' + 'a'.repeat(24), publicUrl, team: 45 }), /does not look like a Stripe key/);
  await assert.rejects(setupStripe({ base: sbase, key, publicUrl: 'http://localhost:3000', team: 45 }), /public web address/);
  await assert.rejects(setupStripe({ base: sbase, key: 'sk_test_bad' + 'a'.repeat(20), publicUrl, team: 45 }), /did not accept that key/);
  assert.throws(() => readDollars('', 'the Team plan'), /Enter a price/); assert.throws(() => readDollars('0.5', 'Team'), /between 1 and 10,000/);
  assert.equal(readDollars('$1,200', 'Team'), 1200); assert.equal(readDollars('', 'Firm', true), null);
  const S = mocks.so;
  const r = await setupStripe({ base: sbase, key, publicUrl, team: 45, firm: 75 });
  assert.equal(r.account, 'Capitol Strategies'); assert.equal(r.live, false); assert.equal(r.chargesEnabled, false);
  assert.deepEqual(S.products.map((p) => [p.name, p.metadata.headcount_plan, p.tax_code]), [['Headcount Team', 'team', 'txcd_10103001'], ['Headcount Firm', 'firm', 'txcd_10103001']]);
  assert.deepEqual(S.prices.map((p) => [p.unit_amount, p.currency, p.recurring.interval, p.metadata.headcount_plan]), [[4500, 'usd', 'month', 'team'], [7500, 'usd', 'month', 'firm']]);
  assert.equal(S.hooks.length, 1); assert.equal(S.hooks[0].url, 'https://hc.example.org/api/stripe/webhook'); assert.deepEqual(S.hooks[0].events, HOOK_EVENTS);
  assert.equal(S.portals.length, 1); assert.equal(S.portals[0].cancelMode, 'at_period_end'); assert.equal(S.portals[0].returnUrl, 'https://hc.example.org/app');
  assert.deepEqual(r.settings, { stripeKey: key, stripeWebhookSecret: S.hooks[0].secret, stripeWebhookId: S.hooks[0].id, stripePortalConfig: 'bpc_1', stripePriceTeam: 'price_1', stripePriceFirm: 'price_2',
    priceLabelTeam: '$45 per person a month', priceLabelFirm: '$75 per person a month', stripeAccount: 'Capitol Strategies (test mode)', stripeTax: 'managed' });
  // Again, with a new Team price: nothing is duplicated, the webhook is replaced
  const r2 = await setupStripe({ base: sbase, key, publicUrl, team: 55, firm: 75 });
  assert.equal(S.products.length, 2); assert.equal(S.prices.length, 3); assert.equal(S.portals.length, 1); assert.equal(S.hooks.length, 1);
  assert.equal(r2.settings.stripePriceTeam, 'price_3'); assert.equal(r2.settings.stripePriceFirm, 'price_2'); assert.notEqual(r2.settings.stripeWebhookSecret, r.settings.stripeWebhookSecret);
  assert.equal((await setupStripe({ base: sbase, key, publicUrl, team: 55 })).settings.stripePriceFirm, '', 'the Firm plan is optional');
  // Subscribers stay on their plan after prices change, because prices carry the plan
  assert.equal(planForPrice({ stripePriceFirm: 'price_new' }, { id: 'price_2', metadata: { headcount_plan: 'firm' } }), 'firm');
  assert.equal(planForPrice({ stripePriceFirm: 'price_f' }, { id: 'price_f' }), 'firm');
  assert.equal(planForPrice({ stripePriceFirm: 'price_f' }, { id: 'price_x' }), 'team');
  // On this test server Stripe comes from the host's settings, so the app cannot change it
  mods.config.trustProxy = true;
  try {
    const H = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.79' };
    const op = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'olivia@firm.test', password: 'the final password' }) })).json()).token;
    const res = await fetch(base + '/api/settings/stripe', { method: 'POST', headers: { ...H, Authorization: 'Bearer ' + op }, body: JSON.stringify({ key, team: 45 }) });
    assert.equal(res.status, 409);
  } finally { mods.config.trustProxy = false; }
});

test('Stripe best practices: a pinned API version, restricted keys, sales tax only with a registration', async () => {
  const { setupStripe, HOOK_EVENTS } = await import('../server/stripe-setup.js');
  const { STRIPE_VERSION } = await import('../server/billing.js');
  const sbase = mods.config.stripeBase, publicUrl = 'https://hc.example.org', S = mocks.so;
  mocks.stripe.length = 0;
  // A restricted key cannot read the account; that is fine
  const r = await setupStripe({ base: sbase, key: 'rk_test_' + 'r'.repeat(24), publicUrl, team: 45 });
  assert.equal(r.account, 'your Stripe account'); assert.equal(r.settings.stripeKey.slice(0, 8), 'rk_test_');
  assert.ok(mocks.stripe.every((x) => x.version === STRIPE_VERSION), 'every request names the API version');
  const hook = S.hooks.at(-1);
  assert.equal(hook.apiVersion, STRIPE_VERSION, 'webhook payloads use the same version');
  for (const e of ['invoice.paid', 'charge.dispute.created', 'charge.refunded', 'radar.early_fraud_warning.created', 'checkout.session.async_payment_succeeded']) assert.ok(hook.events.includes(e), e);
  assert.deepEqual(hook.events, HOOK_EVENTS);
  // Sales tax: refused until Stripe knows where you are registered
  await assert.rejects(setupStripe({ base: sbase, key: 'sk_test_' + 'k'.repeat(24), publicUrl, team: 45, taxMode: 'stripe_tax' }), /Tax, then Registrations/);
  S.taxRegs = [{ id: 'taxreg_1', status: 'active', country: 'US' }];
  const t = await setupStripe({ base: sbase, key: 'sk_test_' + 'k'.repeat(24), publicUrl, team: 45, taxMode: 'stripe_tax' });
  assert.equal(t.settings.stripeTax, 'stripe_tax');
  assert.ok(S.prices.filter((p) => p.unit_amount === 4500).every((p) => p.tax_behavior === 'exclusive'), 'tax is added on top of the price');
  S.taxRegs = [];
  // Managed Payments (the default): checked with a checkout that is opened and closed at once
  mocks.stripe.length = 0;
  const m = await setupStripe({ base: sbase, key: 'sk_test_' + 'k'.repeat(24), publicUrl, team: 45 });
  assert.equal(m.settings.stripeTax, 'managed');
  const probe = mocks.stripe.find((x) => x.path === '/v1/checkout/sessions');
  assert.equal(probe.form.get('managed_payments[enabled]'), 'true'); assert.equal(probe.form.get('mode'), 'subscription');
  assert.ok(mocks.stripe.some((x) => x.path === '/v1/checkout/sessions/cs_1/expire'), 'the check is closed straight away');
  await assert.rejects(setupStripe({ base: sbase, key: 'sk_test_' + 'k'.repeat(24), publicUrl, team: 45, taxMode: 'vat' }), /Choose how sales tax/);
  // What each choice sends at checkout
  const { taxParams } = await import('../server/billing.js');
  assert.deepEqual(taxParams({ stripeTax: 'managed' }), { managed_payments: { enabled: 'true' } });
  assert.deepEqual(taxParams({ stripeTax: 'none' }), { managed_payments: { enabled: 'false' } });
  assert.equal(taxParams({ stripeTax: 'stripe_tax' }).automatic_tax.enabled, 'true'); assert.equal(taxParams({ stripeTax: 'stripe_tax' }).managed_payments.enabled, 'false');
  assert.deepEqual(taxParams({ stripeTax: '' }), {}, 'set by the host: the Stripe account decides');
});

test('Stripe events: checkout tagging, renewals, disputes, refunds and fraud warnings reach the right people', async () => {
  mocks.stripe.length = 0;
  // Checkout carries the integration tag and the API version
  const W2 = ok(await api('alice', 'POST', '/api/workspaces', { name: 'Tagged Co' })).id;
  ok(await api('alice', 'POST', `/api/workspaces/${W2}/billing/checkout`, { seats: 2 }));
  const sess = mocks.stripe.find((x) => x.path === '/v1/checkout/sessions');
  assert.match(sess.form.get('integration_identifier'), /^headcount_\w+_[a-z]{8}$/); assert.equal(sess.form.get('automatic_tax[enabled]'), null, 'no tax unless turned on');
  const { STRIPE_VERSION } = await import('../server/billing.js');
  assert.equal(sess.version, STRIPE_VERSION);
  const send = async (event) => { const s = signed(event); return hook(s.raw, s.sig); };
  const auditOf = (oid) => store.db.prepare('SELECT action, detail FROM audit WHERE org_id = ? ORDER BY id').all(oid).map((x) => x.action);
  const opEmail = store.q.user.get(store.setting('operator')).email;
  const riskMail = () => store.db.prepare("SELECT * FROM email_queue WHERE kind = 'billing' AND to_addr = ? ORDER BY id").all(opEmail);
  // A dispute on a charge from W's customer: logged on W, emailed to whoever runs Headcount
  assert.equal((await send({ id: 'evt_dp1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 22500, currency: 'usd', reason: 'fraudulent' } } })).status, 200);
  assert.ok(auditOf(W).includes('billing.disputed'));
  const dm = riskMail().find((m) => /disputed/.test(m.subject));
  assert.ok(dm, 'the operator hears about it'); assert.match(dm.text_body, /\$225\.00/); assert.match(dm.text_body, /dashboard\.stripe\.com\/payments\/ch_1/);
  assert.equal((await send({ id: 'evt_dp1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1' } } })).status, 200);
  assert.equal(riskMail().filter((m) => /disputed/.test(m.subject)).length, 1, 'each event is handled once');
  // A refund and an early fraud warning
  assert.equal((await send({ id: 'evt_rf1', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge', customer: 'cus_1', amount_refunded: 4500, currency: 'usd' } } })).status, 200);
  assert.equal((await send({ id: 'evt_efw1', type: 'radar.early_fraud_warning.created', data: { object: { id: 'issfr_1', charge: 'ch_1', fraud_type: 'made_with_stolen_card' } } })).status, 200);
  assert.ok(auditOf(W).includes('billing.refunded') && auditOf(W).includes('billing.fraud_warning'));
  assert.ok(riskMail().some((m) => /refunded/.test(m.subject)) && riskMail().some((m) => /possible fraud/.test(m.subject)));
  // A renewal that goes through after a failure brings the plan back
  store.db.prepare("UPDATE orgs SET status = 'past_due', stripe_subscription = 'sub_1', stripe_item = 'si_1' WHERE id = ?").run(W);
  mocks.sub = subscription(W, 5, 'active');
  assert.equal((await send({ id: 'evt_ip1', type: 'invoice.paid', data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } } } })).status, 200);
  assert.equal(store.q.org.get(W).status, 'active');
  // A bank payment that clears later unlocks the plan through the same path as checkout
  mocks.stripe.length = 0;
  assert.equal((await send({ id: 'evt_as1', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_2', client_reference_id: W, customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid' } } })).status, 200);
  assert.ok(mocks.stripe.some((x) => x.path === '/v1/subscriptions/sub_1' && x.method === 'GET'));
});

// ---------- action center addresses ----------
test('action center addresses: filled-in fields, unit numbers, district spellings, and a way through when an address is not found', async () => {
  const { normDistrict, stripUnit } = await import('../server/sources.js');
  // District names written differently by different sources
  assert.equal(normDistrict('1st Middlesex'), normDistrict('First Middlesex'));
  assert.equal(normDistrict('Berkshire, Hampden, Franklin & Hampshire'), normDistrict('Berkshire, Hampden, Franklin and Hampshire'));
  assert.equal(normDistrict('District 003'), '3'); assert.equal(normDistrict('State Senate District 12'), '12'); assert.equal(normDistrict('3A'), '3a'); assert.equal(normDistrict('Grafton 12'), 'grafton 12');
  assert.equal(stripUnit('100 Main St Apt 4B'), '100 Main St'); assert.equal(stripUnit('100 Main St, Suite 200'), '100 Main St'); assert.equal(stripUnit('100 Main St #4'), '100 Main St'); assert.equal(stripUnit('12 Unity Way'), '12 Unity Way');
  // A Florida Senate campaign whose targets spell their districts differently
  const targets = [{ id: 's3', name: 'Corey Simon', district: 'District 003', email: 'simon.corey@flsenate.gov' }, { id: 's12', name: 'Ana Ruiz', district: '12', email: 'ruiz@flsenate.gov' }];
  const id = ok(await api('mona', 'PUT', `/api/campaigns/${MC}/action`, { title: 'Back rural broadband', letter: 'Please vote yes on SB 214.', juris: { level: 'state', state: 'FL', chamber: 'upper' }, targets, active: true })).action.id;
  const pub = await (await fetch(`${base}/api/act/${id}`)).json();
  assert.equal(pub.state, 'FL', 'the form starts on the campaign state');
  assert.deepEqual(pub.members.map((m) => m.id), ['s3', 's12']); assert.equal(pub.members[0].email, undefined, 'no office emails on the public page');
  mods.config.trustProxy = true; // its own address, so the earlier letters do not count against this test's limit
  const post = (p, b) => fetch(`${base}/api/act/${id}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.80' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
  // Filled-in fields with an apartment number: found by trying again without it
  mocks.geo.length = 0;
  const look = await post('/lookup', { address: { street: '100 Main St Apt 4B', city: 'Tallahassee', state: 'FL', zip: '32301-1234' } });
  assert.equal(look.status, 200); assert.deepEqual(look.body.members.map((m) => m.name), ['Corey Simon']);
  assert.equal(look.body.address, '100 MAIN ST, TALLAHASSEE, FL, 32301');
  assert.deepEqual(mocks.geo, ['S:100 Main St Apt 4B|Tallahassee|FL|32301', 'S:100 Main St|Tallahassee|FL|32301']);
  // Found, but in a district the campaign is not asking: say which one
  ok(await api('mona', 'PUT', `/api/campaigns/${MC}/action`, { title: 'Back rural broadband', letter: 'Please vote yes on SB 214.', juris: { level: 'state', state: 'FL', chamber: 'upper' }, targets: [targets[1]], active: true }));
  const other = await post('/lookup', { address: { street: '100 Main St', city: 'Tallahassee', state: 'FL', zip: '32301' } });
  assert.deepEqual(other.body.members, []); assert.equal(other.body.where, 'State Senate District 3');
  ok(await api('mona', 'PUT', `/api/campaigns/${MC}/action`, { title: 'Back rural broadband', letter: 'Please vote yes on SB 214.', juris: { level: 'state', state: 'FL', chamber: 'upper' }, targets, active: true }));
  // Not found at all: marked so the page can offer the list, never "you are not in the district"
  const lost = await post('/lookup', { address: { street: '1 Nowhere Rd', city: 'Nowhere', state: 'FL', zip: '32399' } });
  assert.equal(lost.status, 404); assert.equal(lost.body.notFound, true); assert.doesNotMatch(lost.body.error, /represent/);
  assert.equal((await post('/lookup', { address: { street: '', city: 'Tallahassee', state: 'FL', zip: '' } })).status, 400);
  // ...and they can pick their legislator; the office is told the address was not matched
  assert.equal((await post('/send', { name: 'Lee Rural', email: 'lee@example.net', address: { street: '1 Nowhere Rd', city: 'Nowhere', state: 'FL', zip: '32399' }, memberId: 'nobody' })).status, 400);
  const picked = await post('/send', { name: 'Lee Rural', email: 'lee@example.net', address: { street: '1 Nowhere Rd', city: 'Nowhere', state: 'FL', zip: '32399' }, memberId: 's12' });
  assert.equal(picked.status, 200); assert.deepEqual(picked.body.emailed, ['Ana Ruiz']);
  const note = emailsTo('ruiz@flsenate.gov', 'constituent').at(-1);
  assert.match(note.text_body, /Lee Rural\n1 Nowhere Rd, Nowhere, FL 32399/); assert.match(note.text_body, /could not be matched automatically/);
  // A picked legislator does not override an address that can be found
  const real = await post('/send', { name: 'Sam Town', email: 'sam@example.net', address: { street: '100 Main St', city: 'Tallahassee', state: 'FL', zip: '32301' }, memberId: 's12' });
  assert.deepEqual(real.body.emailed, ['Corey Simon']);
  assert.doesNotMatch(emailsTo('simon.corey@flsenate.gov', 'constituent').at(-1).text_body, /could not be matched/);
  } finally { mods.config.trustProxy = false; }
});

// ---------- official lists and staff ----------
test('official lists: reading the official pages, keeping returning members, staff in the usual email format', async () => {
  const o = await import('../server/officials.js');
  // Florida Senate list, with a vacant seat left out
  const senList = `<a class="senatorLink" href="/Senators/2026-2028/S1"><img width="50" alt="Senator Don Gaetz" src="a.jpg" class="t">Gaetz, Don</a>\n</th>\n<td class="middle">1</td>\n<td class="middle">Republican</td>
    <a class="senatorLink" href="/Senators/2026-2028/S39"><img alt="Senator" src="n.jpg">Vacant</a></th><td class="middle">39</td><td class="middle"></td>`;
  assert.deepEqual(o.parseSenateList(senList), [{ path: '/Senators/s1', display: 'Don Gaetz', sortName: 'Gaetz, Don', district: '1', party: 'R' }]);
  const sen = o.parseSenator(`<p>Contact:</p><a>Email this Senator</a><a>gaetz.don.web@flsenate.gov</a><h4>District Office</h4><p>418 West Garden Street<br>Pensacola, FL 32502</p><p>(850) 595-1036</p><p>Senate VOIP: 40100</p>
    <h4>Legislative Aides</h4><p>Xuripha Barrow, Frank Fuller, and Keri Pitzer</p><h4>Tallahassee Office</h4><p>405 Senate Building<br>Tallahassee, FL 32399-1100</p><p>(850) 487-5001</p>`);
  assert.equal(sen.email, 'gaetz.don.web@flsenate.gov'); assert.equal(sen.district.phone, '850-595-1036'); assert.equal(sen.capitol.phone, '850-487-5001');
  assert.equal(sen.district.address, '418 West Garden Street, Pensacola, FL 32502'); assert.deepEqual(sen.aides, ['Xuripha Barrow', 'Frank Fuller', 'Keri Pitzer']);
  // Florida House list and a member page
  const houseList = `<a href="/Sections/Representatives/details.aspx?MemberId=4920&LegislativeTermId=92" role="link"><div class="team-txt"><h5> Conerly, William "Bill" </h5><p>Republican &mdash; <span class="text-nowrap">District: 72</span></p></div></a>`;
  assert.deepEqual(o.parseHouseList(houseList), [{ path: '/Sections/Representatives/details.aspx?MemberId=4920&LegislativeTermId=92', id: '4920', term: '92', sortName: 'Conerly, William "Bill"', party: 'R', district: '72' }]);
  const rep = o.parseRepresentative(`<h3>Capitol Office</h3><p>402 South Monroe Street</p><p>Tallahassee, FL 32399-1300</p><p>(850) 717-5072</p><a>Map/Driving Directions</a><h3>District Office</h3><p>11523 Palmbrush Trail</p><p>(941) 327-0150</p>
    <b>Legislative Aide:</b><p>Olivia Borden</p><b>District Aide:</b><p>Brittany Hoppe and Sam Lee</p>`);
  assert.equal(rep.capitol.phone, '850-717-5072'); assert.equal(rep.district.phone, '941-327-0150');
  assert.deepEqual(rep.staff, [{ n: 'Olivia Borden', t: 'Legislative Aide' }, { n: 'Brittany Hoppe', t: 'District Aide' }, { n: 'Sam Lee', t: 'District Aide' }]);
  // Names as the official lists write them, and each chamber's usual email format
  assert.equal(o.preferredName('Conerly, William "Bill"'), 'Bill Conerly'); assert.equal(o.preferredName('Mooney Jr., James Vernon "Jim"'), 'Jim Mooney Jr.'); assert.equal(o.preferredName('Bush III, Dr. James'), 'James Bush III');
  assert.equal(o.EMAIL_FORMAT.ushouse('Smith, Ashley Jean'), 'ashley.smith@mail.house.gov'); assert.equal(o.EMAIL_FORMAT.ushouse("O'Neil, Kathryn"), 'kathryn.oneil@mail.house.gov');
  assert.equal(o.EMAIL_FORMAT.flsenate('Xuripha Barrow'), 'barrow.xuripha@flsenate.gov'); assert.equal(o.EMAIL_FORMAT.flhouse('Sousa Lazaballet, Felipe'), 'felipe.sousalazaballet@flhouse.gov');
  // The House staff directory: Washington offices only, phones tidied
  const dir = o.parseHouseDirectory('<script>angular.module("employeeDirectory").value("employees", [{"name":"Smith, Ashley Jean","jobTitle":"Scheduler","telephone":"2022255765","worksFor":{"_id":"AK00","name":"Begich"}},{"name":"Doe, Jo","jobTitle":"Caseworker","telephone":"9075551212","worksFor":{"_id":"AK001","name":"Begich - Anchorage"}},{"name":"Lee, Pat [x]","jobTitle":"Chief Of Staff","telephone":"2022250102","worksFor":{"_id":"CA12","name":"Pelosi"}}]);</script>');
  assert.deepEqual(dir['AK-AL'], [{ n: 'Ashley Jean Smith', t: 'Scheduler', ph: '202-225-5765', em: 'ashley.smith@mail.house.gov', f: 1 }]);
  assert.equal(dir['CA-12'][0].t, 'Chief of Staff'); assert.equal(Object.keys(dir).length, 2, 'district offices are left out');
  // A refresh keeps returning members' keys (and published emails), and puts schedulers first
  const base = { presets: {
    flsenate: { label: 'Florida Senate', seats: 40, stale: true, members: [{ k: 'old-1', n: 'Don Gaetz', p: 'R', d: '1', em: 'gaetz.don.web@flsenate.gov' }, { k: 'old-2', n: 'Gone Person', p: 'D', d: '2' }] },
    flhouse: { label: 'Florida House', seats: 120, members: [{ k: 'h-72', n: 'Bill Conerly', p: 'R', d: '72', em: 'bill.conerly@flhouse.gov' }] },
    ushouse: { label: 'U.S. House', seats: 435, members: [{ k: 'B001323', n: 'Nicholas J. Begich III', p: 'R', d: 'AK-AL' }] } } };
  const r = await o.refreshOfficials(base, { sources: {
    flsenate: async () => [{ n: 'Don Gaetz', p: 'R', d: '1', em: 'gaetz.don.web@flsenate.gov', staff: [{ n: 'Keri Pitzer', t: 'Legislative Aide', em: 'pitzer.keri@flsenate.gov', f: 1 }] }, { n: 'New Person', p: 'R', d: '2', em: 'person.new.web@flsenate.gov', emf: 1, staff: [] }],
    flhouse: async () => [{ n: 'Bill Conerly', p: 'R', d: '72', em: 'bill.conerly@flhouse.gov', emf: 1, ph: '850-717-5072', staff: [] }],
    houseStaff: async () => ({ 'AK-AL': [{ n: 'Chief Person', t: 'Chief of Staff', em: 'c@mail.house.gov', f: 1 }, { n: 'Ashley Jean Smith', t: 'Scheduler', em: 'ashley.smith@mail.house.gov', f: 1 }] }) } });
  assert.deepEqual(r.presets.flsenate.members.map((m) => m.k), ['old-1', 'fls-2-person']);
  assert.equal(r.presets.flsenate.stale, undefined, 'the refreshed list is current');
  assert.equal(r.presets.flsenate.members[1].emf, 1, 'a written-in-the-format address stays marked');
  assert.equal(r.presets.flhouse.members[0].emf, undefined, 'a returning member keeps the published address');
  assert.deepEqual(r.staff.chambers.ushouse.B001323.map((s) => s.t), ['Scheduler', 'Chief of Staff'], 'schedulers come first');
  const files = o.staffFiles(r.staff);
  assert.deepEqual(files.flsenate.people['old-1'], [['Keri Pitzer', 'Legislative Aide', '', 'pitzer.keri@flsenate.gov']]);
  // A failing source leaves that chamber as it was
  const partial = await o.refreshOfficials(base, { sources: { flsenate: async () => { throw new Error('site down'); }, flhouse: async () => [], houseStaff: async () => ({}) } });
  assert.equal(partial.presets.flsenate.members[0].k, 'old-1'); assert.match(partial.report[0], /site down/);
});

test('official lists: the server refreshes its own copy and serves the newer one', async () => {
  const shipped = await (await fetch(base + '/rosters.json')).json();
  assert.ok(shipped.presets.ushouse, 'the copy shipped with the app');
  await new Promise((r) => setTimeout(r, 20));
  const report = await server.jobs.officials({
    flsenate: async () => [{ n: 'Fresh Senator', p: 'D', d: '9', em: 'senator.fresh.web@flsenate.gov', staff: [{ n: 'Aide One', t: 'Legislative Aide', em: 'one.aide@flsenate.gov', f: 1 }] }],
    flhouse: async () => { throw new Error('not today'); },
    houseStaff: async () => ({}) });
  assert.match(report.join(' '), /Florida Senate: ok/); assert.match(report.join(' '), /Florida House: not today/);
  const served = await (await fetch(base + '/rosters.json')).json();
  assert.deepEqual(served.presets.flsenate.members.map((m) => m.n), ['Fresh Senator']);
  assert.deepEqual(served.presets.flhouse.members.length, shipped.presets.flhouse.members.length, 'the failed chamber is unchanged');
  const st = await (await fetch(base + '/staff/flsenate.json')).json();
  assert.deepEqual(Object.values(st.people)[0][0], ['Aide One', 'Legislative Aide', '', 'one.aide@flsenate.gov']);
  assert.equal((await fetch(base + '/staff/../headcount.db')).status, 404);
});
