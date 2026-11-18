import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpError } from './db.js';

// Server settings the operator manages in the app, so running Headcount needs
// no environment variables. An environment variable, when set, always wins and
// shows as locked. Secret values are encrypted with a key kept outside the
// database (APP_SECRET, or a key file next to it) and never sent back out.

const ENV0 = { ...process.env }; // what the host set before anything changed it
const F = {
  publicUrl: { env: ['PUBLIC_URL', 'RENDER_EXTERNAL_URL'], max: 200, url: true },
  signups: { values: ['open', 'invite'] },
  smtpHost: { env: ['SMTP_URL'], max: 200 }, smtpPort: { env: ['SMTP_URL'], max: 5 }, smtpSecure: { env: ['SMTP_URL'], values: ['tls', 'starttls'] },
  smtpUser: { env: ['SMTP_URL'], max: 200 }, smtpPass: { env: ['SMTP_URL'], secret: true, max: 400 }, emailFrom: { env: ['EMAIL_FROM'], max: 200 },
  congressKey: { env: ['CONGRESS_API_KEY'], secret: true, max: 200 }, openStatesKey: { env: ['OPENSTATES_API_KEY'], secret: true, max: 200 },
  samKey: { env: ['SAM_API_KEY'], secret: true, max: 200 }, ldaKey: { env: ['LDA_API_KEY'], secret: true, max: 200 },
  anthropicKey: { env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], secret: true, max: 400 },
  stripeKey: { env: ['STRIPE_SECRET_KEY'], secret: true, max: 300 }, stripeWebhookSecret: { env: ['STRIPE_WEBHOOK_SECRET'], secret: true, max: 300 },
  stripePriceTeam: { env: ['STRIPE_PRICE_TEAM'], max: 120 }, stripePriceFirm: { env: ['STRIPE_PRICE_FIRM'], max: 120 },
  priceLabelTeam: { env: ['PRICE_LABEL_TEAM'], max: 80 }, priceLabelFirm: { env: ['PRICE_LABEL_FIRM'], max: 80 },
  salesEmail: { env: ['SALES_EMAIL'], max: 160 }, supportEmail: { env: ['SUPPORT_EMAIL'], max: 160 },
};
const fromEnv = (k) => F[k].env && F[k].env.some((e) => ENV0[e]);

export function makeSettings(cfg, store, { keyFile = null, onChange = () => {} } = {}) {
  // ---------- encryption at rest ----------
  let key = null;
  const getKey = () => {
    if (key) return key;
    if (ENV0.APP_SECRET) return (key = crypto.createHash('sha256').update(ENV0.APP_SECRET).digest());
    if (keyFile) {
      try { key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); if (key.length === 32) return key; } catch (_) { /* first run */ }
      key = crypto.randomBytes(32);
      try { fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 }); } catch (e) { console.error('Could not save the settings key:', e.message); }
      return key;
    }
    return (key = crypto.randomBytes(32));
  };
  const seal = (v) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', getKey(), iv), ct = Buffer.concat([c.update(String(v), 'utf8'), c.final()]); return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`; };
  const open = (v) => {
    if (!String(v || '').startsWith('enc:v1:')) return v || '';
    try { const [, , iv, tag, ct] = v.split(':'); const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'); }
    catch (_) { console.error('A saved setting could not be decrypted (was the key file replaced?)'); return ''; }
  };
  const read = (k) => { const v = store.setting(`cfg.${k}`); return F[k].secret ? open(v) : v || ''; };

  // ---------- applying settings ----------
  let setAnthropic = false;
  function apply() {
    const val = (k) => (fromEnv(k) ? null : read(k));
    for (const k of ['congressKey', 'openStatesKey', 'samKey', 'ldaKey', 'stripeKey', 'stripeWebhookSecret', 'stripePriceTeam', 'stripePriceFirm', 'priceLabelTeam', 'priceLabelFirm', 'salesEmail', 'supportEmail']) {
      const v = val(k); if (v !== null) cfg[k] = v;
    }
    const url = val('publicUrl'); if (url !== null && url) cfg.publicUrl = url.replace(/\/+$/, '');
    if (!fromEnv('smtpHost')) {
      const host = read('smtpHost');
      if (host) {
        const port = Number(read('smtpPort')) || 587, secure = read('smtpSecure') ? read('smtpSecure') === 'tls' : port === 465, user = read('smtpUser');
        cfg.smtp = { host, port, secure, auth: user ? { user, pass: read('smtpPass') } : undefined };
        if (!ENV0.EMAIL_MODE) cfg.emailMode = 'smtp';
      } else { cfg.smtp = null; if (!ENV0.EMAIL_MODE && cfg.authMode !== 'dev') cfg.emailMode = cfg.smtpUrl ? 'smtp' : 'off'; }
    }
    if (!fromEnv('emailFrom')) { const user = read('smtpUser'); cfg.emailFrom = read('emailFrom') || (/@/.test(user) ? `Headcount <${user}>` : cfg.emailFrom || ''); }
    if (!fromEnv('anthropicKey')) {
      const k = read('anthropicKey');
      if (k) { process.env.ANTHROPIC_API_KEY = k; setAnthropic = true; } else if (setAnthropic) { delete process.env.ANTHROPIC_API_KEY; setAnthropic = false; }
      cfg.aiEnabled = Boolean(k) && ENV0.AI_DRAFTING !== 'off';
    }
    cfg.billing = Boolean(cfg.stripeKey && cfg.stripeWebhookSecret && cfg.stripePriceTeam && cfg.publicUrl);
    if (cfg.publicUrl && (cfg.smtp || cfg.smtpUrl) && !cfg.emailFrom) cfg.emailFrom = 'Headcount <no-reply@localhost>';
    onChange();
  }

  // ---------- reading and saving ----------
  function view() {
    const fields = {};
    for (const k of Object.keys(F)) {
      const env = fromEnv(k), v = env ? '' : read(k);
      fields[k] = F[k].secret ? { set: env || Boolean(v), hint: v ? `…${v.slice(-4)}` : '', env } : { value: env ? '' : v, env };
    }
    fields.publicUrl.current = cfg.publicUrl || '';
    return { fields };
  }
  function save(patch) {
    if (!patch || typeof patch !== 'object') throw new HttpError(400, 'Nothing to save.');
    for (const [k, raw] of Object.entries(patch)) {
      const f = F[k];
      if (!f) throw new HttpError(400, `Unknown setting: ${k}`);
      if (fromEnv(k)) continue; // set by the host; the environment wins
      if (f.secret && raw === undefined) continue;
      const v = String(raw == null ? '' : raw).trim();
      if (v.length > (f.max || 200)) throw new HttpError(400, `That value for ${k} is too long.`);
      if (f.values && v && !f.values.includes(v)) throw new HttpError(400, `Choose one of: ${f.values.join(', ')}.`);
      if (f.url && v && !/^https?:\/\/[^\s/]+[^\s]*$/.test(v)) throw new HttpError(400, 'The web address should start with https://');
      if (k === 'smtpPort' && v && !/^\d{2,5}$/.test(v)) throw new HttpError(400, 'The email port is a number such as 465 or 587.');
      if (/Email$|^emailFrom$/.test(k) && v && !/@/.test(v)) throw new HttpError(400, `${k === 'emailFrom' ? 'The From address' : 'That'} needs an email address.`);
      store.putSetting(`cfg.${k}`, v ? (f.secret ? seal(v) : v) : '');
    }
    apply();
    return view();
  }
  apply();
  return { view, save, apply, read, seal, open };
}
