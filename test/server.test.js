import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stand-ins for Google's signing keys, Congress.gov, Open States, Stripe and the Claude API.
const mocks = { claude: [], claudeReply: null, stripe: [], sub: null };
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
    STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1', STRIPE_PRICE_TEAM: 'price_team', STRIPE_API_BASE: m, PUBLIC_URL: 'https://app.example.org', TRIAL_SEATS: '3', SALES_EMAIL: 'sales@headcount.test',
  });
  mods = { db: await import('../server/db.js'), auth: await import('../server/auth.js'), bills: await import('../server/bills.js'), ai: await import('../server/ai.js'), index: await import('../server/index.js'), config: (await import('../server/config.js')).config };
  store = mods.db.openDb(':memory:', mods.config);
  server = mods.index.createServer({ store, draft: (x) => mods.ai.draftBrief(x), resolveTxt: async (d) => { if (!txt.has(d)) throw new Error('ENOTFOUND'); return txt.get(d); } });
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
  assert.match(await (await fetch(base + '/app')).text(), /<script src="\/app\.js" defer>/);
  for (const pth of ['/site/_header.html', '/site/_hemicycle.svg']) assert.equal((await fetch(base + pth)).status, 403, pth);
  assert.match(await (await fetch(base + '/security')).text(), /mailto:sales@headcount\.test/);
});
