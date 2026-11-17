import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, clean } from './db.js';

// Built-in accounts: email and password, so Headcount runs without setting up
// Google Cloud. Passwords are hashed with scrypt; sessions are random tokens
// stored only as hashes and expire after 30 days without use. The first
// account on a server becomes its operator, who manages the server settings.

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

export function makeAccounts(cfg, store) {
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
  };
  const userOf = (a) => ({ id: a.id, email: a.email, emailVerified: Boolean(a.verified), name: a.name, provider: 'password' });

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
    return { token: startSession(q.byId.get(a.id), agent), user: userOf(q.byId.get(a.id)) };
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
  return { signup, login, logout, verify, resetRequest, reset, confirm, newVerifyToken, changePassword, rename, remove, hasAccounts, signupsOpen, isLocal: (uid) => String(uid).startsWith('loc:') };
}
