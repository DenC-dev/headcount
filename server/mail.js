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
          store.q.sentEmail.run(Date.now(), m.id); sent++;
        } catch (e) {
          const wait = Math.min(6 * 3600e3, 60e3 * 2 ** m.attempts);
          store.q.failedEmail.run(Date.now() + wait, String(e && e.message || e).slice(0, 300), m.id);
          console.error('Email to', m.to_addr, 'failed:', e && e.message);
        }
      }
    } finally { running = false; }
    return sent;
  }

  // Sends one message right away, for "send a test email" in server settings.
  async function sendNow({ to, subject, text }) {
    if (!transport) throw new Error('Email is not set up yet.');
    await transport.sendMail({ from: cfg.emailFrom, to, subject, text });
  }
  return { get enabled() { return isEnabled(); }, reconfigure: build, sendNow, queue, work, unsubToken, readToken, outbox: (n = 50) => store.q.outbox.all(n) };
}

// A plain, readable HTML version of a text email. Every value is escaped.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function htmlEmail({ heading, blocks, action, footer }) {
  const block = (b) => {
    if (b.list) return `<ul style="margin:0 0 14px;padding-left:20px">${b.list.map((x) => `<li style="margin:0 0 4px">${esc(x)}</li>`).join('')}</ul>`;
    if (b.title) return `<h2 style="font:600 16px/1.3 Arial,sans-serif;margin:22px 0 6px;color:#141b2b">${esc(b.title)}</h2>${b.sub ? `<p style="margin:0 0 8px;color:#5a6478;font-size:13px">${esc(b.sub)}</p>` : ''}`;
    return `<p style="margin:0 0 14px">${esc(b.p)}</p>`;
  };
  return `<!doctype html><html><body style="margin:0;background:#f3f5f8"><div style="max-width:600px;margin:0 auto;padding:24px 16px;font:15px/1.5 Arial,sans-serif;color:#141b2b">
<div style="font:700 12px Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#2b3fbf;margin-bottom:12px">Headcount</div>
<div style="background:#ffffff;border:1px solid #d9dee7;border-radius:10px;padding:22px">
${heading ? `<h1 style="font:700 20px/1.25 Arial,sans-serif;margin:0 0 14px">${esc(heading)}</h1>` : ''}
${blocks.map(block).join('\n')}
${action ? `<p style="margin:18px 0 0"><a href="${esc(action.url)}" style="display:inline-block;background:#2b3fbf;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">${esc(action.label)}</a></p>` : ''}
</div>
${footer ? `<p style="font-size:12px;color:#5a6478;margin:14px 4px">${footer}</p>` : ''}
</div></body></html>`;
}
export { esc };
