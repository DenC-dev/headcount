'use strict';
// Server settings, for the person who runs this Headcount server: the web
// address, email, data sources, Claude, who can sign up, selling plans with
// Stripe, and backups. Nothing here needs the command line.

const SET = { data: null };
const EMAIL_PRESETS = {
  gmail: { label: 'Gmail or Google Workspace', host: 'smtp.gmail.com', port: '465', secure: 'tls', help: 'Use an app password, not your normal password: Google Account, Security, App passwords. Gmail sends up to about 500 emails a day.', link: 'https://myaccount.google.com/apppasswords' },
  microsoft: { label: 'Microsoft 365 or Outlook.com', host: 'smtp.office365.com', port: '587', secure: 'starttls', help: 'Your organization may need to allow "authenticated SMTP" for the mailbox in the Microsoft 365 admin center.' },
  sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: '587', secure: 'starttls', user: 'apikey', help: 'The username is the word "apikey" and the password is a SendGrid API key with Mail Send access.' },
  postmark: { label: 'Postmark', host: 'smtp.postmarkapp.com', port: '587', secure: 'starttls', help: 'Use a Server API token as both the username and the password.' },
  ses: { label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: '587', secure: 'starttls', help: 'Use SMTP credentials from the SES console, and change the region in the server name if yours is different.' },
  other: { label: 'Another email service', host: '', port: '587', secure: 'starttls', help: 'Your email provider lists its SMTP server, port and sign-in details.' },
};
const SOURCES = [
  ['congressKey', 'congress', 'Congress.gov', 'Federal bills, for briefs and the Monitor.', 'https://api.congress.gov/sign-up/', 'Free key, emailed right away'],
  ['openStatesKey', 'openstates', 'Open States', 'Bills and legislators in every state.', 'https://open.pluralpolicy.com/', 'Free key on your account profile'],
  ['samKey', 'sam', 'SAM.gov', 'Federal contract opportunities. 10 requests a day without a SAM.gov role; replace the key every 90 days.', 'https://sam.gov/profile/details', 'Free key on your account details'],
  ['ldaKey', 'lda', 'LDA.gov (optional)', 'Who else is lobbying on a bill. Works without a key at a lower rate.', 'https://lda.gov/api/register/', 'Free key'],
];

async function serverSettings() {
  $('#moreMenu').open = false;
  showDrawer('<div class="row"><h2>Server settings</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">Loading</p>');
  try { SET.data = await CLOUD.api('GET', '/api/settings'); } catch (e) { showDrawer(`<div class="row"><h2>Server settings</h2><button class="btn sm" data-act="close">Close</button></div><p class="bad">${esc(e.message)}</p>`); return; }
  drawSettings();
}
function field(k, label, opts = {}) {
  const f = SET.data.fields[k] || {}, locked = f.env;
  const val = opts.secret ? '' : f.value || opts.fallback || '';
  const ph = locked ? 'Set by your host' : opts.secret && f.set ? `Saved (${f.hint || 'hidden'}). Type to replace.` : opts.ph || '';
  return `<label class="${opts.wide ? 'wide' : ''}">${esc(label)}<input id="sv_${k}" data-k="${k}" ${opts.secret ? 'type="password" autocomplete="new-password" data-secret="1"' : `type="${opts.type || 'text'}"`} value="${esc(val)}" placeholder="${esc(ph)}" ${locked ? 'disabled' : ''}></label>`;
}
const chip = (on, yes, no) => `<span class="status ${on ? 'ok' : 'wait'}">${esc(on ? yes : no)}</span>`;
function drawSettings(open) {
  const d = SET.data, f = d.fields, st = d.status, cfg = CLOUD.config || {};
  const preset = Object.entries(EMAIL_PRESETS).find(([, p]) => p.host && p.host === (f.smtpHost.value || ''))?.[0] || (f.smtpHost.value ? 'other' : 'gmail');
  const p = EMAIL_PRESETS[preset], o = (name, cond) => `<details class="sect" ${open === name || (!open && cond) ? 'open' : ''}>`;
  showDrawer(`<div class="row"><h2>Server settings</h2><button class="btn sm" data-act="close">Close</button></div>
  <p class="note">You run this Headcount server, so these settings are yours. Changes apply right away. Keys and passwords are stored encrypted and never shown again.</p>
  ${o('address', !f.publicUrl.current)}<summary>Web address ${chip(f.publicUrl.current, 'Set', 'Not set')}</summary>
    <form class="form" data-sv="address">${field('publicUrl', 'The address people use to open Headcount', { wide: true, fallback: f.publicUrl.current || location.origin, ph: 'https://headcount.yourfirm.com' })}
    <p class="note wide">Used in links inside emails: invitations, password resets, digests and action pages.</p><div class="wide"><button class="btn primary">Save</button></div></form></details>
  ${o('email', !st.email)}<summary>Email ${chip(st.email, 'Working', 'Not set up')}</summary>
    <form class="form" data-sv="email">
      <label class="wide">Email service<select id="sv_preset">${Object.entries(EMAIL_PRESETS).map(([k, x]) => `<option value="${k}" ${k === preset ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      <p class="note wide" id="sv_help">${esc(p.help)}${p.link ? ` <a href="${p.link}" target="_blank" rel="noopener">Open</a>` : ''}</p>
      ${field('smtpHost', 'Server', { fallback: f.smtpHost.value || p.host })}${field('smtpPort', 'Port', { fallback: f.smtpPort.value || p.port })}
      ${field('smtpUser', 'Username', { fallback: f.smtpUser.value || p.user || '', ph: 'you@yourfirm.com' })}${field('smtpPass', 'Password or API key', { secret: true })}
      ${field('emailFrom', 'Send as', { wide: true, ph: 'Headcount <headcount@yourfirm.com>' })}
      <input type="hidden" id="sv_smtpSecure" data-k="smtpSecure" value="${esc(f.smtpSecure.value || p.secure)}">
      <div class="wide btnrow"><button class="btn primary">Save</button><button type="button" class="btn" data-x="svTestEmail">Send a test email to me</button></div>
      <p class="note wide" id="svMailMsg" role="status"></p></form></details>
  ${o('sources', !(cfg.bills && (cfg.bills.federal || cfg.bills.states)))}<summary>Data sources ${chip(cfg.bills && cfg.bills.federal && cfg.bills.states, 'Connected', 'Keys needed')}</summary>
    <form class="form" data-sv="sources">
      ${SOURCES.map(([k, id, name, what, link, how]) => `<div class="wide srcrow"><b>${esc(name)}</b> <span class="note">${esc(what)} <a href="${link}" target="_blank" rel="noopener">${esc(how)}</a></span>
        <div class="btnrow">${field(k, `${name} key`, { secret: true })}<button type="button" class="btn sm" data-x="svTest" data-src="${id}">Test</button></div><span class="note" id="svt_${id}"></span></div>`).join('')}
      <div class="wide srcrow"><b>No key needed</b> <span class="note">The Federal Register, USAspending.gov and the U.S. Census address lookup.</span>
        <div class="btnrow">${[['fedreg', 'Federal Register'], ['usaspending', 'USAspending'], ['census', 'Census']].map(([id, n]) => `<button type="button" class="btn sm" data-x="svTest" data-src="${id}">Test ${n}</button>`).join('')}</div>
        ${['fedreg', 'usaspending', 'census'].map((id) => `<span class="note" id="svt_${id}"></span>`).join(' ')}</div>
      <div class="wide"><button class="btn primary">Save keys</button></div></form></details>
  ${o('ai', false)}<summary>Claude ${chip(st.ai, 'On', 'Off')}</summary>
    <form class="form" data-sv="ai"><p class="note wide">Claude drafts bill briefs and ranks what the Monitor finds. Usage is billed to your Anthropic account. <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Get an API key</a></p>
      ${field('anthropicKey', 'Anthropic API key', { secret: true, wide: true })}<div class="wide"><button class="btn primary">Save</button></div></form></details>
  ${st.auth === 'local' ? `${o('signups', false)}<summary>Who can sign up</summary>
    <form class="form" data-sv="signups"><label class="wide check"><input type="radio" name="sv_signups" value="open" ${(f.signups.value || 'open') === 'open' ? 'checked' : ''}> Anyone can create an account (for selling Headcount)</label>
    <label class="wide check"><input type="radio" name="sv_signups" value="invite" ${f.signups.value === 'invite' ? 'checked' : ''}> Only people with an invitation (for one firm's own server)</label>
    <div class="wide"><button class="btn primary">Save</button></div></form></details>` : ''}
  ${o('billing', false)}<summary>Sell plans with Stripe ${chip(st.billing, 'On', 'Off: everyone has every feature')}</summary>
    <form class="form" data-sv="billing"><p class="note wide">Turn this on to charge for the Team and Firm plans. Without it, every workspace gets everything, which suits a firm's own server. In Stripe, create a product with a monthly per-seat price for each plan, add a webhook to ${st.webhook ? `<code>${esc(st.webhook)}</code>` : 'your web address followed by /api/stripe/webhook'} for checkout.session.completed, customer.subscription.created, updated and deleted, and invoice.payment_failed, and turn on the customer portal.</p>
      ${field('stripeKey', 'Secret key', { secret: true })}${field('stripeWebhookSecret', 'Webhook signing secret', { secret: true })}
      ${field('stripePriceTeam', 'Team price ID', { ph: 'price_…' })}${field('stripePriceFirm', 'Firm price ID (optional)', { ph: 'price_…' })}
      ${field('priceLabelTeam', 'Team price, as shown', { ph: '$45 per seat a month' })}${field('priceLabelFirm', 'Firm price, as shown', { ph: '$75 per seat a month' })}
      ${field('salesEmail', 'Sales email (gets demo requests)', { ph: 'sales@yourfirm.com' })}${field('supportEmail', 'Support email', { ph: 'help@yourfirm.com' })}
      <div class="wide"><button class="btn primary">Save</button></div></form></details>
  ${o('backups', false)}<summary>Backups</summary>
    <p class="note">Headcount saves a copy of everything once a day and keeps the last seven${st.backups ? `; the latest is <code>${esc(st.backups)}</code>` : ''}. Download a copy to keep somewhere else, too.</p>
    <div class="btnrow"><button class="btn" data-x="svBackup">Download a backup now</button></div></details>`);
}
async function saveSection(form) {
  const patch = {};
  form.querySelectorAll('input[data-k]').forEach((i) => { if (i.disabled) return; if (i.dataset.secret && !i.value) return; patch[i.dataset.k] = i.value; });
  if (form.dataset.sv === 'signups') patch.signups = (form.querySelector('input[name=sv_signups]:checked') || {}).value || 'open';
  const btn = form.querySelector('button.primary'); btn.disabled = true;
  try {
    const r = await CLOUD.api('PUT', '/api/settings', patch);
    SET.data = { ...SET.data, fields: r.fields };
    CLOUD.config = await (await fetch('/api/config')).json();
    SET.data.status = (await CLOUD.api('GET', '/api/settings')).status;
    toast('Saved'); drawSettings(form.dataset.sv); render();
  } catch (e) { btn.disabled = false; fail(e); }
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-x]'); if (!t) return;
  const x = t.dataset.x;
  if (x === 'serverSettings') return serverSettings();
  if (x === 'svTest') {
    const out = document.getElementById(`svt_${t.dataset.src}`); out.textContent = 'Checking…'; t.disabled = true;
    try { const r = await CLOUD.api('POST', '/api/settings/test-source', { source: t.dataset.src }); out.innerHTML = `<span class="${r.ok ? 'good' : 'bad'}">${r.ok ? 'Working' : 'Not working'}:</span> ${esc(r.detail)}`; }
    catch (err) { out.innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
    t.disabled = false; return;
  }
  if (x === 'svTestEmail') {
    const msg = $('#svMailMsg'); msg.textContent = 'Sending…';
    try { const r = await CLOUD.api('POST', '/api/settings/test-email', {}); msg.innerHTML = `<span class="good">Sent to ${esc(r.sent)}.</span> Check that inbox (and its spam folder).`; }
    catch (err) { msg.innerHTML = `<span class="bad">${esc(err.message)}</span> Save your settings first if you changed them.`; }
    return;
  }
  if (x === 'svBackup') { try { await CLOUD.download('/api/settings/backup', `headcount-backup-${today()}.db`); toast('Backup downloaded'); } catch (err) { fail(err); } }
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'sv_preset') return;
  const p = EMAIL_PRESETS[e.target.value];
  $('#sv_smtpHost').value = p.host; $('#sv_smtpPort').value = p.port; $('#sv_smtpSecure').value = p.secure; if (p.user) $('#sv_smtpUser').value = p.user;
  $('#sv_help').innerHTML = `${esc(p.help)}${p.link ? ` <a href="${p.link}" target="_blank" rel="noopener">Open</a>` : ''}`;
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-sv]'); if (!f) return;
  e.preventDefault(); saveSection(f);
});
