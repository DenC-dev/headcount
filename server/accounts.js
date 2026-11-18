import crypto from 'node:crypto';
import { promisify } from 'node:util';
import qrcode from 'qrcode-generator';
import { HttpError, clean } from './db.js';

// Built-in accounts: email and password, so Headcount runs without setting up
// Google Cloud. Passwords are hashed with scrypt; sessions are random tokens
// stored only as hashes and expire after 30 days without use. The first
// account on a server becomes its operator, who manages the server settings.
// Two-step sign-in uses an authenticator app (TOTP, RFC 6238) with one-time
// recovery codes; its secret is encrypted at rest like the server settings.

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const b64 = (n) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');

async function hashPassword(pw) {
  const salt = b64(16), N = 16384, r = 8, p = 1;
  const key = await scrypt(pw, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt}$${key.toString('base64url')}`;
}
async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, want] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, salt, 64, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  const a = Buffer.from(want, 'base64url');
  return a.length === key.length && crypto.timingSafeEqual(a, key);
}
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + Buffer.alloc(64).toString('base64url');

// ---------- authenticator codes ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; }
function unbase32(s) { let bits = 0, v = 0; const out = []; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// The step a code matches, allowing one step of clock drift either way.
function matchStep(secret, code, after = -1) {
  const c = String(code || '').replace(/\s/g, ''), now = Math.floor(Date.now() / 30000);
  if (!/^\d{6}$/.test(c)) return null;
  for (const s of [now, now - 1, now + 1]) if (s > after && crypto.timingSafeEqual(Buffer.from(totp(secret, s)), Buffer.from(c))) return s;
  return null;
}
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(); let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges" role="img" aria-label="QR code for your authenticator app"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}
// Recovery codes avoid letters and digits people mix up (i, l, o, 0, 1).
const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
const recoveryCodes = () => Array.from({ length: 10 }, () => { const s = Array.from({ length: 8 }, () => RC[crypto.randomInt(RC.length)]).join(''); return `${s.slice(0, 4)}-${s.slice(4)}`; });
const normRecovery = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function makeAccounts(cfg, store, { seal = (v) => v, open = (v) => v } = {}) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, token_hash TEXT, token_kind TEXT, token_expires INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, agent TEXT);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
  `);
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name));
  for (const [c, t] of [['totp_secret', 'TEXT'], ['totp_pending', 'TEXT'], ['totp_last', 'INTEGER NOT NULL DEFAULT -1'], ['recovery', 'TEXT']]) if (!cols.has(c)) db.exec(`ALTER TABLE accounts ADD COLUMN ${c} ${t}`);
  const p = (sql) => db.prepare(sql);
  const q = {
    count: p('SELECT COUNT(*) AS n FROM accounts'),
    byEmail: p('SELECT * FROM accounts WHERE email = ?'),
    byId: p('SELECT * FROM accounts WHERE id = ?'),
    insert: p('INSERT INTO accounts (id, email, name, pw_hash, verified, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setPw: p('UPDATE accounts SET pw_hash = ?, token_hash = NULL, token_kind = NULL, token_expires = NULL WHERE id = ?'),
    setToken: p('UPDATE accounts SET token_hash = ?, token_kind = ?, token_expires = ? WHERE id = ?'),
    byToken: p('SELECT * FROM accounts WHERE token_hash = ? AND token_kind = ? AND token_expires > ?'),
    verify: p('UPDATE accounts SET verified = 1, token_hash = NULL, token_kind = NULL, token_expires = NULL WHERE id = ?'),
    rename: p('UPDATE accounts SET name = ? WHERE id = ?'),
    remove: p('DELETE FROM accounts WHERE id = ?'),
    newSession: p('INSERT INTO sessions (id, account_id, secret_hash, created_at, expires_at, agent) VALUES (?, ?, ?, ?, ?, ?)'),
    session: p('SELECT * FROM sessions WHERE id = ?'),
    extend: p('UPDATE sessions SET expires_at = ? WHERE id = ?'),
    endSession: p('DELETE FROM sessions WHERE id = ?'),
    endAll: p('DELETE FROM sessions WHERE account_id = ?'),
    endOthers: p('DELETE FROM sessions WHERE account_id = ? AND id != ?'),
    sweep: p('DELETE FROM sessions WHERE expires_at < ?'),
    setPending: p('UPDATE accounts SET totp_pending = ? WHERE id = ?'),
    enableTotp: p('UPDATE accounts SET totp_secret = ?, totp_pending = NULL, totp_last = ?, recovery = ? WHERE id = ?'),
    disableTotp: p('UPDATE accounts SET totp_secret = NULL, totp_pending = NULL, totp_last = -1, recovery = NULL WHERE id = ?'),
    usedStep: p('UPDATE accounts SET totp_last = ? WHERE id = ?'),
    setRecovery: p('UPDATE accounts SET recovery = ? WHERE id = ?'),
  };
  const userOf = (a) => ({ id: a.id, email: a.email, emailVerified: Boolean(a.verified), name: a.name, provider: 'password', twoFactor: Boolean(a.totp_secret) });

  // ---------- second step ----------
  // After the password, an account with two-step sign-in gets a short-lived
  // ticket, good for five tries in five minutes, to trade for a session.
  const tickets = new Map();
  function ticketFor(a) {
    const t = b64(24); tickets.set(sha(t), { id: a.id, exp: Date.now() + 5 * 60e3, tries: 0 });
    for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
    return { twoFactor: true, ticket: t };
  }
  // Checks an authenticator code or a recovery code; uses each only once.
  function checkSecond(a, code) {
    const secret = open(a.totp_secret);
    const step = matchStep(secret, code, a.totp_last);
    if (step !== null) { q.usedStep.run(step, a.id); return 'code'; }
    const want = normRecovery(code), list = JSON.parse(a.recovery || '[]');
    if (want.length === 8) { const i = list.indexOf(sha(want)); if (i >= 0) { list.splice(i, 1); q.setRecovery.run(JSON.stringify(list), a.id); return 'recovery'; } }
    return null;
  }
  function loginCode({ ticket, code }, agent) {
    const k = sha(String(ticket || '')), t = tickets.get(k);
    if (!t || t.exp < Date.now() || t.tries >= 5) { tickets.delete(k); throw new HttpError(401, 'That sign-in took too long. Enter your email and password again.'); }
    t.tries++;
    const a = q.byId.get(t.id);
    if (!a || !a.totp_secret) { tickets.delete(k); throw new HttpError(401, 'Enter your email and password again.'); }
    const how = checkSecond(a, code);
    if (!how) throw new HttpError(400, 'That code is not right. Check the time on your phone, or use a recovery code.');
    tickets.delete(k);
    const left = how === 'recovery' ? JSON.parse(q.byId.get(a.id).recovery || '[]').length : undefined;
    return { token: startSession(a, agent), user: userOf(a), recoveryLeft: left };
  }
  function totpStart(user) {
    const a = q.byId.get(user.id);
    if (!a) throw new HttpError(400, 'This account signs in another way; turn on two-step sign-in there.');
    if (a.totp_secret) throw new HttpError(409, 'Two-step sign-in is already on.');
    const secret = base32(crypto.randomBytes(20));
    q.setPending.run(seal(secret), a.id);
    const uri = `otpauth://totp/${encodeURIComponent('Headcount:' + a.email)}?secret=${secret}&issuer=Headcount&algorithm=SHA1&digits=6&period=30`;
    return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: qrSvg(uri) };
  }
  function totpEnable(user, { code }) {
    const a = q.byId.get(user.id);
    if (!a || !a.totp_pending) throw new HttpError(400, 'Start again: scan a new code.');
    const step = matchStep(open(a.totp_pending), code);
    if (step === null) throw new HttpError(400, 'That code is not right. Enter the six digits your app shows now.');
    const codes = recoveryCodes();
    q.enableTotp.run(a.totp_pending, step, JSON.stringify(codes.map((c) => sha(normRecovery(c)))), a.id);
    q.endOthers.run(a.id, user.session || ''); // other devices sign in again with the new step
    return { ok: true, recovery: codes };
  }
  async function totpDisable(user, { password, code }) {
    const a = q.byId.get(user.id);
    if (!a || !a.totp_secret) return { ok: true };
    if (!(await checkPassword(String(password || ''), a.pw_hash))) throw new HttpError(400, 'Your password is not right.');
    if (!checkSecond(a, code)) throw new HttpError(400, 'That code is not right.');
    q.disableTotp.run(a.id);
    return { ok: true };
  }
  function newRecovery(user, { code }) {
    const a = q.byId.get(user.id);
    if (!a || !a.totp_secret) throw new HttpError(400, 'Two-step sign-in is off.');
    if (!checkSecond(a, code)) throw new HttpError(400, 'That code is not right.');
    const codes = recoveryCodes(); q.setRecovery.run(JSON.stringify(codes.map((c) => sha(normRecovery(c)))), a.id);
    return { recovery: codes };
  }
  const recoveryLeft = (uid) => { const a = q.byId.get(uid); return a && a.totp_secret ? JSON.parse(a.recovery || '[]').length : null; };

  function startSession(a, agent) {
    const id = b64(12), secret = b64(32), now = Date.now();
    q.newSession.run(id, a.id, sha(secret), now, now + SESSION_DAYS * 864e5, clean(agent, 160) || null);
    return `s.${id}.${secret}`;
  }
  // Checks a session token from the Authorization header.
  function verify(token) {
    const m = /^s\.([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{20,80})$/.exec(String(token || ''));
    if (!m) throw new HttpError(401, 'Sign in to do that.');
    const s = q.session.get(m[1]);
    const ok = s && s.expires_at > Date.now() && crypto.timingSafeEqual(Buffer.from(sha(m[2])), Buffer.from(s.secret_hash));
    if (!ok) throw new HttpError(401, 'Your session has ended. Sign in again.');
    const a = q.byId.get(s.account_id);
    if (!a) throw new HttpError(401, 'Your session has ended. Sign in again.');
    if (s.expires_at - Date.now() < (SESSION_DAYS - 1) * 864e5) q.extend.run(Date.now() + SESSION_DAYS * 864e5, s.id);
    return { ...userOf(a), session: s.id };
  }

  function readPassword(pw, email) {
    const s = String(pw || '');
    if (s.length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
    if (s.length > 200) throw new HttpError(400, 'That password is too long.');
    if (email && s.toLowerCase() === String(email).toLowerCase()) throw new HttpError(400, 'Use a password that is not your email address.');
    return s;
  }
  const signupsOpen = () => (store.setting('cfg.signups') || store.setting('signups') || 'open') === 'open';

  async function signup({ name, email, password, invite }, agent) {
    const e = clean(email, 160).toLowerCase(), n = clean(name, 80);
    if (!n) throw new HttpError(400, 'Add your name.');
    if (!isEmail(e)) throw new HttpError(400, 'Enter a valid email address.');
    const pw = readPassword(password, e);
    const first = q.count.get().n === 0;
    if (!first && !signupsOpen() && !(invite && store.inviteExists(String(invite)))) throw new HttpError(403, 'New accounts on this server need an invitation. Ask your administrator for one.');
    if (q.byEmail.get(e)) throw new HttpError(409, 'An account with that email already exists. Sign in instead, or reset your password.');
    const id = 'loc:' + b64(12);
    q.insert.run(id, e, n, await hashPassword(pw), 0, Date.now());
    if (first) store.putSetting('operator', id);
    const a = q.byId.get(id);
    store.touchUser(userOf(a));
    return { token: startSession(a, agent), user: userOf(a), operator: first, verifyToken: makeToken(a, 'verify', 7) };
  }
  async function login({ email, password }, agent) {
    const a = q.byEmail.get(clean(email, 160).toLowerCase());
    const ok = await checkPassword(String(password || ''), a ? a.pw_hash : DUMMY);
    if (!a || !ok) throw new HttpError(401, 'That email and password do not match an account here.');
    if (a.totp_secret) return ticketFor(a);
    return { token: startSession(a, agent), user: userOf(a) };
  }
  function logout(sessionId, everywhere, uid) { if (everywhere) q.endAll.run(uid); else q.endSession.run(sessionId); return { ok: true }; }

  // One-time tokens for password reset and email confirmation, stored as hashes.
  function makeToken(a, kind, days) { const t = b64(24); q.setToken.run(sha(t), kind, Date.now() + days * 864e5, a.id); return t; }
  function resetRequest(email) {
    const a = q.byEmail.get(clean(email, 160).toLowerCase());
    return a ? { account: a, token: makeToken(a, 'reset', 1 / 24) } : null;
  }
  async function reset({ token, password }, agent) {
    const a = q.byToken.get(sha(String(token || '')), 'reset', Date.now());
    if (!a) throw new HttpError(400, 'That reset link has expired or was already used. Ask for a new one.');
    q.setPw.run(await hashPassword(readPassword(password, a.email)), a.id);
    q.endAll.run(a.id); q.verify.run(a.id); // receiving the email proves the address
    const b = q.byId.get(a.id);
    if (b.totp_secret) return ticketFor(b); // a reset email alone does not get past two-step sign-in
    return { token: startSession(b, agent), user: userOf(b) };
  }
  function confirm(token) {
    const a = q.byToken.get(sha(String(token || '')), 'verify', Date.now());
    if (!a) return null;
    q.verify.run(a.id); store.touchUser(userOf(q.byId.get(a.id)));
    return userOf(q.byId.get(a.id));
  }
  function newVerifyToken(uid) { const a = q.byId.get(uid); return a && !a.verified ? { account: a, token: makeToken(a, 'verify', 7) } : null; }
  async function changePassword(user, { current, next }) {
    const a = q.byId.get(user.id);
    if (!a) throw new HttpError(400, 'This account signs in another way.');
    if (!(await checkPassword(String(current || ''), a.pw_hash))) throw new HttpError(400, 'Your current password is not right.');
    q.setPw.run(await hashPassword(readPassword(next, a.email)), a.id);
    q.endOthers.run(a.id, user.session || '');
    return { ok: true };
  }
  function rename(uid, name) { const n = clean(name, 80); if (!n) throw new HttpError(400, 'Add your name.'); q.rename.run(n, uid); }
  const remove = (uid) => q.remove.run(uid);
  const hasAccounts = () => q.count.get().n > 0;
  setInterval(() => q.sweep.run(Date.now()), 6 * 3600e3).unref();
  return { loginCode, totpStart, totpEnable, totpDisable, newRecovery, recoveryLeft, signup, login, logout, verify, resetRequest, reset, confirm, newVerifyToken, changePassword, rename, remove, hasAccounts, signupsOpen, isLocal: (uid) => String(uid).startsWith('loc:') };
}
