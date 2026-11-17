import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

// Stand-ins for Google's signing keys, Congress.gov, Open States and the Claude API.
const mocks = { claude: [], claudeReply: null };
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fixtures = {
  '/v3/bill/119/hr/1234': { bill: { title: 'Rural Broadband Access Act', introducedDate: '2025-03-04', sponsors: [{ fullName: 'Rep. Smith, Ann [D-IA-2]', party: 'D', state: 'IA', district: 2 }], cosponsors: { count: 12 }, latestAction: { actionDate: '2025-06-01', text: 'Referred to the Subcommittee on Communications.' }, policyArea: { name: 'Science, Technology, Communications' } } },
  '/v3/bill/119/hr/1234/summaries': { summaries: [{ actionDate: '2025-03-04', actionDesc: 'Introduced in House', updateDate: '2025-04-01', text: '<p>This bill expands <b>grants</b> for rural broadband &amp; requires reports.</p>' }] },
  '/v3/bill/119/hr/1234/committees': { committees: [{ name: 'Energy and Commerce Committee' }] },
  '/bills': { results: [{ identifier: 'HB 123', title: 'Property Insurance', session: '2026', first_action_date: '2026-01-13', latest_action_date: '2026-03-01', latest_action_description: 'Passed House', openstates_url: 'https://openstates.org/fl/bills/2026/HB123/', abstracts: [{ abstract: 'Revises property insurance requirements.' }], sponsorships: [{ name: 'Jane Doe', primary: true, person: { party: 'Republican', current_role: { district: '12' } } }, { name: 'Co Sponsor', primary: false }], actions: [{ date: '2026-02-01', related_entities: [{ entity_type: 'organization', name: 'Insurance & Banking Subcommittee' }] }], subject: ['Insurance'] }] },
};
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/jwks') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' }); return res.end(JSON.stringify({ keys: [jwk] })); }
  if (u.pathname === '/v1/messages') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mocks.claude.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mocks.claudeReply));
    });
    return;
  }
  if (u.pathname.startsWith('/v3/') && req.headers['x-api-key'] !== 'cg-key') { res.writeHead(403); return res.end('{}'); }
  if (u.pathname === '/bills') {
    if (req.headers['x-api-key'] !== 'os-key') { res.writeHead(401); return res.end('{}'); }
    const hit = u.searchParams.get('identifier') === 'HB 123' && u.searchParams.get('jurisdiction') === 'ocd-jurisdiction/country:us/state:fl/government';
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(hit ? fixtures['/bills'] : { results: [] }));
  }
  const f = fixtures[u.pathname];
  res.writeHead(f ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(f || {}));
});

let base, server, mods;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const m = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { AUTH_MODE: 'dev', CONGRESS_API_KEY: 'cg-key', CONGRESS_API_BASE: `${m}/v3`, OPENSTATES_API_KEY: 'os-key', OPENSTATES_API_BASE: m, FIREBASE_JWKS_URL: `${m}/jwks`, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: m });
  mods = {
    db: await import('../server/db.js'), auth: await import('../server/auth.js'), bills: await import('../server/bills.js'),
    ai: await import('../server/ai.js'), index: await import('../server/index.js'), config: (await import('../server/config.js')).config,
  };
  server = mods.index.createServer({ store: mods.db.openDb(':memory:'), draft: (x) => mods.ai.draftBrief(x) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

const tok = (id, extra = {}) => 'dev.' + Buffer.from(JSON.stringify({ id, name: id[0].toUpperCase() + id.slice(1), email: `${id}@example.org`, ...extra })).toString('base64url');
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...(who ? { Authorization: 'Bearer ' + tok(who) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

// ---------- sign-in ----------
function signJwt(payload, kid = 'k1', key = privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
test('Identity Platform tokens are verified: signature, project, expiry', async () => {
  const t = Math.floor(Date.now() / 1000), opts = { projectId: 'proj-1', jwksUrl: process.env.FIREBASE_JWKS_URL };
  const good = { aud: 'proj-1', iss: 'https://securetoken.google.com/proj-1', sub: 'uid42', iat: t - 10, exp: t + 3000, auth_time: t - 10, email: 'a@b.org', name: 'Ann', firebase: { sign_in_provider: 'microsoft.com' } };
  const u = await mods.auth.verifyFirebaseToken(signJwt(good), opts);
  assert.deepEqual(u, { id: 'fb:uid42', email: 'a@b.org', name: 'Ann', provider: 'microsoft' });
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt({ ...good, aud: 'other' }), opts), /different project/);
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt({ ...good, exp: t - 600 }), opts), /expired/);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt(good, 'k1', other), opts), /signature/);
  await assert.rejects(mods.auth.verifyFirebaseToken(signJwt(good, 'nope'), opts), /unknown key/);
  const parts = signJwt(good).split('.'); parts[1] = Buffer.from(JSON.stringify({ ...good, sub: 'someone-else' })).toString('base64url');
  await assert.rejects(mods.auth.verifyFirebaseToken(parts.join('.'), opts), /signature/);
});

test('API refuses requests without sign-in', async () => {
  assert.equal((await api(null, 'GET', '/api/campaigns')).status, 401);
  const bad = await fetch(base + '/api/campaigns', { headers: { Authorization: 'Bearer dev.bm90LWpzb24' } });
  assert.equal(bad.status, 401);
});

// ---------- campaigns, records, teams ----------
test('campaign records sync by cursor, with deletions', async () => {
  assert.equal((await api('alice', 'POST', '/api/campaigns', { id: 'c1', name: 'SB 214' })).body.role, 'owner');
  const w1 = await api('alice', 'POST', '/api/campaigns/c1/records', { ops: [
    { kind: 'meta', data: { campaign: { bill: 'SB 214: Broadband' } } },
    { kind: 'members', id: 'm1', data: { name: 'Vega', pos: 2 } },
    { kind: 'members', id: 'm2', data: { name: 'Lind', pos: 4 } },
  ] });
  assert.equal(w1.status, 200);
  const all = await api('alice', 'GET', '/api/campaigns/c1/records?since=0');
  assert.equal(all.body.records.length, 3); assert.equal(all.body.role, 'owner');
  const w2 = await api('alice', 'POST', '/api/campaigns/c1/records', { ops: [{ kind: 'members', id: 'm1', data: { name: 'Vega', pos: 3 } }, { kind: 'members', id: 'm2', data: null }] });
  const delta = await api('alice', 'GET', `/api/campaigns/c1/records?since=${w1.body.cursor}`);
  assert.deepEqual(delta.body.records.map((r) => [r.id, r.data && r.data.pos]), [['m1', 3], ['m2', null]]);
  assert.equal(delta.body.cursor, w2.body.cursor);
  const list = await api('alice', 'GET', '/api/campaigns');
  assert.equal(list.body.campaigns[0].name, 'SB 214: Broadband');
  assert.equal((await api('alice', 'POST', '/api/campaigns/c1/records', { ops: [{ kind: 'bogus', id: 'x', data: {} }] })).status, 400);
  assert.equal((await api('alice', 'POST', '/api/campaigns/c1/records', { ops: [{ kind: 'members', id: '../x', data: {} }] })).status, 400);
});

test('invitations, roles and removal', async () => {
  assert.equal((await api('bob', 'GET', '/api/campaigns/c1/records?since=0')).status, 404);
  const inv = await api('alice', 'POST', '/api/campaigns/c1/invites', { role: 'editor' });
  const view = await api('alice', 'POST', '/api/campaigns/c1/invites', { role: 'viewer' });
  const preview = await api(null, 'GET', `/api/invites/${inv.body.code}`);
  assert.deepEqual([preview.body.campaign, preview.body.role, preview.body.invitedBy], ['SB 214: Broadband', 'editor', 'Alice']);
  assert.equal((await api('bob', 'POST', `/api/invites/${inv.body.code}`)).body.role, 'editor');
  assert.equal((await api('carol', 'POST', `/api/invites/${view.body.code}`)).body.role, 'viewer');
  assert.equal((await api('bob', 'POST', '/api/campaigns/c1/records', { ops: [{ kind: 'members', id: 'm3', data: { name: 'New' } }] })).status, 200);
  const ro = await api('carol', 'POST', '/api/campaigns/c1/records', { ops: [{ kind: 'members', id: 'm4', data: { name: 'No' } }] });
  assert.equal(ro.status, 403); assert.match(ro.body.error, /view-only/);
  assert.equal((await api('carol', 'POST', '/api/campaigns/c1/invites', { role: 'viewer' })).status, 403);
  assert.equal((await api('bob', 'DELETE', '/api/campaigns/c1/people/fb:nobody')).status, 403);
  const people = await api('carol', 'GET', '/api/campaigns/c1/people');
  assert.deepEqual(people.body.people.map((p) => [p.name, p.role]), [['Alice', 'owner'], ['Bob', 'editor'], ['Carol', 'viewer']]);
  assert.equal((await api('alice', 'PATCH', '/api/campaigns/c1/people/dev:carol', { role: 'editor' })).status, 200);
  assert.equal((await api('alice', 'DELETE', '/api/campaigns/c1/people/dev:bob')).status, 200);
  assert.equal((await api('bob', 'GET', '/api/campaigns/c1/records?since=0')).status, 404);
  assert.equal((await api('bob', 'DELETE', '/api/campaigns/c1')).status, 404);
  assert.equal((await api('alice', 'DELETE', '/api/campaigns/c1/invites')).status, 200);
  assert.equal((await api('dave', 'POST', `/api/invites/${inv.body.code}`)).status, 404);
});

test('deleting an account hands campaigns to an editor or deletes them', async () => {
  await api('erin', 'POST', '/api/campaigns', { id: 'e1', name: 'Shared' });
  await api('erin', 'POST', '/api/campaigns', { id: 'e2', name: 'Solo' });
  const inv = await api('erin', 'POST', '/api/campaigns/e1/invites', { role: 'editor' });
  await api('frank', 'POST', `/api/invites/${inv.body.code}`);
  assert.deepEqual((await api('erin', 'DELETE', '/api/me')).body, { transferred: 1, deleted: 1 });
  assert.equal((await api('frank', 'GET', '/api/campaigns')).body.campaigns[0].role, 'owner');
});

// ---------- bills ----------
test('bill numbers and Congress numbers parse', () => {
  const { parseFederal, parseState, currentCongress } = mods.bills;
  assert.equal(parseFederal('H.R. 1234').label, 'H.R. 1234');
  assert.equal(parseFederal('hjres 7').type, 'hjres');
  assert.equal(parseFederal('S.Con.Res.3').label, 'S.Con.Res. 3');
  assert.equal(parseFederal('HB 12'), null);
  assert.equal(parseState('hb123'), 'HB 123');
  assert.equal(currentCongress(new Date('2026-11-17T12:00:00Z')), 119);
  assert.equal(currentCongress(new Date('2027-01-02T12:00:00Z')), 119);
  assert.equal(currentCongress(new Date('2027-01-03T12:00:00Z')), 120);
});

test('federal and state bill lookups fill the brief header', async () => {
  const fed = await api('alice', 'GET', '/api/bills/lookup?jurisdiction=US&number=H.R.%201234&session=119');
  assert.equal(fed.status, 200);
  assert.equal(fed.body.number, 'H.R. 1234'); assert.equal(fed.body.session, '119th Congress');
  assert.equal(fed.body.officialSummary, 'This bill expands grants for rural broadband & requires reports.');
  assert.deepEqual(fed.body.committees, ['Energy and Commerce Committee']);
  assert.equal(fed.body.url, 'https://www.congress.gov/bill/119th-congress/house-bill/1234');
  const fl = await api('alice', 'GET', '/api/bills/lookup?jurisdiction=FL&number=hb123');
  assert.equal(fl.status, 200);
  assert.deepEqual([fl.body.number, fl.body.jurisdiction, fl.body.cosponsors, fl.body.committees[0]], ['HB 123', 'Florida Legislature', 1, 'Insurance & Banking Subcommittee']);
  assert.equal((await api('alice', 'GET', '/api/bills/lookup?jurisdiction=US&number=H.R.%209999&session=119')).status, 404);
  assert.equal((await api('alice', 'GET', '/api/bills/lookup?jurisdiction=US&number=banana')).status, 400);
  assert.equal((await api('alice', 'GET', '/api/bills/lookup?jurisdiction=FL&number=SB%201')).status, 404);
});

// ---------- drafting ----------
const draft = { plainSummary: 'Expands rural broadband grants.', keyProvisions: ['Creates a grant program.'], whoItAffects: 'Rural providers.', fiscalImpact: 'Not stated in the material.', talkingPoints: ['Closes the rural gap.'], objections: [{ objection: 'Cost', response: 'Grants are capped.' }], needsChecking: ['Program cost'] };
test('brief drafting sends a structured request and returns the draft', async () => {
  mocks.claudeReply = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(draft) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  const r = await api('alice', 'POST', '/api/bills/draft', { bill: { number: 'H.R. 1234', title: 'Rural Broadband Access Act', officialSummary: 'Expands grants.' }, side: 'pass', ask: 'Cosponsor' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.plainSummary, draft.plainSummary); assert.equal(r.body.objections[0].response, 'Grants are capped.');
  const sent = mocks.claude.at(-1);
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.fallbacks, 'default');
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.match(sent.body.messages[0].content, /support the bill/);
  assert.equal((await api('alice', 'POST', '/api/bills/draft', { bill: { title: 'x' } })).status, 400);
});

test('a declined draft is reported plainly', async () => {
  mocks.claudeReply = { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: null }, usage: { input_tokens: 1, output_tokens: 0 } };
  await new Promise((r) => setTimeout(r, 1100));
  const r = await api('alice', 'POST', '/api/bills/draft', { bill: { officialSummary: 'x' } });
  assert.equal(r.status, 422); assert.match(r.body.error, /declined/);
});

// ---------- static and headers ----------
test('pages carry a content security policy and paths cannot escape', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.auth, 'dev'); assert.equal(cfg.ai, true); assert.deepEqual(cfg.bills, { federal: true, states: true });
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/www\.gstatic\.com/);
  assert.match(page.headers.get('content-security-policy'), /connect-src [^;]*https:\/\/graph\.microsoft\.com/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/join/abcdefgh12')).status, 200);
  const raw = await new Promise((resolve) => http.get(base + '/..%2f..%2fpackage.json', (res) => { res.resume(); resolve(res.statusCode); }));
  assert.notEqual(raw, 200);
  const ct = await fetch(base + '/api/campaigns', { method: 'POST', headers: { Authorization: 'Bearer ' + tok('alice'), 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(ct.status, 415);
});
