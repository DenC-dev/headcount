import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

// Outgoing email goes through any SMTP service (Amazon SES, Postmark,
// SendGrid, Mailgun, Google Workspace or Microsoft 365 relays). Messages wait
// in a queue in the database and are retried with backoff, so a slow or
// failing mail service never blocks a request. With EMAIL_MODE=outbox
// (local testing) messages are kept in the queue and not sent.

export function makeMailer(cfg, store) {
  let transport = null;
  const build = () => { transport = cfg.smtpTransport || (cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : cfg.smtp ? nodemailer.createTransport({ ...cfg.smtp, connectionTimeout: 15000, greetingTimeout: 15000 }) : null); };
  build();

  // Whether the last attempt to send worked, kept across restarts, so the
  // person who runs Headcount sees "Not sending" instead of a false "Working".
  const readHealth = () => { try { return JSON.parse(store.setting('mail.health') || 'null') || { ok: null }; } catch (_) { return { ok: null }; } };
  let health = readHealth();
  const note = (ok, err) => {
    const next = ok ? { ok: true, at: Date.now() } : { ok: false, at: Date.now(), error: String((err && err.message) || err || '').slice(0, 300) };
    if (health.ok === next.ok && health.error === next.error && Date.now() - (health.at || 0) < 600e3) return;
    health = next; store.putSetting('mail.health', JSON.stringify(health));
  };
  function problem() {
    if (!isEnabled() || cfg.emailMode === 'outbox' || health.ok !== false) return null;
    return { at: health.at, error: health.error, explain: explainMailError(health.error, (cfg.smtp && cfg.smtp.host) || cfg.smtpUrl || '') };
  }
  // After the settings change, try what is waiting (from the last 3 days) right away.
  function reconfigure() {
    build(); health = { ok: null }; store.putSetting('mail.health', '');
    try { store.q.retryEmails.run(Date.now() - 3 * 864e5); } catch (_) { /* older database */ }
    setTimeout(() => { work().catch(() => {}); }, 50).unref?.();
  }
  const isEnabled = () => cfg.emailMode !== 'off' && (Boolean(transport) || cfg.emailMode === 'outbox');

  // Signed links for one-click unsubscribe; they never expire but only work for one person and one kind of email.
  const sign = (uid, kind) => crypto.createHmac('sha256', store.secret()).update(`${uid}|${kind}`).digest('base64url').slice(0, 32);
  const unsubToken = (uid, kind) => `${Buffer.from(uid).toString('base64url')}.${kind}.${sign(uid, kind)}`;
  function readToken(token) {
    const [u, kind, sig] = String(token || '').split('.');
    if (!u || !kind || !sig) return null;
    let uid; try { uid = Buffer.from(u, 'base64url').toString('utf8'); } catch (_) { return null; }
    const want = Buffer.from(sign(uid, kind)), got = Buffer.from(sig);
    return got.length === want.length && crypto.timingSafeEqual(got, want) ? { uid, kind } : null;
  }

  function queue({ to, subject, text, html, kind, userId, replyTo, unsubscribeKind, dedupe }) {
    if (!isEnabled() || !to) return false;
    const unsub = userId && unsubscribeKind ? `${cfg.publicUrl}/api/unsubscribe?t=${unsubToken(userId, unsubscribeKind)}` : null;
    store.enqueueEmail({ to, subject, text, html, kind, userId, replyTo, unsubscribe: unsub, dedupe });
    return true;
  }

  let running = false;
  async function work(nowMs = Date.now()) {
    if (running || cfg.emailMode === 'outbox' || !transport) return 0;
    running = true; let sent = 0;
    try {
      for (const m of store.q.dueEmails.all(nowMs, 20)) {
        try {
          await transport.sendMail({
            from: cfg.emailFrom, to: m.to_addr, subject: m.subject, text: m.text_body, html: m.html_body || undefined, replyTo: m.reply_to || undefined,
            headers: m.unsubscribe ? { 'List-Unsubscribe': `<${m.unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
          });
          store.q.sentEmail.run(Date.now(), m.id); sent++; note(true);
        } catch (e) {
          const wait = Math.min(6 * 3600e3, 60e3 * 2 ** m.attempts);
          store.q.failedEmail.run(Date.now() + wait, String(e && e.message || e).slice(0, 300), m.id);
          console.error('Email to', m.to_addr, 'failed:', e && e.message); note(false, e);
          if (/auth|login|credential|535|534|530/i.test(String(e && (e.code || '') + ' ' + (e.message || '')))) break; // the rest would fail the same way
        }
      }
    } finally { running = false; }
    return sent;
  }

  // Sends one message right away, for "send a test email" in server settings.
  async function sendNow({ to, subject, text, html }) {
    if (!transport) throw new Error('Email is not set up yet.');
    try { await transport.sendMail({ from: cfg.emailFrom, to, subject, text, ...(html ? { html } : {}) }); note(true); }
    catch (e) { note(false, e); const x = new Error(explainMailError(e.message || String(e), (cfg.smtp && cfg.smtp.host) || cfg.smtpUrl || '')); x.raw = e.message; throw x; }
  }
  return { get enabled() { return isEnabled(); }, reconfigure, sendNow, queue, work, problem, unsubToken, readToken, outbox: (n = 50) => store.q.outbox.all(n) };
}

// What a failed send means, in words the person fixing it can act on.
export function explainMailError(msg, host = '') {
  const m = String(msg || ''), gmail = /gmail|google/i.test(host), ms = /office365|outlook|microsoft|live\.com|hotmail/i.test(host);
  if (/535|534|5\.7\.8|5\.7\.9|invalid login|username and password not accepted|authentication (unsuccessful|failed)|EAUTH|badcredentials/i.test(m)) {
    if (gmail) return 'Gmail did not accept the password. Gmail needs an app password, not your normal Gmail password: turn on 2-Step Verification in your Google account, open myaccount.google.com/apppasswords, make one called Headcount, and paste the 16 letters into the password box here. Also check the address is the full Gmail address.';
    if (ms) return 'Microsoft did not accept the email address and password. Check them, and ask whoever manages your Microsoft 365 to allow "Authenticated SMTP" for that mailbox.';
    return 'The email service did not accept the username and password. Check them with your email provider.';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET|ECONNECTION|greeting never received/i.test(m)) return 'Headcount could not reach the outgoing mail server. Check the server name and port under More options.';
  if (/sender|from address|not owned|5\.7\.1|553|550/i.test(m)) return 'The email service would not send from that From address. Use the same address you signed in with, or one your provider lets you send from.';
  return `The email service refused: ${m.slice(0, 200)}`;
}

// A plain, readable HTML version of a text email. Every value is escaped.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Headcount's emails: a dark band with the wordmark, a white card with the
// message, and a quiet footer. Tables and inline styles so Outlook and Gmail
// draw it the same; a <style> block adds dark mode and phone sizes where the
// mail app supports them. Every value is escaped.
const F = "'Archivo','Helvetica Neue',Helvetica,Arial,sans-serif";
const C = { bg: '#f4f4f3', card: '#ffffff', ink: '#0b0f17', muted: '#5d6168', line: '#e3e3df', soft: '#f7f7f5', accent: '#1366d6', signal: '#f0561d', night: '#070a10', yes: '#0f9a6c', no: '#d23b4e', und: '#b7860f' };
const TONE = { good: C.yes, bad: C.no, warn: C.und, info: C.accent, muted: C.muted };
const pctBar = (have, need) => Math.max(0, Math.min(100, Math.round((need ? have / need : 0) * 100)));

function button(a, secondary = false) {
  if (!a || !a.url) return '';
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:${secondary ? '0' : '26px 0 0'}"><tr><td class="hc-btn" bgcolor="${secondary ? C.card : C.accent}" style="background:${secondary ? C.card : C.accent};border:1px solid ${secondary ? C.line : C.accent};border-radius:2px">
<a href="${esc(a.url)}" target="_blank" style="display:inline-block;padding:13px 22px;font:600 14px/1 ${F};letter-spacing:.04em;text-transform:uppercase;color:${secondary ? C.ink : '#ffffff'};text-decoration:none">${esc(a.label)}&nbsp;&rarr;</a></td></tr></table>`;
}
function chip(text, tone = 'info') {
  const c = TONE[tone] || C.accent;
  return `<span style="display:inline-block;padding:3px 8px;border:1px solid ${c};color:${c};font:600 11px/1.3 ${F};letter-spacing:.05em;text-transform:uppercase;white-space:nowrap">${esc(text)}</span>`;
}
function rows(list) {
  return list.filter((r) => r && r.text).map((r) => `<tr>
<td valign="top" class="hc-lbl" style="padding:7px 12px 7px 0;width:96px;font:600 11px/1.6 ${F};letter-spacing:.06em;text-transform:uppercase;color:${TONE[r.tone] || C.muted}">${esc(r.label || '')}</td>
<td valign="top" class="hc-ink" style="padding:7px 0;font:15px/1.5 ${F};color:${r.tone === 'bad' ? C.no : C.ink}">${esc(r.text)}</td></tr>`).join('');
}
function card(c) {
  const odds = c.odds && typeof c.odds.pct === 'number' ? `<tr><td colspan="2" style="padding:14px 0 4px">
<span class="hc-ink" style="font:300 40px/1 ${F};letter-spacing:-.04em;color:${c.odds.pct >= 60 ? C.yes : c.odds.pct >= 35 ? C.ink : C.no}">${esc(c.odds.text || `${c.odds.pct}%`)}</span>
<span style="font:13px ${F};color:${C.muted}">&nbsp;${esc(c.odds.label || 'odds of passage')}</span>${c.odds.delta ? `&nbsp;&nbsp;${chip(`${c.odds.delta > 0 ? '+' : ''}${c.odds.delta} pts ${c.odds.period === 'day' ? 'since yesterday' : 'this week'}`, c.odds.delta > 0 ? 'good' : 'bad')}` : ''}</td></tr>` : '';
  const bar = c.bar && c.bar.need ? `<tr><td colspan="2" style="padding:8px 0 2px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse"><tr>
<td width="${pctBar(c.bar.have, c.bar.need)}%" style="background:${C.yes};height:6px;font-size:0;line-height:0">&nbsp;</td>
<td style="background:${C.line};height:6px;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font:13px/1.5 ${F};color:${C.muted};padding-top:6px">${esc(c.bar.text || (c.bar.have >= c.bar.need ? `${c.bar.have} votes: ${c.bar.have - c.bar.need} more than the ${c.bar.need} needed` : `${c.bar.have} of the ${c.bar.need} votes needed`))}</div></td></tr>` : '';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="hc-card2" style="border:1px solid ${C.line};background:${C.card};margin:0 0 14px;border-collapse:separate">
<tr><td class="hc-cardpad" style="padding:18px 20px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
<tr><td valign="top">${c.url ? `<a href="${esc(c.url)}" target="_blank" class="hc-ink" style="font:600 17px/1.3 ${F};color:${C.ink};text-decoration:none">${esc(c.title)}</a>` : `<span class="hc-ink" style="font:600 17px/1.3 ${F};color:${C.ink}">${esc(c.title)}</span>`}
${c.sub ? `<div style="font:13px/1.5 ${F};color:${C.muted};padding-top:3px">${esc(c.sub)}</div>` : ''}</td>
<td valign="top" align="right" style="padding-left:10px">${c.chip ? chip(c.chip.text, c.chip.tone) : ''}</td></tr>
${odds}${bar}
${c.rows && c.rows.length ? `<tr><td colspan="2" style="padding-top:10px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${C.line}">${rows(c.rows)}</table></td></tr>` : ''}
${c.action ? `<tr><td colspan="2" style="padding-top:12px"><a href="${esc(c.action.url)}" target="_blank" style="font:600 13px ${F};letter-spacing:.04em;text-transform:uppercase;color:${C.accent};text-decoration:none">${esc(c.action.label)} &rarr;</a></td></tr>` : ''}
</table></td></tr></table>`;
}
function block(b) {
  if (b.lead) return `<p class="hc-ink" style="margin:0 0 18px;font:18px/1.5 ${F};color:${C.ink}">${esc(b.lead)}</p>`;
  if (b.p) return `<p class="hc-ink" style="margin:0 0 14px;font:15px/1.6 ${F};color:${C.ink}">${esc(b.p)}</p>`;
  if (b.small) return `<p style="margin:0 0 12px;font:13px/1.55 ${F};color:${C.muted}">${esc(b.small)}</p>`;
  if (b.title) return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 12px"><tr>
<td style="width:8px;height:8px;background:${C.signal};font-size:0;line-height:0">&nbsp;</td>
<td style="padding-left:10px;font:600 12px/1 ${F};letter-spacing:.08em;text-transform:uppercase;color:${C.muted}">${esc(b.title)}</td></tr></table>${b.sub ? `<p style="margin:-4px 0 12px;font:13px/1.5 ${F};color:${C.muted}">${esc(b.sub)}</p>` : ''}`;
  if (b.list) return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px">${b.list.map((x) => `<tr><td valign="top" style="width:16px;padding:6px 0;color:${C.accent};font:15px/1.5 ${F}">&#9642;</td><td class="hc-ink" style="padding:6px 0;font:15px/1.5 ${F};color:${C.ink}">${esc(x)}</td></tr>`).join('')}</table>`;
  if (b.stats) return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 22px;border-top:1px solid ${C.ink}"><tr>${b.stats.map(([v, label, tone]) => `<td valign="top" class="hc-stat" style="padding:12px 12px 0 0;width:${Math.floor(100 / b.stats.length)}%">
<div class="hc-ink hc-statv" style="font:300 34px/1 ${F};letter-spacing:-.04em;color:${TONE[tone] || C.ink}">${esc(v)}</div><div style="font:600 11px/1.4 ${F};letter-spacing:.06em;text-transform:uppercase;color:${C.muted};padding-top:6px">${esc(label)}</div></td>`).join('')}</tr></table>`;
  if (b.card) return card(b.card);
  if (b.items) return b.items.map((it) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${C.line}"><tr><td style="padding:14px 0">
${it.chip ? `<div style="padding-bottom:6px">${chip(it.chip.text, it.chip.tone)}</div>` : ''}
${it.url ? `<a href="${esc(it.url)}" target="_blank" class="hc-ink" style="font:600 15px/1.4 ${F};color:${C.ink};text-decoration:none">${esc(it.title)}</a>` : `<span class="hc-ink" style="font:600 15px/1.4 ${F};color:${C.ink}">${esc(it.title)}</span>`}
${it.meta ? `<div style="font:13px/1.5 ${F};color:${C.muted};padding-top:3px">${esc(it.meta)}</div>` : ''}
${it.note ? `<div class="hc-ink" style="font:14px/1.5 ${F};color:${C.ink};padding-top:6px">${esc(it.note)}</div>` : ''}</td></tr></table>`).join('');
  if (b.callout) return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 16px"><tr>
<td style="width:3px;background:${TONE[b.tone] || C.signal};font-size:0">&nbsp;</td>
<td class="hc-soft" style="background:${C.soft};padding:12px 14px;font:14px/1.55 ${F};color:${C.ink}">${esc(b.callout)}</td></tr></table>`;
  if (b.quote) return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 16px"><tr><td class="hc-soft" style="background:${C.soft};border:1px solid ${C.line};padding:16px 18px">
<div class="hc-ink" style="font:500 17px/1.45 ${F};color:${C.ink}">${esc(b.quote)}</div>${b.by ? `<div style="font:13px/1.5 ${F};color:${C.muted};padding-top:8px">${esc(b.by)}</div>` : ''}</td></tr></table>`;
  if (b.kv) return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px;border-top:1px solid ${C.line}">${rows(b.kv.map(([label, text]) => ({ label, text })))}</table>`;
  if (b.link) return `<p style="margin:14px 0 0;font:12px/1.5 ${F};color:${C.muted}">Or paste this link into your browser:<br><a href="${esc(b.link)}" style="color:${C.accent};word-break:break-all">${esc(b.link)}</a></p>`;
  if (b.divider) return `<div style="border-top:1px solid ${C.line};margin:22px 0"></div>`;
  return '';
}

/**
 * heading, eyebrow (small orange label above it), preheader (the inbox preview
 * line), blocks (see block() above), action ({ url, label }), secondary (a
 * second, quieter button), footer (HTML: settings and unsubscribe links).
 */
export function htmlEmail({ heading, eyebrow, preheader, blocks = [], action, secondary, after = [], footer }) {
  const pre = preheader || (blocks.find((b) => b.lead || b.p) || {}).lead || (blocks.find((b) => b.p) || {}).p || '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(heading || 'Headcount')}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,300..700&display=swap" rel="stylesheet">
<style>
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
a{color:${C.accent}}
@media (max-width:620px){.hc-pad{padding:26px 20px!important}.hc-h1{font-size:24px!important}.hc-statv{font-size:26px!important}.hc-stat{padding-right:8px!important}.hc-lbl{width:68px!important}.hc-cardpad{padding:16px!important}}
@media (prefers-color-scheme:dark){
 .hc-bg{background:#0b0e14!important}.hc-card{background:#121722!important;border-color:#232a37!important}.hc-card2{background:#161c28!important;border-color:#2a3242!important}
 .hc-ink,.hc-ink a{color:#eef1f6!important}.hc-soft{background:#1a2130!important;border-color:#2a3242!important;color:#eef1f6!important}.hc-foot{color:#8c94a3!important}
}
</style></head>
<body class="hc-bg" style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(String(pre).slice(0, 140))}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="hc-bg" style="background:${C.bg}"><tr><td align="center" style="padding:28px 12px 36px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">
<tr><td style="background:${C.night};padding:20px 28px" bgcolor="${C.night}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
<td style="font:700 21px/1 ${F};letter-spacing:-.03em;color:#ffffff"><span style="color:#2fc08f;font-size:13px;letter-spacing:1px;vertical-align:3px">&#9679;</span><span style="color:#e9bd45;font-size:13px;letter-spacing:1px;vertical-align:3px">&#9679;</span><span style="color:#e5566b;font-size:13px;letter-spacing:4px;vertical-align:3px">&#9679;</span>headcount</td>
${eyebrow ? `<td align="right" style="font:600 11px/1 ${F};letter-spacing:.1em;text-transform:uppercase;color:#8c94a3">${esc(eyebrow)}</td>` : ''}
</tr></table></td></tr>
<tr><td style="background:${C.signal};height:3px;font-size:0;line-height:0" bgcolor="${C.signal}">&nbsp;</td></tr>
<tr><td class="hc-card hc-pad" style="background:${C.card};border:1px solid ${C.line};border-top:0;padding:34px 32px 32px" bgcolor="${C.card}">
${heading ? `<h1 class="hc-ink hc-h1" style="margin:0 0 16px;font:600 28px/1.15 ${F};letter-spacing:-.03em;color:${C.ink}">${esc(heading)}</h1>` : ''}
${blocks.map(block).join('\n')}
${action || secondary ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td>${button(action)}</td>${secondary ? `<td style="padding:26px 0 0 10px">${button(secondary, true)}</td>` : ''}</tr></table>` : ''}
${after.map(block).join('\n')}
</td></tr>
<tr><td class="hc-foot" style="padding:18px 8px 0;font:12px/1.6 ${F};color:${C.muted}">
${footer ? `${footer}<br>` : ''}<span style="color:#9aa0a8">Headcount: whip counts, meetings and bill tracking.</span></td></tr>
</table></td></tr></table></body></html>`;
}
export { esc };
