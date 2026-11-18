'use strict';
// Admin settings, for the person who runs this Headcount: the web address,
// email, bill and legislator data, AI writing help, who can sign up, payments,
// customers and backups. Written for lobbyists, not engineers.

const SET = { data: null, payOff: false };
const EMAIL_PRESETS = {
  gmail: { label: 'Gmail or Google Workspace', host: 'smtp.gmail.com', port: '465', secure: 'tls', user: 'Gmail address', pass: 'App password (16 letters)', ph: 'you@gmail.com',
    help: 'Google needs an app password for this, not your normal password. Turn on 2-Step Verification for your Google account, then open App passwords, make one named Headcount, and paste the 16 letters below. Gmail sends up to about 500 emails a day.', link: ['https://myaccount.google.com/apppasswords', 'Open App passwords'] },
  microsoft: { label: 'Microsoft 365 or Outlook.com', host: 'smtp.office365.com', port: '587', secure: 'starttls', user: 'Email address', pass: 'Password', ph: 'you@yourfirm.com',
    help: 'Use the email address and password of the mailbox Headcount should send from. If the test email fails, ask your IT administrator to allow "Authenticated SMTP" for that mailbox.' },
  sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: '587', secure: 'starttls', userValue: 'apikey', user: 'Username (leave it as apikey)', pass: 'SendGrid API key', help: 'In SendGrid, create an API key with Mail Send access and paste it below.' },
  postmark: { label: 'Postmark', host: 'smtp.postmarkapp.com', port: '587', secure: 'starttls', user: 'Server token', pass: 'Server token again', help: 'In Postmark, copy your server\'s API token and paste it in both boxes.' },
  ses: { label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: '587', secure: 'starttls', user: 'SMTP username', pass: 'SMTP password', help: 'Create SMTP credentials in the Amazon SES console. If your region is not us-east-1, change it under More options.' },
  other: { label: 'Something else', host: '', port: '587', secure: 'starttls', user: 'Username', pass: 'Password', help: 'Your email provider\'s help pages list the outgoing mail (SMTP) server, port, username and password. Enter them under More options.' },
};
const SOURCES = [
  ['congressKey', 'congress', 'Congress.gov', 'Bills in Congress, for bill briefs and the Monitor.', 'https://api.congress.gov/sign-up/', 'Get a free key (emailed to you right away)'],
  ['openStatesKey', 'openstates', 'Open States', 'Bills and legislators in all 50 states.', 'https://open.pluralpolicy.com/', 'Get a free key (on your account page after you sign up)'],
  ['samKey', 'sam', 'SAM.gov (optional)', 'Federal contract opportunities, for the Monitor. The free key has to be renewed every 90 days.', 'https://sam.gov/profile/details', 'Get a free key (on your account details)'],
  ['ldaKey', 'lda', 'Lobbying disclosures, LDA.gov (optional)', 'Who else is lobbying on a bill. Works without a key, just more slowly.', 'https://lda.gov/api/register/', 'Get a free key'],
];

async function serverSettings() {
  $('#moreMenu').open = false;
  showDrawer('<div class="row"><h2>Admin settings</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">Loading</p>');
  try { SET.data = await CLOUD.api('GET', '/api/settings'); } catch (e) { showDrawer(`<div class="row"><h2>Admin settings</h2><button class="btn sm" data-act="close">Close</button></div><p class="bad">${esc(e.message)}</p>`); return; }
  drawSettings();
}
function field(k, label, opts = {}) {
  const f = SET.data.fields[k] || {}, locked = f.env;
  const val = opts.secret ? '' : f.value || opts.fallback || '';
  const ph = locked ? 'Set by whoever hosts this server' : opts.secret && f.set ? `Saved (ends ${f.hint || 'hidden'}). Type to replace it.` : opts.ph || '';
  return `<label class="${opts.wide ? 'wide' : ''}"><span ${opts.lid ? `id="${opts.lid}"` : ''}>${esc(label)}</span><input id="sv_${k}" data-k="${k}" ${opts.secret ? 'type="password" autocomplete="new-password" data-secret="1"' : `type="${opts.type || 'text'}"`} value="${esc(val)}" placeholder="${esc(ph)}" ${locked ? 'disabled' : ''}></label>`;
}
const chip = (on, yes, no) => `<span class="status ${on ? 'ok' : 'wait'}">${esc(on ? yes : no)}</span>`;
const dollars = (label, d) => { const m = /\$([\d,.]+)/.exec(label || ''); return m ? m[1].replace(/,/g, '') : d; };
const helpHtml = (p) => `${esc(p.help)}${p.link ? ` <a href="${p.link[0]}" target="_blank" rel="noopener">${esc(p.link[1])}</a>` : ''}`;

function paymentsSection(f, st, open) {
  const acct = f.stripeAccount.value || '', test = / \(test mode\)$/.test(acct), on = st.billing;
  const head = `${open('billing', false)}<summary>Payments ${chip(on, test ? 'On, in test mode' : 'On', 'Off: everything is free')}</summary>`;
  if (f.stripeKey.env) return `${head}<p class="note">Payments are set up by whoever hosts this server${on ? ' and are on' : ''}.</p></details>`;
  const prices = `<label>Team plan: dollars per person a month<input id="pay_team" inputmode="decimal" value="${esc(dollars(f.priceLabelTeam.value, '45'))}"></label>
      <label>Firm plan: dollars per person a month<input id="pay_firm" inputmode="decimal" value="${esc(on ? dollars(f.priceLabelFirm.value, '') : '75')}" placeholder="Leave empty for no Firm plan"></label>`;
  if (!on) return `${head}
    <p class="note">Charge customers for the Team and Firm plans. Payments go through Stripe, which takes cards, sends receipts and pays the money into your bank account. Until you connect it, everyone gets every feature for free.</p>
    <ol class="steps howto">
      <li><b>Make a Stripe account.</b> It is free: <a href="https://dashboard.stripe.com/register" target="_blank" rel="noopener">sign up at stripe.com</a>. You can try everything in test mode before Stripe asks for your business and bank details.</li>
      <li><b>Copy your secret key.</b> In Stripe, open <a href="https://dashboard.stripe.com/test/apikeys" target="_blank" rel="noopener">Developers, then API keys</a>. Next to <i>Secret key</i>, click <i>Reveal</i> and copy it. Start with the test key, which begins <code>sk_test_</code>.</li>
      <li><b>Paste it here, choose your prices and connect.</b> Headcount sets up the plans, the checkout page, receipts and the page where customers manage their billing, all in your Stripe account.</li>
    </ol>
    <form class="form" id="svPayForm">
      <label class="wide">Stripe secret key<input id="pay_key" type="password" autocomplete="off" placeholder="sk_test_…" required></label>
      ${prices}
      <p class="note wide">Customers start with a ${esc(String((CLOUD.config && CLOUD.config.billing && CLOUD.config.billing.trialDays) || 14))}-day free trial of the Team plan, then choose a plan and pay by card. Prices are in U.S. dollars.</p>
      <div class="wide"><button class="btn primary">Connect Stripe</button></div><p class="note wide" id="payMsg" role="status"></p></form></details>`;
  return `${head}
    <p class="note"><span class="good">Connected</span> to <b>${esc(acct.replace(/ \(test mode\)$/, ''))}</b>. Team: ${esc(f.priceLabelTeam.value || 'not set')}. Firm: ${esc(f.priceLabelFirm.value || 'not offered')}.</p>
    ${test ? `<div class="callout"><b>Test mode: no real money moves.</b> To try it, open Workspace, choose a plan, and pay with the card number 4242 4242 4242 4242, any future date and any three digits.
      When you are ready for real payments, finish your business and bank details in Stripe, then paste your live secret key (it begins <code>sk_live_</code>) below and click Save.</div>` : ''}
    <form class="form" id="svPayForm">
      <label class="wide">${test ? 'Live secret key, when you are ready' : 'Stripe secret key'}<input id="pay_key" type="password" autocomplete="off" placeholder="Leave empty to keep the current key"></label>
      ${prices}
      <p class="note wide">A new price applies to new customers; people already paying keep their price until you change it in Stripe.</p>
      <div class="wide btnrow"><button class="btn primary">Save</button><button type="button" class="btn warn" data-x="payOff">${SET.payOff ? 'Click again to turn off payments' : 'Turn off payments'}</button></div>
      <p class="note wide" id="payMsg" role="status"></p></form></details>`;
}

function drawSettings(open) {
  const d = SET.data, f = d.fields, st = d.status, cfg = CLOUD.config || {};
  const preset = Object.entries(EMAIL_PRESETS).find(([, p]) => p.host && p.host === (f.smtpHost.value || ''))?.[0] || (f.smtpHost.value ? 'other' : 'gmail');
  const p = EMAIL_PRESETS[preset], o = (name, cond) => `<details class="sect" data-name="${name}" ${open === name || (!open && cond) ? 'open' : ''}>`;
  const latest = st.backups && /(\d{4}-\d{2}-\d{2})/.exec(st.backups);
  showDrawer(`<div class="row"><h2>Admin settings</h2><button class="btn sm" data-act="close">Close</button></div>
  <p class="note">You run this Headcount, so these settings are yours. Changes take effect right away. Passwords and keys are locked away (encrypted) and never shown again after you save them.</p>
  ${o('address', !f.publicUrl.current)}<summary>Web address ${chip(f.publicUrl.current, 'Set', 'Not set')}</summary>
    <form class="form" data-sv="address">${field('publicUrl', 'The address people type to open Headcount', { wide: true, fallback: f.publicUrl.current || location.origin, ph: 'https://headcount.yourfirm.com' })}
    <p class="note wide">It goes in the links inside emails: invitations, password resets, digests and action pages.</p><div class="wide"><button class="btn primary">Save</button></div></form></details>
  ${o('email', !st.email)}<summary>Email ${chip(st.email, 'Working', 'Not set up')}</summary>
    <form class="form" data-sv="email">
      <p class="note wide">Headcount sends invitations, password resets, alerts and daily digests from an email account you choose.</p>
      <label class="wide">Which email do you use?<select id="sv_preset">${Object.entries(EMAIL_PRESETS).map(([k, x]) => `<option value="${k}" ${k === preset ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>
      <p class="note wide" id="sv_help">${helpHtml(p)}</p>
      ${field('smtpUser', p.user, { lid: 'sv_userLabel', fallback: f.smtpUser.value || p.userValue || '', ph: p.ph || '' })}${field('smtpPass', p.pass, { secret: true, lid: 'sv_passLabel' })}
      ${field('emailFrom', 'Name and address people see (optional)', { wide: true, ph: 'Capitol Strategies <headcount@yourfirm.com>' })}
      <details class="wide adv" id="sv_more" ${preset === 'other' ? 'open' : ''}><summary>More options</summary><div class="form">
        ${field('smtpHost', 'Outgoing mail server', { fallback: f.smtpHost.value || p.host, ph: 'smtp.yourprovider.com' })}${field('smtpPort', 'Port', { fallback: f.smtpPort.value || p.port })}</div></details>
      <input type="hidden" id="sv_smtpSecure" data-k="smtpSecure" value="${esc(f.smtpSecure.value || p.secure)}">
      <div class="wide btnrow"><button class="btn primary">Save</button><button type="button" class="btn" data-x="svTestEmail">Send me a test email</button></div>
      <p class="note wide" id="svMailMsg" role="status"></p></form></details>
  ${o('sources', !(cfg.bills && (cfg.bills.federal || cfg.bills.states)))}<summary>Bill and legislator data ${chip(cfg.bills && cfg.bills.federal && cfg.bills.states, 'Connected', 'Keys needed')}</summary>
    <form class="form" data-sv="sources">
      <p class="note wide">Headcount looks up bills, legislators and new rules from free public services. Some need a free key: follow the link to sign up, copy the key they give you, paste it here and click Test.</p>
      ${SOURCES.map(([k, id, name, what, link, how]) => `<div class="wide srcrow"><b>${esc(name)}</b> <span class="note">${esc(what)} <a href="${link}" target="_blank" rel="noopener">${esc(how)}</a></span>
        <div class="btnrow">${field(k, 'Key', { secret: true })}<button type="button" class="btn sm" data-x="svTest" data-src="${id}">Test</button></div><span class="note" id="svt_${id}"></span></div>`).join('')}
      <div class="wide srcrow"><b>No key needed</b> <span class="note">The Federal Register (new rules), USAspending.gov (contract awards) and the Census address lookup (for finding someone's legislators) work as they are.</span>
        <div class="btnrow">${[['fedreg', 'Federal Register'], ['usaspending', 'USAspending'], ['census', 'Census']].map(([id, n]) => `<button type="button" class="btn sm" data-x="svTest" data-src="${id}">Test ${n}</button>`).join('')}</div>
        ${['fedreg', 'usaspending', 'census'].map((id) => `<span class="note" id="svt_${id}"></span>`).join(' ')}</div>
      <div class="wide"><button class="btn primary">Save keys</button></div></form></details>
  ${o('ai', false)}<summary>AI writing help ${chip(st.ai, 'On', 'Off')}</summary>
    <form class="form" data-sv="ai"><p class="note wide">Claude, an AI assistant made by Anthropic, can draft bill briefs and sort what the Monitor finds by how much it matters to you. Anthropic charges for what it uses, usually a few cents a brief. To turn it on, make an account with Anthropic, add a payment method, create a key and paste it here. <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Get a key from Anthropic</a></p>
      ${field('anthropicKey', 'Anthropic key', { secret: true, wide: true })}<div class="wide"><button class="btn primary">Save</button></div></form></details>
  ${st.auth === 'local' ? `${o('signups', false)}<summary>Who can sign up</summary>
    <form class="form" data-sv="signups"><label class="wide check"><input type="radio" name="sv_signups" value="open" ${(f.signups.value || 'open') === 'open' ? 'checked' : ''}> Anyone can create an account. Choose this to sell Headcount.</label>
    <label class="wide check"><input type="radio" name="sv_signups" value="invite" ${f.signups.value === 'invite' ? 'checked' : ''}> Only people you invite. Choose this if Headcount is just for your own firm.</label>
    <div class="wide"><button class="btn primary">Save</button></div></form></details>` : ''}
  ${paymentsSection(f, st, o)}
  ${o('contact', false)}<summary>Your contact emails</summary>
    <form class="form" data-sv="contact">
      ${field('salesEmail', 'Where requests for a demo go', { ph: 'sales@yourfirm.com' })}${field('supportEmail', 'Where customers write for help', { ph: 'help@yourfirm.com' })}
      <p class="note wide">The help address appears in the app and in emails.</p><div class="wide"><button class="btn primary">Save</button></div></form></details>
  ${o('customers', false)}<summary>Customers</summary><div id="svCustomers"><p class="note">Opening this lists every workspace using your Headcount.</p></div></details>
  ${o('backups', false)}<summary>Backups</summary>
    <p class="note">Headcount saves a copy of everything once a day and keeps a week of copies${latest ? `; the latest is from ${esc(fmtDate(Date.parse(latest[1] + 'T12:00:00')))}` : ''}. You can also download a copy to keep somewhere safe.</p>
    <div class="btnrow"><button class="btn" data-x="svBackup">Download a backup now</button></div></details>`);
}
async function refreshSettings(r) {
  SET.data = { ...SET.data, fields: r.fields };
  CLOUD.config = await (await fetch('/api/config')).json();
  SET.data.status = (await CLOUD.api('GET', '/api/settings')).status;
}
async function connectStripe(form) {
  const msg = $('#payMsg'), btn = form.querySelector('button.primary');
  btn.disabled = true; msg.textContent = 'Setting up your plans in Stripe…'; SET.payOff = false;
  try {
    const r = await CLOUD.api('POST', '/api/settings/stripe', { key: $('#pay_key').value.trim(), team: $('#pay_team').value, firm: $('#pay_firm').value });
    await refreshSettings(r); drawSettings('billing'); render();
    const s = r.stripe, m = $('#payMsg');
    toast(s.live ? 'Payments are on' : 'Payments are on, in test mode');
    if (m && s.live && !s.chargesEnabled) m.innerHTML = '<span class="bad">Stripe still needs your business and bank details before it can take payments.</span> Finish them in your Stripe dashboard.';
  } catch (e) { btn.disabled = false; msg.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}
document.addEventListener('submit', (e) => { if (e.target.id !== 'svPayForm') return; e.preventDefault(); connectStripe(e.target); });
async function saveSection(form) {
  const patch = {};
  form.querySelectorAll('input[data-k]').forEach((i) => { if (i.disabled) return; if (i.dataset.secret && !i.value) return; patch[i.dataset.k] = i.value; });
  if (form.dataset.sv === 'signups') patch.signups = (form.querySelector('input[name=sv_signups]:checked') || {}).value || 'open';
  const btn = form.querySelector('button.primary'); btn.disabled = true;
  try {
    const r = await CLOUD.api('PUT', '/api/settings', patch);
    await refreshSettings(r);
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
  if (x === 'payOff') {
    if (!SET.payOff) { SET.payOff = true; t.textContent = 'Click again to turn off payments'; $('#payMsg').textContent = 'Customers who already pay keep being charged by Stripe until you cancel their subscriptions there. Everyone gets every feature for free while payments are off.'; return; }
    SET.payOff = false; t.disabled = true;
    try { const r = await CLOUD.api('DELETE', '/api/settings/stripe'); await refreshSettings(r); toast('Payments are off'); drawSettings('billing'); render(); } catch (err) { t.disabled = false; fail(err); }
    return;
  }
  if (x === 'svCustomersCsv') return csvDownload(`headcount-customers-${today()}.csv`, [['Workspace', 'Plan', 'People', 'Campaigns', 'Owner', 'Created', 'Paying'], ...(SET.customers || []).map((w) => [w.name, w.plan, w.people, w.campaigns, w.owner, new Date(w.created).toISOString().slice(0, 10), w.paying ? 'yes' : 'no'])]);
  if (x === 'svBackup') { try { await CLOUD.download('/api/settings/backup', `headcount-backup-${today()}.db`); toast('Backup downloaded'); } catch (err) { fail(err); } }
});
document.addEventListener('toggle', async (e) => {
  const box = e.target.querySelector && e.target.querySelector('#svCustomers');
  if (!box || !e.target.open || box.dataset.loaded) return;
  box.dataset.loaded = '1'; box.innerHTML = '<p class="note">Loading</p>';
  try {
    const r = await CLOUD.api('GET', '/api/settings/customers'), t = r.totals;
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    box.innerHTML = `<p class="note">${n(t.workspaces, 'workspace', 'workspaces')} · ${n(t.people, 'person', 'people')} · ${t.paying} paying · ${t.trials} on a trial</p>
      <div class="tablewrap"><table class="custtable"><thead><tr><th>Workspace</th><th>Plan</th><th class="num">People</th><th class="num">Campaigns</th></tr></thead><tbody>${r.workspaces.map((w) => `<tr><td><b>${esc(w.name)}</b><div class="meta">${esc(w.owner)} · since ${esc(fmtDate(w.created))}</div></td><td>${esc(w.plan)}${w.paying ? ' <span class="status ok">Paying</span>' : ''}${w.trialEnds ? `<div class="meta">trial ends ${esc(fmtDate(w.trialEnds))}</div>` : ''}</td><td class="num">${w.people}</td><td class="num">${w.campaigns}</td></tr>`).join('') || '<tr><td colspan="4" class="note">No workspaces yet.</td></tr>'}</tbody></table></div>
      <div class="btnrow"><button class="btn sm" data-x="svCustomersCsv">Download as a spreadsheet</button></div>`;
    SET.customers = r.workspaces;
  } catch (err) { box.innerHTML = `<p class="bad">${esc(err.message)}</p>`; }
}, true);
document.addEventListener('change', (e) => {
  if (e.target.id !== 'sv_preset') return;
  const p = EMAIL_PRESETS[e.target.value];
  $('#sv_smtpHost').value = p.host; $('#sv_smtpPort').value = p.port; $('#sv_smtpSecure').value = p.secure;
  if (p.userValue) $('#sv_smtpUser').value = p.userValue; else if ($('#sv_smtpUser').value === 'apikey') $('#sv_smtpUser').value = '';
  $('#sv_userLabel').textContent = p.user; $('#sv_passLabel').textContent = p.pass; $('#sv_smtpUser').placeholder = p.ph || '';
  $('#sv_more').open = e.target.value === 'other';
  $('#sv_help').innerHTML = helpHtml(p);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-sv]'); if (!f) return;
  e.preventDefault(); saveSection(f);
});
