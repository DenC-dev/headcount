import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb, HttpError } from './db.js';
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
  if (rel === '/' || rel.startsWith('/join/')) rel = '/index.html';
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
export function createServer({ store = openDb(path.join(config.dataDir, 'headcount.db')), draft = null } = {}) {
  const authenticate = makeAuthenticator(config);
  const draftBrief = draft || (config.aiEnabled ? (input) => import('./ai.js').then((m) => m.draftBrief(input)) : null);

  const publicConfig = {
    auth: config.authMode,
    firebase: config.authMode === 'firebase' ? { ...config.firebase, sdkVersion: FIREBASE_VERSION } : null,
    providers: config.authMode === 'none' ? [] : config.providers,
    bills: { federal: Boolean(config.congressKey), states: Boolean(config.openStatesKey) },
    states: STATES,
    ai: Boolean(draftBrief),
    supportEmail: config.supportEmail,
  };

  async function route(req, res, url) {
    const p = url.pathname, m = req.method;
    if (p === '/api/config' && m === 'GET') return send(res, 200, publicConfig);
    if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });

    const inviteMatch = /^\/api\/invites\/([A-Za-z0-9_-]{8,64})$/.exec(p);
    if (inviteMatch && m === 'GET') { limit('ip:' + clientIp(req), 30); return send(res, 200, store.previewInvite(inviteMatch[1])); }

    // Everything below needs a signed-in user.
    limit('ip:' + clientIp(req), 600);
    const user = await authenticate(req);
    limit('u:' + user.id, 300);
    store.touchUser(user);

    if (p === '/api/me' && m === 'GET') return send(res, 200, { user });
    if (p === '/api/me' && m === 'DELETE') return send(res, 200, store.deleteUser(user.id));
    if (p === '/api/campaigns' && m === 'GET') return send(res, 200, { campaigns: store.listCampaigns(user.id) });
    if (p === '/api/campaigns' && m === 'POST') { const b = await readJson(req); return send(res, 200, store.createCampaign(user.id, b.id, b.name)); }
    if (inviteMatch && m === 'POST') return send(res, 200, store.acceptInvite(inviteMatch[1], user.id));

    if (p === '/api/bills/lookup' && m === 'GET') {
      limit('bills:' + user.id, 20);
      return send(res, 200, await lookupBill(config, { jurisdiction: url.searchParams.get('jurisdiction'), number: url.searchParams.get('number'), session: url.searchParams.get('session') }));
    }
    if (p === '/api/bills/draft' && m === 'POST') {
      if (!draftBrief) throw new HttpError(501, 'Brief drafting is not set up on this server.');
      limit('draft:' + user.id, 3);
      if (!store.meter(user.id, 'draft', Math.max(1, Math.floor(config.aiDailyLimit / 10)))) throw new HttpError(429, 'You have reached today\'s limit for drafted briefs.');
      if (!store.meter('all', 'draft', config.aiDailyLimit)) throw new HttpError(429, 'Brief drafting has reached its daily limit on this server. Try again tomorrow.');
      return send(res, 200, await draftBrief(await readJson(req, 2_500_000)));
    }

    const cm = /^\/api\/campaigns\/([A-Za-z0-9_.:-]{1,64})(\/[a-z]+)?(?:\/([A-Za-z0-9_.:-]{1,140}))?$/.exec(p);
    if (cm) {
      const [, cid, sub = '', arg] = cm;
      if (!sub && m === 'DELETE') return send(res, 200, store.removeCampaign(cid, user.id));
      if (sub === '/records' && m === 'GET') return send(res, 200, store.records(cid, user.id, Math.max(0, Number(url.searchParams.get('since')) || 0)));
      if (sub === '/records' && m === 'POST') { const b = await readJson(req); return send(res, 200, store.write(cid, user.id, b.ops)); }
      if (sub === '/people' && !arg && m === 'GET') return send(res, 200, { people: store.people(cid, user.id) });
      if (sub === '/people' && arg && m === 'PATCH') { const b = await readJson(req); return send(res, 200, store.setRole(cid, user.id, arg, b.role)); }
      if (sub === '/people' && arg && m === 'DELETE') return send(res, 200, store.removePerson(cid, user.id, arg));
      if (sub === '/invites' && m === 'POST') { const b = await readJson(req); return send(res, 200, store.createInvite(cid, user.id, b.role)); }
      if (sub === '/invites' && m === 'DELETE') return send(res, 200, store.revokeInvites(cid, user.id));
    }
    throw new HttpError(404, 'Not found.');
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) {
      route(req, res, url).catch((e) => {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        console.error(e);
        send(res, 500, { error: 'Something went wrong on the server.' });
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else send(res, 405, { error: 'Method not allowed.' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, () => {
    console.log(`Headcount on http://localhost:${config.port} | sign-in: ${config.authMode}${config.authMode === 'dev' ? ' (LOCAL TESTING ONLY)' : ''} | federal bills: ${config.congressKey ? 'on' : 'off'} | state bills: ${config.openStatesKey ? 'on' : 'off'} | drafting: ${config.aiEnabled ? 'on' : 'off'}`);
  });
}
