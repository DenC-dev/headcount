import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { promises as dns } from 'node:dns';
import { openDb, HttpError } from './db.js';
import { makeBilling } from './billing.js';
import { forJson } from './plans.js';
import { makeAuthenticator } from './auth.js';
import { lookupBill, STATES } from './bills.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '..', 'public');
const FIREBASE_VERSION = '10.14.1';

// ---------- small helpers ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readRaw(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function readJson(req, max = 4_000_000) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!/^application\/json\b/i.test(type)) return reject(new HttpError(415, 'Send JSON.'));
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { reject(new HttpError(400, 'Request body is not valid JSON.')); } });
    req.on('error', reject);
  });
}
const clientIp = (req) => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

// Token buckets, per user (or IP before sign-in) and per kind of request.
const buckets = new Map();
function limit(key, perMinute) {
  const t = Date.now(), b = buckets.get(key) || { tokens: perMinute, at: t };
  b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60000) * perMinute); b.at = t;
  if (b.tokens < 1) { buckets.set(key, b); throw new HttpError(429, 'Too many requests. Slow down and try again in a moment.'); }
  b.tokens -= 1; buckets.set(key, b);
}
setInterval(() => { const cut = Date.now() - 600000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 300000).unref();

// ---------- security headers ----------
function csp() {
  const authDomain = config.firebase.authDomain ? `https://${config.firebase.authDomain}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' https://www.gstatic.com https://apis.google.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://gmail.googleapis.com https://graph.microsoft.com ${authDomain}`.trim(),
    `frame-src ${authDomain ? authDomain + ' ' : ''}https://accounts.google.com`,
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Sign-in pop-ups need to talk back to this page.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.startsWith('/join/') || rel.startsWith('/invite/')) rel = '/index.html';
  if (rel === '/privacy') rel = '/privacy.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const ext = path.extname(file);
    res.writeHead(200, {
      ...SECURITY,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...(ext === '.html' ? { 'Content-Security-Policy': csp() } : {}),
    });
    res.end(buf);
  });
}

// ---------- app ----------
export function createServer({ store = openDb(path.join(config.dataDir, 'headcount.db'), config), draft = null, resolveTxt = dns.resolveTxt } = {}) {
  const authenticate = makeAuthenticator(config);
  const draftBrief = draft || (config.aiEnabled ? (input) => import('./ai.js').then((m) => m.draftBrief(input)) : null);
  const billing = config.billing ? makeBilling(config, store) : null;

  const publicConfig = {
    auth: config.authMode,
    firebase: config.authMode === 'firebase' ? { ...config.firebase, sdkVersion: FIREBASE_VERSION } : null,
    providers: config.authMode === 'none' ? [] : config.providers,
    bills: { federal: Boolean(config.congressKey), states: Boolean(config.openStatesKey) },
    states: STATES,
    ai: Boolean(draftBrief),
    supportEmail: config.supportEmail,
    billing: config.billing ? { trialDays: config.trialDays, team: { price: config.priceLabelTeam }, firm: config.stripePriceFirm ? { price: config.priceLabelFirm } : null, salesEmail: config.salesEmail } : null,
  };
  const needBilling = () => { if (!billing) throw new HttpError(501, 'Billing is not set up on this server.'); return billing; };

  // [method, path pattern, handler(match, ctx)]; ctx has user, url, req, body().
  const W = '([A-Za-z0-9_-]{4,40})', C = '([A-Za-z0-9_.:-]{1,64})', U = '([A-Za-z0-9_.:-]{1,140})', K = '([A-Za-z0-9_-]{8,64})';
  const routes = [
    ['GET', '/api/me', (m, x) => ({ user: x.user, workspaces: store.listOrgs(x.user.id), domainMatches: store.domainMatches(x.user) })],
    ['DELETE', '/api/me', async (m, x) => { const r = store.deleteUser(x.user.id); if (billing) for (const sub of r.cancel) await billing.cancel(sub); return { transferred: r.transferred, deleted: r.deleted }; }],
    ['GET', '/api/workspaces', (m, x) => ({ workspaces: store.listOrgs(x.user.id) })],
    ['POST', '/api/workspaces', async (m, x) => store.createOrg(x.user.id, (await x.body()).name)],
    ['GET', `/api/workspaces/${W}`, (m, x) => forJsonInfo(store.orgInfo(m[1], x.user.id))],
    ['PATCH', `/api/workspaces/${W}`, async (m, x) => store.renameOrg(m[1], x.user.id, (await x.body()).name)],
    ['DELETE', `/api/workspaces/${W}`, (m, x) => store.deleteOrg(m[1], x.user.id)],
    ['GET', `/api/workspaces/${W}/campaigns`, (m, x) => ({ campaigns: store.listOrgCampaigns(m[1], x.user.id) })],
    ['GET', `/api/workspaces/${W}/members`, (m, x) => ({ members: store.members(m[1], x.user.id) })],
    ['PATCH', `/api/workspaces/${W}/members/${U}`, async (m, x) => store.setOrgRole(m[1], x.user.id, m[2], (await x.body()).role)],
    ['DELETE', `/api/workspaces/${W}/members/${U}`, (m, x) => store.removeMember(m[1], x.user.id, m[2])],
    ['GET', `/api/workspaces/${W}/invites`, (m, x) => ({ invites: store.listOrgInvites(m[1], x.user.id) })],
    ['POST', `/api/workspaces/${W}/invites`, async (m, x) => { const b = await x.body(); return store.createOrgInvite(m[1], x.user.id, b.role, b.email); }],
    ['DELETE', `/api/workspaces/${W}/invites/${K}`, (m, x) => store.revokeOrgInvite(m[1], x.user.id, m[2])],
    ['GET', `/api/workspaces/${W}/clients`, (m, x) => ({ clients: store.listClients(m[1], x.user.id) })],
    ['POST', `/api/workspaces/${W}/clients`, async (m, x) => store.addClient(m[1], x.user.id, (await x.body()).name)],
    ['PATCH', `/api/workspaces/${W}/clients/${C}`, async (m, x) => store.updateClient(m[1], x.user.id, m[2], await x.body())],
    ['DELETE', `/api/workspaces/${W}/clients/${C}`, (m, x) => store.deleteClient(m[1], x.user.id, m[2])],
    ['GET', `/api/workspaces/${W}/audit`, (m, x) => ({ entries: store.auditLog(m[1], x.user.id, Number(x.url.searchParams.get('before')) || 0, Number(x.url.searchParams.get('limit')) || 50) })],
    ['GET', `/api/workspaces/${W}/activity`, (m, x) => store.activity(m[1], x.user.id, x.url.searchParams.get('from') || '', x.url.searchParams.get('to') || '', x.url.searchParams.get('client') || '')],
    ['GET', `/api/workspaces/${W}/export`, (m, x) => store.exportOrg(m[1], x.user.id)],
    ['POST', `/api/workspaces/${W}/domain`, async (m, x) => store.setDomain(m[1], x.user.id, (await x.body()).domain)],
    ['POST', `/api/workspaces/${W}/domain/verify`, (m, x) => store.verifyDomain(m[1], x.user.id, resolveTxt)],
    ['PATCH', `/api/workspaces/${W}/domain`, async (m, x) => store.setDomainJoin(m[1], x.user.id, Boolean((await x.body()).join))],
    ['DELETE', `/api/workspaces/${W}/domain`, (m, x) => store.clearDomain(m[1], x.user.id)],
    ['POST', `/api/workspaces/${W}/join`, (m, x) => store.joinByDomain(m[1], x.user)],
    ['POST', `/api/workspaces/${W}/billing/checkout`, async (m, x) => needBilling().checkout(m[1], x.user, await x.body())],
    ['POST', `/api/workspaces/${W}/billing/portal`, (m, x) => needBilling().portal(m[1], x.user)],
    ['POST', `/api/workspaces/${W}/billing/seats`, async (m, x) => needBilling().setSeats(m[1], x.user, (await x.body()).seats)],
    ['POST', `/api/workspace-invites/${K}`, (m, x) => store.acceptOrgInvite(m[1], x.user)],
    ['POST', `/api/invites/${K}`, (m, x) => store.acceptInvite(m[1], x.user)],
    ['POST', '/api/campaigns', async (m, x) => { const b = await x.body(); return store.createCampaign(x.user.id, { id: b.id, orgId: b.workspaceId, name: b.name, clientId: b.clientId, visibility: b.visibility }); }],
    ['PATCH', `/api/campaigns/${C}`, async (m, x) => store.updateCampaign(m[1], x.user.id, await x.body())],
    ['DELETE', `/api/campaigns/${C}`, (m, x) => store.removeCampaign(m[1], x.user.id)],
    ['GET', `/api/campaigns/${C}/records`, (m, x) => store.records(m[1], x.user.id, Math.max(0, Number(x.url.searchParams.get('since')) || 0))],
    ['POST', `/api/campaigns/${C}/records`, async (m, x) => store.write(m[1], x.user.id, (await x.body()).ops)],
    ['GET', `/api/campaigns/${C}/people`, (m, x) => store.people(m[1], x.user.id)],
    ['POST', `/api/campaigns/${C}/people`, async (m, x) => { const b = await x.body(); return store.addPerson(m[1], x.user.id, String(b.userId || ''), b.role); }],
    ['PATCH', `/api/campaigns/${C}/people/${U}`, async (m, x) => store.setRole(m[1], x.user.id, m[2], (await x.body()).role)],
    ['DELETE', `/api/campaigns/${C}/people/${U}`, (m, x) => store.removePerson(m[1], x.user.id, m[2])],
    ['POST', `/api/campaigns/${C}/invites`, async (m, x) => store.createInvite(m[1], x.user.id, (await x.body()).role)],
    ['DELETE', `/api/campaigns/${C}/invites`, (m, x) => store.revokeInvites(m[1], x.user.id)],
    ['GET', '/api/bills/lookup', async (m, x) => { limit('bills:' + x.user.id, 20); const q = x.url.searchParams; return lookupBill(config, { jurisdiction: q.get('jurisdiction'), number: q.get('number'), session: q.get('session') }); }],
    ['POST', '/api/bills/draft', async (m, x) => {
      if (!draftBrief) throw new HttpError(501, 'Brief drafting is not set up on this server.');
      limit('draft:' + x.user.id, 3);
      const b = await x.body(2_500_000);
      store.need(String(b.campaignId || ''), x.user.id, 'editor');
      const camp = store.q.campaign.get(b.campaignId);
      if (!store.meterGlobal('draft', config.aiDailyLimit)) throw new HttpError(429, 'Brief drafting has reached its daily limit on this server. Try again tomorrow.');
      store.meter(camp.org_id, 'draft');
      return draftBrief(b);
    }],
  ].map(([method, pattern, fn]) => [method, new RegExp(`^${pattern}$`), fn]);
  const forJsonInfo = (info) => ({ ...info, plan: forJson(info.plan) });

  async function route(req, res, url) {
    const p = url.pathname, m = req.method;
    if (p === '/api/config' && m === 'GET') return send(res, 200, publicConfig);
    if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });
    if (p === '/api/stripe/webhook' && m === 'POST') { limit('hook:' + clientIp(req), 120); return send(res, 200, await needBilling().webhook(await readRaw(req), req.headers['stripe-signature'])); }
    let pm;
    if ((pm = /^\/api\/invites\/([A-Za-z0-9_-]{8,64})$/.exec(p)) && m === 'GET') { limit('preview:' + clientIp(req), 30); const v = store.previewInvite(pm[1]); return send(res, 200, { campaign: v.campaign, workspace: v.workspace, role: v.role, invitedBy: v.invitedBy }); }
    if ((pm = /^\/api\/workspace-invites\/([A-Za-z0-9_-]{8,64})$/.exec(p)) && m === 'GET') { limit('preview:' + clientIp(req), 30); const v = store.previewOrgInvite(pm[1]); return send(res, 200, { workspace: v.workspace, role: v.role, invitedBy: v.invitedBy, email: v.email }); }

    // Everything below needs a signed-in user.
    limit('ip:' + clientIp(req), 600);
    const user = await authenticate(req);
    limit('u:' + user.id, 300);
    store.touchUser(user);
    const ctx = { user, url, req, body: (max) => readJson(req, max) };
    for (const [method, re, fn] of routes) {
      if (method !== m) continue;
      const hit = re.exec(p);
      if (hit) return send(res, 200, await fn(hit, ctx));
    }
    throw new HttpError(404, 'Not found.');
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) {
      route(req, res, url).catch((e) => {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
        console.error(e);
        send(res, 500, { error: 'Something went wrong on the server.' });
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else send(res, 405, { error: 'Method not allowed.' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, () => {
    console.log(`Headcount on http://localhost:${config.port} | sign-in: ${config.authMode}${config.authMode === 'dev' ? ' (LOCAL TESTING ONLY)' : ''} | federal bills: ${config.congressKey ? 'on' : 'off'} | state bills: ${config.openStatesKey ? 'on' : 'off'} | drafting: ${config.aiEnabled ? 'on' : 'off'} | billing: ${config.billing ? 'on' : 'off (every workspace unlimited)'}`);
  });
}
