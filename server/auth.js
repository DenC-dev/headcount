import crypto from 'node:crypto';
import { HttpError } from './db.js';

// Sign-in is handled by Google Cloud Identity Platform (Firebase Authentication),
// which offers Google and Microsoft accounts. The browser sends the Identity
// Platform ID token on each request; this module checks its signature and claims.

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
let jwks = { keys: new Map(), expires: 0, loading: null };

async function loadKeys(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Key fetch failed (${res.status})`);
  const body = await res.json();
  const keys = new Map();
  for (const k of body.keys || []) if (k.kid && k.kty === 'RSA') keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwks = { keys, expires: Date.now() + Math.min(Number(m ? m[1] : 3600), 86400) * 1000, loading: null };
}

async function keyFor(kid, url) {
  if (Date.now() > jwks.expires || !jwks.keys.has(kid)) {
    if (!jwks.loading) jwks.loading = loadKeys(url).catch((e) => { jwks.loading = null; throw e; });
    await jwks.loading;
  }
  return jwks.keys.get(kid);
}

export async function verifyFirebaseToken(token, { projectId, jwksUrl }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Sign-in token is malformed.');
  let header, payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch (_) { throw new HttpError(401, 'Sign-in token is malformed.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'Sign-in token uses an unexpected algorithm.');
  let key;
  try { key = await keyFor(header.kid, jwksUrl); } catch (_) { throw new HttpError(503, 'Could not check your sign-in right now. Try again shortly.'); }
  if (!key) throw new HttpError(401, 'Sign-in token was signed by an unknown key.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new HttpError(401, 'Sign-in token signature is not valid.');
  const t = Math.floor(Date.now() / 1000), skew = 60;
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new HttpError(401, 'Sign-in token is for a different project.');
  if (!(payload.exp > t - skew) || !(payload.iat <= t + skew) || (payload.auth_time && payload.auth_time > t + skew)) throw new HttpError(401, 'Your sign-in has expired. Sign in again.');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new HttpError(401, 'Sign-in token has no user.');
  const provider = (payload.firebase && payload.firebase.sign_in_provider) || '';
  return { id: 'fb:' + payload.sub, email: payload.email || '', name: payload.name || payload.email || 'Signed-in user', provider: provider === 'microsoft.com' ? 'microsoft' : provider === 'google.com' ? 'google' : provider };
}

// Local testing only: "dev.<base64url JSON {id,name,email,provider}>".
export function verifyDevToken(token) {
  const m = /^dev\.([A-Za-z0-9_-]+)$/.exec(String(token));
  if (!m) throw new HttpError(401, 'Not signed in.');
  let p;
  try { p = b64json(m[1]); } catch (_) { throw new HttpError(401, 'Not signed in.'); }
  if (typeof p.id !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(p.id)) throw new HttpError(401, 'Not signed in.');
  return { id: 'dev:' + p.id, email: String(p.email || '').slice(0, 120), name: String(p.name || p.id).slice(0, 80), provider: p.provider === 'microsoft' ? 'microsoft' : 'google' };
}

export function makeAuthenticator(config) {
  return async (req) => {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw new HttpError(401, 'Sign in to do that.');
    if (config.authMode === 'firebase') return verifyFirebaseToken(m[1], { projectId: config.firebase.projectId, jwksUrl: config.firebaseJwksUrl });
    if (config.authMode === 'dev') return verifyDevToken(m[1]);
    throw new HttpError(401, 'Accounts are not set up on this server.');
  };
}
