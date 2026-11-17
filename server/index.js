import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { promises as dns } from 'node:dns';
import { openDb, HttpError } from './db.js';
import { makeBilling } from './billing.js';
import { forJson, PLANS } from './plans.js';
import { makeMailer } from './mail.js';
import { makeNotifier } from './notify.js';
import { makeAuthenticator } from './auth.js';
import { lookupBill, STATES } from './bills.js';
import { makeMonitor } from './monitor.js';
import { makeActionCenter } from './act.js';
import { makeCrm } from './crm.js';
import * as sources from './sources.js';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
const SITE = path.resolve(here, '..', 'site');
const SITE_PAGES = { '/': 'index.html', '/pricing': 'pricing.html', '/security': 'security.html', '/terms': 'terms.html', '/privacy': 'privacy.html' };
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sendFile(res, file, ext) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { ...SECURITY, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300', ...(ext === '.html' ? { 'Content-Security-Policy': csp() } : {}) });
    res.end(buf);
  });
}
// Website pages are HTML with {{placeholders}} for shared parts and for the
// plans and prices this server is configured with.
function sitePage(res, name, vars) {
  const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
  let html;
  try { html = read(name); } catch (_) { return send(res, 404, { error: 'Not found' }); }
  const parts = { header: read('_header.html'), footer: read('_footer.html'), hemicycle: read('_hemicycle.svg') };
  html = html.replace(/\{\{(header|footer|hemicycle)\}\}/g, (_, k) => parts[k]).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  res.writeHead(200, { ...SECURITY, 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp() });
  res.end(html);
}
function siteVars() {
  const inf = (v) => (v === Number.POSITIVE_INFINITY ? 'Unlimited' : v);
  const P = PLANS;
  const rows = [
    ['People', `Up to ${P.free.seats}`, 'As many seats as you need', 'As many seats as you need'],
    ['Active campaigns', P.free.campaigns, inf(P.team.campaigns), inf(P.firm.campaigns)],
    ['Guests (clients, partners)', P.free.guests, `${P.team.guestsPerSeat} per seat`, inf(P.firm.guests)],
    ['Briefs drafted with Claude, per month', P.free.drafts, `${P.team.draftsPerSeat} per seat`, `${P.firm.draftsPerSeat} per seat`],
    ['Vote counts, meeting requests, bill briefs', 'Yes', 'Yes', 'Yes'],
    ['Portfolio and clients', 'Yes', 'Yes', 'Yes'],
    ['Lobbying activity report', 'No', 'Yes', 'Yes'],
    ['Activity log', 'No', 'Yes', 'Yes'],
    ['Join by email domain', 'No', 'Yes', 'Yes'],
    ['Single sign-on (SAML, OIDC)', 'No', 'No', 'Yes'],
  ];
  return {
    year: String(new Date().getFullYear()),
    trialDays: String(config.trialDays),
    priceTeam: escHtml(config.priceLabelTeam || 'Per seat, billed monthly'),
    priceFirm: escHtml(config.priceLabelFirm || 'Per seat, with single sign-on'),
    salesEmail: config.salesEmail || config.supportEmail ? `<a href="mailto:${escHtml(config.salesEmail || config.supportEmail)}">${escHtml(config.salesEmail || config.supportEmail)}</a>` : 'us through the form on the <a href="/#demo">home page</a>',
    planTable: `<table class="plans"><thead><tr><th></th><th>Free</th><th>Team</th><th>Firm</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${escHtml(r[0])}</th>${r.slice(1).map((v) => `<td>${escHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
  };
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/\/+$/, '') || '/';
  if (SITE_PAGES[rel]) {
    if (config.siteOff && rel === '/') { res.writeHead(302, { Location: '/app' }); return res.end(); }
    return sitePage(res, SITE_PAGES[rel], siteVars());
  }
  if (rel === '/app' || rel.startsWith('/join/') || rel.startsWith('/invite/')) return sendFile(res, path.join(PUBLIC, 'index.html'), '.html');
  if (/^\/act\/[A-Za-z0-9_-]{6,20}$/.test(rel)) return sendFile(res, path.join(PUBLIC, 'act.html'), '.html');
  const root = rel.startsWith('/site/') ? SITE : PUBLIC;
  if (root === SITE) rel = rel.slice(5);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || path.basename(file).startsWith('_')) return send(res, 403, { error: 'Forbidden' });
  sendFile(res, file, path.extname(file));
}
function unsubscribePage(res, ok, message) {
  res.writeHead(ok ? 200 : 400, { ...SECURITY, 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': csp() });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email settings · Headcount</title><link rel="stylesheet" href="/site/site.css"></head>
<body><main class="narrow"><p class="eyebrow">Headcount</p><h1>${ok ? 'You are unsubscribed' : 'This link does not work'}</h1><p>${escHtml(message)}</p><p><a class="button" href="/app#email">Email settings</a></p></main></body></html>`);
}

// ---------- app ----------
export function createServer({ store = openDb(path.join(config.dataDir, 'headcount.db'), config), draft = null, score = undefined, resolveTxt = null } = {}) {
  // In local test mode, domains ending in .test (reserved, never real) verify without DNS.
  resolveTxt ||= async (d) => {
    if (config.authMode === 'dev' && d.endsWith('.test')) { const o = store.db.prepare('SELECT domain_token FROM orgs WHERE domain = ? ORDER BY created_at DESC').get(d); return o ? [[`headcount-verification=${o.domain_token}`]] : []; }
    return dns.resolveTxt(d);
  };
  const authenticate = makeAuthenticator(config);
  const draftBrief = draft || (config.aiEnabled ? (input) => import('./ai.js').then((m) => m.draftBrief(input)) : null);
  const billing = config.billing ? makeBilling(config, store) : null;
  const scoreItems = score !== undefined ? score : config.aiEnabled ? (input) => import('./ai.js').then((m) => m.scoreItems(input)) : null;
  const monitor = makeMonitor(config, store, { score: scoreItems }), crm = makeCrm(config, store);
  const mail = makeMailer(config, store), notifier = makeNotifier(config, store, mail, monitor), actions = makeActionCenter(config, store, mail);
  store.notify = notifier.handle; monitor.setAlertHandler(notifier.monitorAlert);
  const jobs = { mail: () => mail.work(), digests: (now) => notifier.digests(now), trialNotices: (now) => notifier.trialNotices(now), monitor: (now) => monitor.tick(now) };
  const timers = [setInterval(() => jobs.mail().catch((e) => console.error(e)), 5000), setInterval(() => { try { jobs.digests(new Date()); jobs.trialNotices(Date.now()); } catch (e) { console.error('Digest job failed', e); } }, config.digestEvery)];
  if (!config.monitorOff) timers.push(setInterval(() => jobs.monitor(Date.now()).catch((e) => console.error('Monitor job failed', e)), Math.min(config.monitorEvery, 15 * 60 * 1000)));
  timers.forEach((t) => t.unref());
  const UNSUB = { monitor: ['monitor', 'off', 'You will not get Monitor alerts by email anymore. New items still appear in the Monitor.'], digest: ['digest', 'off', 'You will not get digests from Headcount anymore.'], assigned: ['notifyAssigned', false, 'You will not get emails when someone assigns you a follow-up.'], added: ['notifyAdded', false, 'You will not get emails when someone adds you to a campaign.'] };

  const publicConfig = {
    auth: config.authMode,
    firebase: config.authMode === 'firebase' ? { ...config.firebase, sdkVersion: FIREBASE_VERSION } : null,
    providers: config.authMode === 'none' ? [] : config.providers,
    bills: { federal: Boolean(config.congressKey), states: Boolean(config.openStatesKey) },
    states: STATES,
    ai: Boolean(draftBrief),
    supportEmail: config.supportEmail,
    email: mail.enabled,
    sso: config.authMode !== 'none',
    monitor: { federal: Boolean(config.congressKey), states: Boolean(config.openStatesKey), regs: true, contracts: Boolean(config.samKey), ai: Boolean(scoreItems) },
    rosters: Boolean(config.openStatesKey),
    billing: config.billing ? { trialDays: config.trialDays, team: { price: config.priceLabelTeam }, firm: config.stripePriceFirm ? { price: config.priceLabelFirm } : null, salesEmail: config.salesEmail } : null,
  };
  const needBilling = () => { if (!billing) throw new HttpError(501, 'Billing is not set up on this server.'); return billing; };

  // [method, path pattern, handler(match, ctx)]; ctx has user, url, req, body().
  const W = '([A-Za-z0-9_-]{4,40})', C = '([A-Za-z0-9_.:-]{1,64})', U = '([A-Za-z0-9_.:-]{1,140})', K = '([A-Za-z0-9_-]{8,64})';
  const routes = [
    ['GET', '/api/me', (m, x) => { store.ssoJoin(x.user); return { user: x.user, workspaces: store.listOrgs(x.user.id), domainMatches: store.domainMatches(x.user), prefs: store.getPrefs(x.user.id) }; }],
    ['PATCH', '/api/me/prefs', async (m, x) => store.setPrefs(x.user.id, await x.body())],
    ['PATCH', `/api/workspaces/${W}/sso`, async (m, x) => store.setSso(m[1], x.user.id, await x.body())],
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
    ['POST', `/api/workspaces/${W}/invites`, async (m, x) => {
      const b = await x.body(), inv = store.createOrgInvite(m[1], x.user.id, b.role, b.email);
      const emailed = Boolean(b.send && inv.email) && notifier.orgInvite({ org: store.q.org.get(m[1]), inviter: x.user, email: inv.email, role: inv.role, link: `${config.publicUrl || `http://localhost:${config.port}`}/invite/${inv.code}` });
      return { ...inv, emailed };
    }],
    ['DELETE', `/api/workspaces/${W}/invites/${K}`, (m, x) => store.revokeOrgInvite(m[1], x.user.id, m[2])],
    ['GET', `/api/workspaces/${W}/clients`, (m, x) => ({ clients: store.listClients(m[1], x.user.id) })],
    ['POST', `/api/workspaces/${W}/clients`, async (m, x) => store.addClient(m[1], x.user.id, (await x.body()).name)],
    ['PATCH', `/api/workspaces/${W}/clients/${C}`, async (m, x) => store.updateClient(m[1], x.user.id, m[2], await x.body())],
    ['DELETE', `/api/workspaces/${W}/clients/${C}`, (m, x) => store.deleteClient(m[1], x.user.id, m[2])],
    ['GET', `/api/workspaces/${W}/audit`, (m, x) => ({ entries: store.auditLog(m[1], x.user.id, Number(x.url.searchParams.get('before')) || 0, Number(x.url.searchParams.get('limit')) || 50) })],
    ['GET', `/api/workspaces/${W}/activity`, (m, x) => store.activity(m[1], x.user.id, x.url.searchParams.get('from') || '', x.url.searchParams.get('to') || '', x.url.searchParams.get('client') || '')],
    ['GET', `/api/workspaces/${W}/export`, (m, x) => { const d = store.exportOrg(m[1], x.user.id); return { ...d, ...crm.exportOrg(m[1]), watches: monitor.list(m[1], x.user.id).watches, actionResponses: actions.exportOrg(m[1]) }; }],
    // Monitor
    ['GET', `/api/workspaces/${W}/watches`, (m, x) => monitor.list(m[1], x.user.id)],
    ['POST', `/api/workspaces/${W}/watches`, async (m, x) => { limit('watch:' + x.user.id, 10); return monitor.create(m[1], x.user.id, await x.body()); }],
    ['PATCH', `/api/workspaces/${W}/watches/${C}`, async (m, x) => monitor.update(m[1], x.user.id, m[2], await x.body())],
    ['DELETE', `/api/workspaces/${W}/watches/${C}`, (m, x) => monitor.remove(m[1], x.user.id, m[2])],
    ['POST', `/api/workspaces/${W}/watches/${C}/run`, (m, x) => { limit('run:' + x.user.id, 6); return monitor.runNow(m[1], x.user.id, m[2]); }],
    ['GET', `/api/workspaces/${W}/items`, (m, x) => monitor.items(m[1], x.user.id, Object.fromEntries(x.url.searchParams))],
    ['PATCH', `/api/workspaces/${W}/items/(\\d{1,12})`, async (m, x) => monitor.setItem(m[1], x.user.id, m[2], await x.body())],
    // Stakeholders
    ['GET', `/api/workspaces/${W}/contacts`, (m, x) => crm.list(m[1], x.user.id)],
    ['POST', `/api/workspaces/${W}/contacts`, async (m, x) => crm.create(m[1], x.user.id, await x.body())],
    ['POST', `/api/workspaces/${W}/contacts/import`, async (m, x) => { limit('import:' + x.user.id, 5); return crm.importRows(m[1], x.user.id, (await x.body(5_000_000)).rows); }],
    ['PATCH', `/api/workspaces/${W}/contacts/${C}`, async (m, x) => crm.update(m[1], x.user.id, m[2], await x.body())],
    ['DELETE', `/api/workspaces/${W}/contacts/${C}`, (m, x) => crm.remove(m[1], x.user.id, m[2])],
    ['GET', `/api/workspaces/${W}/contacts/${C}/interactions`, (m, x) => crm.timeline(m[1], x.user.id, m[2])],
    ['POST', `/api/workspaces/${W}/interactions`, async (m, x) => crm.log(m[1], x.user.id, await x.body(500_000))],
    ['DELETE', `/api/workspaces/${W}/interactions/${C}`, (m, x) => crm.unlog(m[1], x.user.id, m[2])],
    // Intelligence and rosters from public data
    ['GET', '/api/intel/lobbying', (m, x) => { limit('intel:' + x.user.id, 10); return sources.lobbyingOn(config, { number: x.url.searchParams.get('number'), title: x.url.searchParams.get('title') }); }],
    ['GET', '/api/intel/incumbents', (m, x) => { limit('intel:' + x.user.id, 10); return sources.incumbents(config, { agency: String(x.url.searchParams.get('agency') || '').slice(0, 120), naics: String(x.url.searchParams.get('naics') || '').replace(/\D/g, '').slice(0, 6) }); }],
    ['GET', '/api/rosters/state', (m, x) => { limit('roster:' + x.user.id, 6); return sources.stateRoster(config, x.url.searchParams.get('state'), x.url.searchParams.get('chamber')); }],
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
    ['GET', `/api/campaigns/${C}/action`, (m, x) => actions.get(m[1], x.user.id)],
    ['PUT', `/api/campaigns/${C}/action`, async (m, x) => actions.save(m[1], x.user.id, await x.body(200_000))],
    ['GET', `/api/campaigns/${C}/action/responses`, (m, x) => actions.responses(m[1], x.user.id)],
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
    const p = url.pathname, m = req.method; let pm;
    if (p === '/api/config' && m === 'GET') return send(res, 200, publicConfig);
    if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });
    if (p === '/api/unsubscribe' && (m === 'GET' || m === 'POST')) {
      limit('preview:' + clientIp(req), 30);
      const t = mail.readToken(url.searchParams.get('t')), u = UNSUB[t && t.kind];
      if (!t || !u || !store.q.user.get(t.uid)) return m === 'GET' ? unsubscribePage(res, false, 'The link is incomplete or was changed. Change your email settings in Headcount instead.') : send(res, 400, { error: 'Invalid link.' });
      store.setPrefs(t.uid, { [u[0]]: u[1] });
      return m === 'GET' ? unsubscribePage(res, true, u[2]) : send(res, 200, { ok: true });
    }
    if (p === '/api/contact' && m === 'POST') {
      limit('contact:' + clientIp(req), 5);
      const b = await readJson(req, 20_000), cut = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
      if (b.website) return send(res, 200, { ok: true }); // filled in only by bots
      const lead = { name: cut(b.name, 120), email: cut(b.email, 160), firm: cut(b.firm, 160), size: cut(b.size, 40), message: String(b.message || '').trim().slice(0, 4000) };
      if (!lead.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) throw new HttpError(400, 'Add your name and a valid work email.');
      store.addLead(lead); notifier.contact(lead);
      return send(res, 200, { ok: true });
    }
    if ((pm = /^\/api\/act\/([A-Za-z0-9_-]{6,20})(\/lookup|\/send)?$/.exec(p))) {
      if (m === 'GET' && !pm[2]) { limit('preview:' + clientIp(req), 60); return send(res, 200, actions.publicView(pm[1])); }
      if (m === 'POST' && pm[2] === '/lookup') { limit('act:' + clientIp(req), 20); return send(res, 200, await actions.lookup(pm[1], (await readJson(req, 10_000)).address)); }
      if (m === 'POST' && pm[2] === '/send') {
        limit('actsend:' + clientIp(req), 4);
        const b = await readJson(req, 50_000);
        if (b.website) return send(res, 200, { emailed: [], call: [], forms: [] }); // filled in only by bots
        return send(res, 200, await actions.send(pm[1], b));
      }
    }
    if (p === '/api/sso/lookup' && m === 'GET') { limit('preview:' + clientIp(req), 30); return send(res, 200, store.ssoLookup(url.searchParams.get('email'))); }
    if (p === '/api/dev/outbox' && m === 'GET' && config.authMode === 'dev') return send(res, 200, { emails: mail.outbox(100) });
    if (p === '/api/stripe/webhook' && m === 'POST') { limit('hook:' + clientIp(req), 120); return send(res, 200, await needBilling().webhook(await readRaw(req), req.headers['stripe-signature'])); }
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

  const server = http.createServer((req, res) => {
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
  server.jobs = jobs; server.mail = mail; server.notifier = notifier; server.monitor = monitor;
  server.on('close', () => timers.forEach(clearInterval));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, () => {
    console.log(`Headcount on http://localhost:${config.port} | sign-in: ${config.authMode}${config.authMode === 'dev' ? ' (LOCAL TESTING ONLY)' : ''} | federal bills: ${config.congressKey ? 'on' : 'off'} | state bills: ${config.openStatesKey ? 'on' : 'off'} | drafting: ${config.aiEnabled ? 'on' : 'off'} | billing: ${config.billing ? 'on' : 'off (every workspace unlimited)'}`);
  });
}
