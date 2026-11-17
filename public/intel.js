'use strict';
// Headcount, beyond the single campaign: the Monitor (bills, rules and contract
// notices), stakeholder contacts with bulk outreach, the grassroots action
// center, rosters for every state legislature, and lobbying intelligence.
// Shares globals with app.js; its own buttons use data-x.

const MON = { watches: null, sources: {}, items: null, view: 'new', kind: '', watch: '', q: '', loading: false, busy: '' };
const CRM = { contacts: null, q: '', tag: '', sel: new Set(), loading: false, members: null };
const ACT = { cid: null, data: null, loading: false };
const KIND_LABEL = { bill: 'Bills', reg: 'Regulations', contract: 'Contracts' };
const KIND_ONE = { bill: 'Bill', reg: 'Rule or notice', contract: 'Contract notice' };
const stateName = (c) => (c === 'US' ? 'Congress' : ((CLOUD.config && CLOUD.config.states) || {})[c] || c);
const wsPath = (p) => `/api/workspaces/${encodeURIComponent(ORG.id)}${p}`;
const plural2 = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? u : '');
const teamMember = () => signedIn() && ORG && ORG.role !== 'guest';

// ---------- Monitor ----------
async function loadMonitor() {
  if (!teamMember() || MON.loading) return;
  MON.loading = true;
  try {
    const r = await CLOUD.api('GET', wsPath('/watches'));
    MON.watches = r.watches; MON.sources = r.sources; MON.org = ORG.id;
    await loadItems(true);
  } catch (e) { fail(e); MON.watches = MON.watches || []; }
  finally { MON.loading = false; }
  if (page === 'monitor') renderMonitor();
}
async function loadItems(quiet) {
  const q = new URLSearchParams({ view: MON.view }); if (MON.kind) q.set('kind', MON.kind); if (MON.watch) q.set('watch', MON.watch); if (MON.q.trim()) q.set('q', MON.q.trim());
  try { MON.items = (await CLOUD.api('GET', wsPath(`/items?${q}`))).items; } catch (e) { fail(e); MON.items = MON.items || []; }
  if (!quiet && page === 'monitor') renderMonitor();
}
function watchScope(w) {
  if (w.kind === 'bill') return w.states.includes('ALL') ? 'Congress and every state' : w.states.map(stateName).join(', ');
  if (w.kind === 'reg') return `Federal Register${w.agency ? `: ${w.agency}` : ''}`;
  return `SAM.gov${w.naics ? `, NAICS ${w.naics}` : ''}`;
}
function itemHtml(i) {
  const where = i.kind === 'bill' ? stateName(i.juris) : i.agency;
  const due = i.deadline ? dayDiff(i.deadline) : null;
  const dueTxt = i.deadline ? `${i.kind === 'reg' ? 'Comments due' : 'Responses due'} ${fmtDay(i.deadline)}${due >= 0 ? ` (${inDays(i.deadline)})` : ' (closed)'}` : '';
  const score = typeof i.score === 'number' ? `<span class="score ${i.score >= 70 ? 'hi' : i.score >= 40 ? 'mid' : 'lo'}" title="Relevance to your priorities">${i.score}</span>` : '';
  const camp = i.campaignId && ACCOUNT.list.find((c) => c.id === i.campaignId);
  const acts = [
    i.state !== 'tracked' ? `<button class="btn sm" data-x="itemState" data-id="${i.id}" data-state="tracked">Track</button>` : `<button class="btn sm" data-x="itemState" data-id="${i.id}" data-state="new">Stop tracking</button>`,
    i.state !== 'dismissed' ? `<button class="btn sm" data-x="itemState" data-id="${i.id}" data-state="dismissed">Dismiss</button>` : `<button class="btn sm" data-x="itemState" data-id="${i.id}" data-state="new">Restore</button>`,
    i.kind === 'bill' && !camp ? `<button class="btn sm primary" data-x="itemCampaign" data-id="${i.id}">Start a campaign</button>` : '',
    camp ? `<button class="btn sm" data-opencamp="${esc(camp.id)}">Open campaign</button>` : '',
    i.kind === 'bill' && i.juris === 'US' ? `<button class="btn sm" data-x="lobbying" data-number="${esc(i.number)}" data-title="${esc(i.title)}">Who's lobbying on it</button>` : '',
    i.kind === 'contract' ? `<button class="btn sm" data-x="incumbents" data-agency="${esc((i.extra && i.extra.agencyTop) || '')}" data-naics="${esc((i.extra && i.extra.naics) || '')}">Who wins this work</button>` : '',
  ].filter(Boolean).join('');
  return `<li class="item">
    <div class="itop">${score}<span class="kindtag k-${i.kind}">${esc(KIND_ONE[i.kind])}</span>${where ? `<span class="meta">${esc(where)}</span>` : ''}${i.docType && i.kind !== 'bill' ? `<span class="meta">${esc(i.docType)}</span>` : ''}${i.state === 'tracked' ? '<span class="status ok">Tracking</span>' : ''}</div>
    <h3>${safeUrl(i.url) ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc([i.number, i.title].filter(Boolean).join(': '))}</a>` : esc([i.number, i.title].filter(Boolean).join(': '))}</h3>
    ${i.reason ? `<p class="why">${esc(i.reason)}</p>` : ''}
    ${i.summary && i.kind === 'reg' ? `<p class="meta">${esc(i.summary.slice(0, 300))}${i.summary.length > 300 ? '…' : ''}</p>` : ''}
    <div class="meta">${[i.status && (i.prevStatus && i.changedAt ? `Moved: ${esc(i.prevStatus)} → <b>${esc(i.status)}</b>` : `Latest: ${esc(i.status)}${i.statusDate ? ` (${esc(fmtDay(i.statusDate))})` : ''}`), dueTxt && `<span class="${due !== null && due >= 0 && due <= 7 ? 'bad' : ''}">${esc(dueTxt)}</span>`, i.date && `Updated ${esc(fmtDay(i.date))}`, i.source && esc(i.source)].filter(Boolean).join(' · ')}</div>
    <div class="btnrow">${acts}</div></li>`;
}
// Redraws keep keyboard focus on the same control, including custom dropdowns
// (their buttons are created again for the new selects).
function keepFocus(el, draw) {
  const a = document.activeElement, id = a && el.contains(a) ? a.id : null;
  draw();
  if (window.CustomSelect) el.querySelectorAll('select').forEach(CustomSelect.enhance);
  const f = id && document.getElementById(id);
  if (f && f !== document.activeElement) f.focus();
}
function renderMonitor() { keepFocus($('#monitorPage'), drawMonitor); }
function drawMonitor() {
  const el = $('#monitorPage');
  if (!teamMember()) { el.innerHTML = '<div class="panel empty">The Monitor is for workspace members. Sign in and join a workspace to use it.</div>'; return; }
  if (MON.org && MON.org !== ORG.id) { MON.watches = null; MON.items = null; MON.watch = ''; }
  if (MON.watches === null) { el.innerHTML = '<div class="panel empty">Loading the Monitor</div>'; loadMonitor(); return; }
  const src = MON.sources || {}, off = [!src.federal && 'Congress (CONGRESS_API_KEY)', !src.states && 'state legislatures (OPENSTATES_API_KEY)', !src.contracts && 'SAM.gov contracts (SAM_API_KEY)'].filter(Boolean);
  const watches = MON.watches.map((w) => `<li class="witem${MON.watch === w.id ? ' on' : ''}">
      <div class="itop"><button class="linkbtn wname" data-x="pickWatch" data-id="${esc(w.id)}">${esc(w.name)}</button>${w.fresh ? `<span class="status wait">${w.fresh} new</span>` : ''}${w.paused ? '<span class="status">Paused</span>' : ''}</div>
      <div class="meta">${esc(KIND_LABEL[w.kind])} · ${esc(watchScope(w))}${w.client ? ` · ${esc(w.client)}` : ''}</div>
      <div class="meta">“${esc(w.query)}” · ${w.lastRun ? `checked ${esc(fmtWhen(new Date(w.lastRun).toISOString()))}` : 'not checked yet'}${w.tracked ? ` · ${w.tracked} tracked` : ''}</div>
      ${w.lastError ? `<div class="meta bad">${esc(w.lastError)}</div>` : ''}
      <div class="btnrow"><button class="btn sm" data-x="runWatch" data-id="${esc(w.id)}" ${MON.busy === w.id ? 'disabled' : ''}>${MON.busy === w.id ? 'Checking' : 'Check now'}</button><button class="btn sm" data-x="editWatch" data-id="${esc(w.id)}">Edit</button></div></li>`).join('');
  const items = MON.items || [];
  const counts = MON.watches.reduce((a, w) => a + w.fresh, 0);
  el.innerHTML = `<div class="mgrid">
    <div class="panel">
      <div class="row"><span class="label">Watches</span><button class="btn sm primary" data-x="newWatch">New watch</button></div>
      ${MON.watches.length ? `<ul class="wlist">${MON.watch ? '<li><button class="linkbtn" data-x="pickWatch" data-id="">Show every watch</button></li>' : ''}${watches}</ul>` : `<p class="note" style="margin-top:12px">A watch searches new and updated bills in Congress and every state legislature, proposed and final rules in the Federal Register, and federal contract opportunities on SAM.gov. Headcount checks each watch every few hours, scores what it finds against your priorities${src.ai ? ' with Claude' : ''}, and tells you about what matters.</p><div class="btnrow"><button class="btn primary" data-x="newWatch">Create your first watch</button></div>`}
      ${off.length ? `<p class="note" style="margin-top:12px">Not set up on this server: ${esc(off.join(', '))}.</p>` : ''}
    </div>
    <div class="panel">
      <div class="row"><div class="seg" role="group" aria-label="Show">${[['new', `Inbox${counts ? ` (${counts})` : ''}`], ['tracked', 'Tracking'], ['all', 'Everything'], ['dismissed', 'Dismissed']].map(([k, l]) => `<button data-x="monView" data-v="${k}" aria-pressed="${MON.view === k}">${esc(l)}</button>`).join('')}</div>
      <select id="mon_kind" aria-label="Kind"><option value="">Bills, rules and contracts</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}" ${MON.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="filters"><input type="search" id="mon_q" placeholder="Search titles, numbers and agencies" value="${esc(MON.q)}" aria-label="Search the Monitor"></div>
      ${items.length ? `<ul class="items">${items.map(itemHtml).join('')}</ul>` : `<p class="note" style="margin-top:12px">${MON.watches.length ? (MON.view === 'new' ? 'Nothing new. Headcount checks your watches every few hours.' : MON.view === 'tracked' ? 'Track a bill, rule or contract to follow it here and hear when it moves.' : 'Nothing here.') : 'Create a watch to start.'}</p>`}
    </div></div>`;
}
function watchDrawer(w) {
  const src = MON.sources || {}, st = (CLOUD.config && CLOUD.config.states) || {}, kind = w ? w.kind : 'bill';
  const states = w ? w.states : ['US'];
  showDrawer(`<div class="row"><h2>${w ? 'Edit watch' : 'New watch'}</h2><button class="btn sm" data-act="close">Close</button></div>
  <form id="mwForm" class="form" data-id="${w ? esc(w.id) : ''}">
    <label class="wide">Watch for<select id="mw_kind" name="kind" ${w ? 'disabled' : ''}>${Object.entries({ bill: 'Bills in Congress and state legislatures', reg: 'Federal rules and notices (Federal Register)', contract: 'Federal contract opportunities (SAM.gov)' }).map(([k, l]) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="wide">Search terms, separated by commas<input id="mw_query" name="query" value="${esc(w ? w.query : '')}" placeholder="rural broadband, digital equity" required></label>
    <label class="wide">What matters to you (Headcount ranks results by this)<textarea id="mw_pri" name="priorities" rows="3" placeholder="Grants and permitting rules for rural electric co-ops building broadband">${esc(w ? w.priorities : '')}</textarea></label>
    <fieldset class="wide mwf" data-for="bill" ${kind === 'bill' ? '' : 'hidden'}><legend class="note">Where</legend>
      <label class="check"><input type="checkbox" id="mw_us" ${states.includes('US') ? 'checked' : ''}> U.S. Congress${src.federal ? '' : ' (not set up on this server)'}</label>
      <label class="check"><input type="checkbox" id="mw_all" ${states.includes('ALL') ? 'checked' : ''}> Every state legislature${src.states ? '' : ' (not set up on this server)'}</label>
      <label>Or these states<input id="mw_states" value="${esc(states.filter((s) => st[s]).join(', '))}" placeholder="FL, GA, TX" list="mw_stlist"></label>
      <datalist id="mw_stlist">${Object.entries(st).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</datalist>
    </fieldset>
    <label class="mwf" data-for="reg" ${kind === 'reg' ? '' : 'hidden'}>Agency (optional)<input id="mw_agency" value="${esc(w ? w.agency : '')}" placeholder="Federal Communications Commission"></label>
    <label class="mwf" data-for="contract" ${kind === 'contract' ? '' : 'hidden'}>NAICS code (optional)<input id="mw_naics" value="${esc(w ? w.naics : '')}" inputmode="numeric" placeholder="517111"></label>
    <label>Client<select id="mw_client"><option value="">No client</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}" ${w && w.clientId === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
    <label>Name<input id="mw_name" value="${esc(w ? w.name : '')}" placeholder="Taken from the first search term"></label>
    ${w ? `<label class="check wide"><input type="checkbox" id="mw_paused" ${w.paused ? 'checked' : ''}> Pause this watch</label>` : ''}
    <div class="wide btnrow"><button class="btn primary" id="mwGo">${w ? 'Save' : 'Create and check now'}</button>${w ? `<button type="button" class="btn warn" data-x="delWatch" data-id="${esc(w.id)}">Delete watch</button>` : ''}</div>
    <p class="note wide" id="mwMsg" role="status"></p>
  </form>`);
}
async function saveWatch(form) {
  const id = form.dataset.id, kind = $('#mw_kind').value;
  const states = [...($('#mw_us').checked ? ['US'] : []), ...($('#mw_all').checked ? ['ALL'] : []), ...$('#mw_states').value.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)];
  const body = { kind, query: $('#mw_query').value, priorities: $('#mw_pri').value, states, agency: $('#mw_agency').value, naics: $('#mw_naics').value, clientId: $('#mw_client').value, name: $('#mw_name').value };
  if (id) body.paused = $('#mw_paused').checked;
  $('#mwGo').disabled = true; $('#mwMsg').textContent = id ? 'Saving' : 'Creating the watch and checking the sources. This can take a few seconds.';
  try {
    const w = id ? await CLOUD.api('PATCH', wsPath(`/watches/${id}`), body) : await CLOUD.api('POST', wsPath('/watches'), body);
    closeDrawer(); MON.watch = ''; MON.view = 'new';
    toast(id ? 'Watch saved' : w.total ? `${plural2(w.fresh, 'new item')} found` : 'Watch created. Nothing new yet; Headcount keeps checking.');
    MON.watches = null; renderMonitor();
  } catch (e) { $('#mwGo').disabled = false; $('#mwMsg').textContent = e.message; if (e.upgrade) fail(e); }
}
async function campaignFromItem(it) {
  const w = MON.watches.find((x) => x.id === it.watchId) || {};
  const st = blankState(`${it.number}: ${it.title}`.slice(0, 140));
  st.campaign.clientId = w.clientId || ''; st.campaign.chamber = it.juris === 'US' ? 'U.S. Congress' : `${stateName(it.juris)} Legislature`;
  st.brief = Object.assign(blankBrief(), { number: it.number, title: it.title, jurisdiction: it.juris === 'US' ? 'U.S. Congress' : `${stateName(it.juris)} Legislature`, session: it.session || '', status: it.status || '', url: it.url || '', source: it.source || '' });
  page = 'count'; await addCampaign(st);
  try { await CLOUD.api('PATCH', wsPath(`/items/${it.id}`), { state: 'tracked', campaignId: st.id }); } catch (_) { /* the campaign exists either way */ }
  MON.items = null; toast('Campaign created. Load the chamber in Setup, then mark where members stand.');
}

// ---------- intelligence ----------
async function lobbyingDrawer(number, title) {
  showDrawer(`<div class="row"><h2>Who's lobbying on ${esc(number)}</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">Checking federal lobbying disclosures.</p>`);
  try {
    const r = await CLOUD.api('GET', `/api/intel/lobbying?number=${encodeURIComponent(number)}&title=${encodeURIComponent(title || '')}`);
    showDrawer(`<div class="row"><h2>Who's lobbying on ${esc(r.bill)}</h2><button class="btn sm" data-act="close">Close</button></div>
      <p class="note">From LDA.gov disclosure filings for ${r.years.join(' and ')} that name this bill. Amounts are the income or expenses reported on each filing, which often covers other issues too.</p>
      ${r.clients.length ? `<span class="label">Clients and organizations</span><div class="tablewrap"><table><thead><tr><th>Client</th><th>Lobbying firm</th><th>Reported</th><th>Filings</th></tr></thead><tbody>${r.clients.map((c) => `<tr><td>${esc(c.client)}</td><td class="meta">${esc(c.registrants.join(', '))}</td><td class="num">${c.amount ? money(c.amount) : ''}</td><td class="num">${c.filings}</td></tr>`).join('')}</tbody></table></div>
      <span class="label">Filings</span><ul class="moves">${r.filings.map((f) => `<li><b>${esc(f.client)}</b> via ${esc(f.registrant)}, ${esc(f.period)}${f.amount ? `, ${money(f.amount)}` : ''}<div class="meta">${esc(f.issue)}${f.entities.length ? ` · Lobbied: ${esc(f.entities.join(', '))}` : ''}${safeUrl(f.url) ? ` · <a href="${esc(f.url)}" target="_blank" rel="noopener">Filing</a>` : ''}</div></li>`).join('')}</ul>`
      : '<p>No disclosure filings name this bill yet. Filings are due 20 days after each quarter, so recent activity may not show.</p>'}`);
  } catch (e) { showDrawer(`<div class="row"><h2>Who's lobbying on ${esc(number)}</h2><button class="btn sm" data-act="close">Close</button></div><p class="bad">${esc(e.message)}</p>`); }
}
async function incumbentsDrawer(agency, naics) {
  showDrawer(`<div class="row"><h2>Who wins this work</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">Checking federal award history.</p>`);
  try {
    const r = await CLOUD.api('GET', `/api/intel/incumbents?agency=${encodeURIComponent(agency || '')}&naics=${encodeURIComponent(naics || '')}`);
    const top = r.recipients[0];
    showDrawer(`<div class="row"><h2>Who wins this work</h2><button class="btn sm" data-act="close">Close</button></div>
      <p class="note">${esc(r.scope)}. Contract obligations from USAspending.gov.</p>
      ${r.recipients.length ? `<p>${top.share >= 0.5 ? `${esc(top.name)} holds ${Math.round(top.share * 100)}% of this work: an entrenched incumbent, so teaming may beat competing head-on.` : top.share >= 0.3 ? `${esc(top.name)} leads at ${Math.round(top.share * 100)}%, but the work is spread across several companies.` : 'The work is spread across many companies, with no dominant incumbent.'}</p>
      <ul class="bars">${r.recipients.map((x) => `<li><span>${esc(x.name)}</span><span class="bar"><i style="width:${Math.max(2, Math.round(x.share * 100))}%"></i></span><span class="num">${money(x.amount)}</span></li>`).join('')}</ul>` : '<p>No award history found for this combination.</p>'}`);
  } catch (e) { showDrawer(`<div class="row"><h2>Who wins this work</h2><button class="btn sm" data-act="close">Close</button></div><p class="bad">${esc(e.message)}</p>`); }
}
function intelBriefButtons(b) {
  if (!signedIn() || !b || !b.number || !/congress/i.test(`${b.jurisdiction} ${b.source}`) || !/^\s*(H|S)/i.test(b.number)) return '';
  return `<button class="btn" data-x="lobbying" data-number="${esc(b.number)}" data-title="${esc(b.title)}">Who's lobbying on it</button>`;
}

// ---------- rosters for every legislature ----------
function rosterLoaderHtml() {
  const cfg = CLOUD.config || {};
  if (!cfg.rosters || !signedIn()) return '';
  return `<details><summary class="note">Load any state legislature, with emails and offices</summary>
    <div class="btnrow"><select id="os_state" aria-label="State">${Object.entries(cfg.states || {}).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    <select id="os_chamber" aria-label="Chamber"><option value="upper">Senate</option><option value="lower">House or Assembly</option><option value="legislature">Nebraska Legislature</option></select>
    <button class="btn" data-x="osRoster">Get the roster</button></div><p class="note" id="osMsg" role="status">Current members from Open States.</p></details>`;
}
async function fetchRoster(btn) {
  const msg = $('#osMsg'); btn.disabled = true; msg.textContent = 'Getting the current members';
  try {
    const r = await CLOUD.api('GET', `/api/rosters/state?state=${$('#os_state').value}&chamber=${$('#os_chamber').value}`);
    if (!ROSTERS) ROSTERS = {};
    ROSTERS[r.key] = r; r.members.forEach((m) => { DIR[m.k] = m; });
    const sel = $('#s_preset');
    if (sel) { if (![...sel.options].some((o) => o.value === r.key)) sel.add(new Option(`${r.label} (${r.members.length})`, r.key)); sel.value = r.key; presetNote(); }
    msg.textContent = `${r.members.length} members found. Choose starting positions above, then load.`;
  } catch (e) { msg.textContent = e.message; }
  finally { btn.disabled = false; }
}

// ---------- action center ----------
function actCount(m) {
  if (!S.cloud || !signedIn()) return '';
  if (ACT.cid !== S.id) { ACT.cid = S.id; ACT.data = null; loadAction(true); return ''; }
  const n = ACT.data && ACT.data.stats ? ACT.data.stats.byMember[m.id] || 0 : 0;
  return n ? ` · ${plural2(n, 'constituent letter')}` : '';
}
async function loadAction(rerender) {
  const cid = S.id;
  try { const d = await CLOUD.api('GET', `/api/campaigns/${encodeURIComponent(cid)}/action`); if (cid === S.id) ACT.data = d; }
  catch (_) { if (cid === S.id) ACT.data = { action: null }; }
  if (rerender && cid === S.id && page === 'count' && ACT.data && ACT.data.stats && ACT.data.stats.responses) renderRows();
}
function guessJuris() {
  if (S.campaign.juris) return S.campaign.juris;
  const ch = S.campaign.chamber || '', dist = S.members.map((m) => String(m.district));
  if (/u\.?s\.? senate/i.test(ch)) return { level: 'us', chamber: 'upper' };
  if (/u\.?s\.? house|house of representatives/i.test(ch) && dist.some((d) => /^[A-Z]{2}-/.test(d))) return { level: 'us', chamber: 'lower' };
  return null;
}
function defaultLetter() {
  const c = S.campaign, b = S.brief, side = c.side === 'defeat' ? 'oppose' : 'support';
  return `As your constituent, I am writing to ask you to ${side} ${b.number || c.bill || 'this bill'}${b.title ? ` (${b.title})` : ''}.\n\n${b.plainSummary ? `${b.plainSummary.split(/(?<=\.)\s/).slice(0, 2).join(' ')}\n\n` : ''}${c.ask ? `${c.ask}.\n\n` : ''}This matters to me and to our community. Please let me know where you stand.\n\nThank you for your service.`;
}
async function actionDrawer() {
  if (!signedIn()) return showDrawer('<div class="row"><h2>Action center</h2><button class="btn sm" data-act="close">Close</button></div><p>Sign in to give this campaign a public action page where supporters write to their own legislators.</p>');
  if (!S.cloud) return showDrawer('<div class="row"><h2>Action center</h2><button class="btn sm" data-act="close">Close</button></div><p>Save this campaign to your workspace first: change anything in it and it is saved.</p>');
  showDrawer('<div class="row"><h2>Action center</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">Loading</p>');
  ACT.cid = S.id; await loadAction(false);
  const d = ACT.data || {}, a = d.action, stats = d.stats || { responses: 0, byMember: {} }, ro = !canEditNow(), j = (a && a.juris) || guessJuris();
  const top = Object.entries(stats.byMember || {}).map(([id, n]) => [S.members.find((m) => m.id === id), n]).filter((x) => x[0]).sort((x, y) => y[1] - x[1]).slice(0, 8);
  const st = (CLOUD.config && CLOUD.config.states) || {};
  const jv = j ? (j.level === 'us' ? `us-${j.chamber}` : `st-${j.chamber}`) : '';
  showDrawer(`<div class="row"><h2>Action center</h2><button class="btn sm" data-act="close">Close</button></div>
  <p class="note">A public page where supporters enter their address, see which of this campaign's legislators represent them, and send a letter to the office${CLOUD.config && CLOUD.config.email ? ' by email where the office publishes one' : ''}, or call. Each letter counts toward that member in your whip count.</p>
  ${a ? `<div class="panel"><span class="label">${a.active ? 'Live' : 'Turned off'}</span><p style="margin:6px 0"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a> ${copyBtn(a.url)}</p>
    <p class="note">${plural2(stats.responses, 'supporter')} took action${stats.optin ? `, ${stats.optin} asked for updates` : ''}.${stats.last ? ` Latest ${esc(fmtDate(stats.last))}.` : ''}</p>
    ${top.length ? `<ul class="moves">${top.map(([m, n]) => `<li>${esc(m.name)} <span class="meta">${esc(m.party)}-${esc(m.district)}</span>: ${plural2(n, 'letter')}</li>`).join('')}</ul>` : ''}
    ${stats.responses && !ro ? '<div class="btnrow"><button class="btn sm" data-x="actCsv">Download responses (CSV)</button></div>' : ''}</div>` : ''}
  ${ro ? '' : `<form id="acForm" class="form">
    <label class="wide">Page title<input id="ac_title" value="${esc(a ? a.title : `Tell your legislators: ${S.campaign.side === 'defeat' ? 'stop' : 'pass'} ${S.brief.number || S.campaign.bill}`)}"></label>
    <label class="wide">Why it matters (shown at the top)<textarea id="ac_intro" rows="3">${esc(a ? a.intro : S.brief.plainSummary || '')}</textarea></label>
    <label class="wide">Email subject<input id="ac_subject" value="${esc(a ? a.subject : `Please ${S.campaign.side === 'defeat' ? 'oppose' : 'support'} ${S.brief.number || S.campaign.bill}`)}"></label>
    <label class="wide">The letter (supporters can edit it)<textarea id="ac_letter" rows="9">${esc(a ? a.letter : defaultLetter())}</textarea></label>
    <label class="wide">Call script<textarea id="ac_call" rows="2">${esc(a ? a.callScript : `Say you are a constituent, give your address, and ask the ${honorific() || 'legislator'} to ${S.campaign.side === 'defeat' ? 'vote no on' : 'vote yes on'} ${S.brief.number || S.campaign.bill}.`)}</textarea></label>
    <label>Who supporters can write to<select id="ac_targets"><option value="all">Every member in the count</option><option value="cmte">Committee members</option><option value="swing">Undecided and leaning members</option></select></label>
    <label>These legislators are<select id="ac_juris"><option value="">Choose</option><option value="us-lower" ${jv === 'us-lower' ? 'selected' : ''}>U.S. House</option><option value="us-upper" ${jv === 'us-upper' ? 'selected' : ''}>U.S. Senate</option><option value="st-upper" ${jv === 'st-upper' ? 'selected' : ''}>A state senate</option><option value="st-lower" ${jv === 'st-lower' ? 'selected' : ''}>A state house or assembly</option></select></label>
    <label>State, for a legislature<select id="ac_state"><option value="">Choose</option>${Object.entries(st).map(([k, v]) => `<option value="${k}" ${j && j.state === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="ac_active" ${!a || a.active ? 'checked' : ''}> Page is live</label>
    <div class="wide btnrow"><button class="btn primary" id="acGo">${a ? 'Save changes' : 'Publish the page'}</button></div>
    <p class="note wide" id="acMsg" role="status">Supporters' districts come from the U.S. Census address lookup and are matched to each member's district number in this count.</p>
  </form>`}`);
}
async function saveAction() {
  const pick = $('#ac_targets').value, jv = $('#ac_juris').value;
  const list = S.members.filter((m) => (pick === 'cmte' ? m.cmte : pick === 'swing' ? m.pos >= 1 && m.pos <= 3 : true));
  const targets = list.map((m) => { const c = contact(m); return { id: m.id, name: m.name, party: m.party, district: m.district, email: c.email, phone: c.phone || c.dphone, form: c.form, title: honorific() }; });
  const juris = jv ? { level: jv.startsWith('us') ? 'us' : 'state', chamber: jv.endsWith('upper') ? 'upper' : 'lower', state: $('#ac_state').value } : null;
  if (juris && juris.level === 'state' && !juris.state) { $('#acMsg').textContent = 'Choose the state.'; return; }
  if (!juris) { $('#acMsg').textContent = 'Choose which chamber these legislators sit in, so supporters can be matched to them.'; return; }
  $('#acGo').disabled = true;
  try {
    ACT.data = await CLOUD.api('PUT', `/api/campaigns/${encodeURIComponent(S.id)}/action`, { title: $('#ac_title').value, intro: $('#ac_intro').value, subject: $('#ac_subject').value, letter: $('#ac_letter').value, callScript: $('#ac_call').value, active: $('#ac_active').checked, targets, juris });
    if (!S.campaign.juris) { S.campaign.juris = juris; save(); }
    toast(ACT.data.action.active ? 'The action page is live' : 'Saved; the page is turned off'); actionDrawer();
  } catch (e) { $('#acGo').disabled = false; $('#acMsg').textContent = e.message; if (e.upgrade) fail(e); }
}
async function actionCsv() {
  try {
    const r = await CLOUD.api('GET', `/api/campaigns/${encodeURIComponent(S.id)}/action/responses`);
    csvDownload(`action-responses-${today()}.csv`, [['Date', 'Name', 'Email (if they asked for updates)', 'Address', 'Wrote to', 'Emailed', 'Edited the letter'], ...r.responses.map((x) => [new Date(x.at).toISOString().slice(0, 10), x.name, x.email, x.address, x.members.join('; '), x.emailed, x.edited ? 'yes' : 'no'])]);
  } catch (e) { fail(e); }
}

// ---------- contacts ----------
async function loadContacts() {
  if (!teamMember() || CRM.loading) return;
  CRM.loading = true;
  try { CRM.contacts = (await CLOUD.api('GET', wsPath('/contacts'))).contacts; CRM.org = ORG.id; if (!CRM.members) CRM.members = (await CLOUD.api('GET', wsPath('/members'))).members; }
  catch (e) { fail(e); CRM.contacts = CRM.contacts || []; }
  finally { CRM.loading = false; }
  if (page === 'contacts') renderContacts();
}
const personName = (id) => { const p = (CRM.members || []).find((x) => x.id === id); return p ? (p.id === ME ? 'You' : p.name || p.email) : ''; };
function shownContacts() {
  const q = CRM.q.trim().toLowerCase();
  return (CRM.contacts || []).filter((c) => (!CRM.tag || c.tags.includes(CRM.tag)) && (!q || `${c.name} ${c.title} ${c.organization} ${c.email} ${c.tags.join(' ')}`.toLowerCase().includes(q)));
}
function renderContacts() { keepFocus($('#contactsPage'), drawContacts); }
function drawContacts() {
  const el = $('#contactsPage');
  if (!teamMember()) { el.innerHTML = '<div class="panel empty">Contacts are for workspace members. Sign in and join a workspace to use them.</div>'; return; }
  if (CRM.org && CRM.org !== ORG.id) { CRM.contacts = null; CRM.members = null; CRM.sel.clear(); }
  if (CRM.contacts === null) { el.innerHTML = '<div class="panel empty">Loading contacts</div>'; loadContacts(); return; }
  const tags = [...new Set(CRM.contacts.flatMap((c) => c.tags))].sort(), list = shownContacts();
  const sel = [...CRM.sel].filter((id) => CRM.contacts.some((c) => c.id === id));
  el.innerHTML = `<div class="panel">
    <div class="row"><span class="label">Stakeholders in ${esc(ORG.name)}</span><div class="btnrow"><button class="btn sm primary" data-x="newContact">Add contact</button><button class="btn sm" data-x="importContacts">Import</button><button class="btn sm" data-x="exportContacts">Export</button></div></div>
    <p class="note">Agency staff, coalition partners, client contacts, reporters: everyone besides the legislators in a campaign. Log calls, meetings and emails so the whole team sees the relationship.</p>
    <div class="filters"><input type="search" id="ct_q" placeholder="Search names, organizations, tags" value="${esc(CRM.q)}" aria-label="Search contacts">
      <select id="ct_tag" aria-label="Tag"><option value="">All tags</option>${tags.map((t) => `<option value="${esc(t)}" ${CRM.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
    ${sel.length ? `<div class="btnrow selbar"><span class="note">${sel.length} selected</span><button class="btn sm primary" data-x="bulkMail">Email them from my inbox</button><button class="btn sm" data-x="bulkLog">Log an interaction</button><button class="btn sm" data-x="clearSel">Clear</button></div>` : ''}
    <div class="tablewrap" style="max-height:none"><table class="ctable"><thead><tr><th><input type="checkbox" id="ct_all" aria-label="Select all shown" ${list.length && list.every((c) => CRM.sel.has(c.id)) ? 'checked' : ''}></th><th>Name</th><th>Organization</th><th>Email</th><th>Tags</th><th>Owner</th><th>Last touch</th></tr></thead>
    <tbody>${list.length ? list.map((c) => `<tr><td><input type="checkbox" class="ct-sel" data-id="${esc(c.id)}" ${CRM.sel.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(c.name)}"></td>
      <td><button class="who" data-x="openContact" data-id="${esc(c.id)}">${esc(c.name)}</button>${c.title ? `<div class="meta">${esc(c.title)}</div>` : ''}</td><td>${esc(c.organization)}</td><td class="meta">${esc(c.email)}</td>
      <td>${c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</td><td class="meta">${esc(personName(c.ownerId))}</td><td class="meta">${c.lastTouch ? esc(fmtDay(c.lastTouch)) : 'Never'}</td></tr>`).join('')
      : `<tr><td colspan="7" class="note">${CRM.contacts.length ? 'No contacts match.' : 'No contacts yet. Add them one at a time, or import a spreadsheet.'}</td></tr>`}</tbody></table></div></div>`;
}
function contactForm(c) {
  return `<form id="ctForm" class="form" data-id="${c ? esc(c.id) : ''}">
    <label>Name<input id="ct_name" value="${esc(c ? c.name : '')}" required></label>
    <label>Title<input id="ct_title" value="${esc(c ? c.title : '')}"></label>
    <label>Organization<input id="ct_org" value="${esc(c ? c.organization : '')}"></label>
    <label>Email<input id="ct_email" type="email" value="${esc(c ? c.email : '')}"></label>
    <label>Phone<input id="ct_phone" value="${esc(c ? c.phone : '')}"></label>
    <label>Tags, separated by commas<input id="ct_tags" value="${esc(c ? c.tags.join(', ') : '')}" placeholder="agency, broadband"></label>
    <label>Owner<select id="ct_owner">${(CRM.members || []).filter((p) => p.role !== 'guest').map((p) => `<option value="${esc(p.id)}" ${(c ? c.ownerId : ME) === p.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('')}</select></label>
    <label>Client<select id="ct_client"><option value="">None</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}" ${c && c.clientId === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
    <label class="wide">Notes<textarea id="ct_notes" rows="3">${esc(c ? c.notes : '')}</textarea></label>
    <div class="wide btnrow"><button class="btn primary">${c ? 'Save' : 'Add contact'}</button>${c ? `<button type="button" class="btn warn" data-x="delContact" data-id="${esc(c.id)}">Delete</button>` : ''}</div>
    <p class="note wide" id="ctMsg" role="status"></p></form>`;
}
const campaignOptions = () => `<option value="">No campaign</option>${ACCOUNT.list.filter((c) => !c.archived).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}`;
function logForm(ids) {
  return `<form id="ciForm" class="form" data-ids="${esc(ids.join(','))}">
    <label>Type<select id="ci_type">${['Meeting', 'Call', 'Email', 'Event', 'Note'].map((t) => `<option>${t}</option>`).join('')}</select></label>
    <label>Date<input type="date" id="ci_day" value="${today()}"></label>
    <label class="wide">Campaign<select id="ci_camp">${campaignOptions()}</select></label>
    <label class="wide">What happened<textarea id="ci_note" rows="3" required></textarea></label>
    <div class="wide"><button class="btn primary">Log it</button></div></form>`;
}
async function contactDrawer(id) {
  const c = CRM.contacts.find((x) => x.id === id); if (!c) return;
  showDrawer(`<div class="row"><h2>${esc(c.name)}</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">${esc([c.title, c.organization].filter(Boolean).join(', '))}</p>
    <details class="sect" open><summary>Log an interaction</summary>${logForm([c.id])}</details>
    <details class="sect" open><summary>History</summary><ul class="moves" id="ctTimeline"><li class="note">Loading</li></ul></details>
    <details class="sect"><summary>Details</summary>${contactForm(c)}</details>`);
  try {
    const t = (await CLOUD.api('GET', wsPath(`/contacts/${id}/interactions`))).interactions;
    const camp = (cid) => (ACCOUNT.list.find((x) => x.id === cid) || {}).name;
    $('#ctTimeline').innerHTML = t.length ? t.map((i) => `<li><span class="when">${esc(fmtDay(i.day))}</span> · <b>${esc(i.type)}</b>${i.by ? ` by ${esc(i.by)}` : ''}${camp(i.campaignId) ? ` · ${esc(camp(i.campaignId))}` : ''}<div>${esc(i.note)}</div></li>`).join('') : '<li class="note">Nothing logged yet.</li>';
  } catch (e) { $('#ctTimeline').innerHTML = `<li class="bad">${esc(e.message)}</li>`; }
}
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
function rowsFromCsv(text) {
  const rows = parseCsv(text); if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names) => head.findIndex((h) => names.includes(h));
  const has = col(['name', 'full name']) >= 0 || col(['email', 'email address']) >= 0;
  const idx = has ? { name: col(['name', 'full name']), first: col(['first name', 'first']), last: col(['last name', 'last']), title: col(['title', 'job title', 'position']), organization: col(['organization', 'company', 'org', 'agency', 'office']), email: col(['email', 'email address', 'e-mail']), phone: col(['phone', 'phone number', 'mobile']), tags: col(['tags', 'tag', 'groups']), notes: col(['notes', 'note']) }
    : { name: 0, title: 1, organization: 2, email: 3, phone: 4, tags: 5, notes: -1, first: -1, last: -1 };
  const v = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
  return (has ? rows.slice(1) : rows).map((r) => ({ name: v(r, idx.name) || [v(r, idx.first), v(r, idx.last)].filter(Boolean).join(' '), title: v(r, idx.title), organization: v(r, idx.organization), email: v(r, idx.email), phone: v(r, idx.phone), tags: v(r, idx.tags).replace(/;/g, ','), notes: v(r, idx.notes) }));
}
function importDrawer() {
  showDrawer(`<div class="row"><h2>Import contacts</h2><button class="btn sm" data-act="close">Close</button></div>
  <p class="note">Choose a CSV file, or paste rows from a spreadsheet. The first row can name the columns (name, title, organization, email, phone, tags, notes); otherwise columns are read in that order. Contacts whose email is already here are updated, not duplicated.</p>
  <form id="imForm" class="form"><label class="wide">CSV file<input type="file" id="im_file" accept=".csv,text/csv,text/plain"></label>
  <label class="wide">Or paste<textarea id="im_text" rows="8" placeholder="name,title,organization,email,tags&#10;Dana Lee,Policy Advisor,NTIA,dana@ntia.gov,agency"></textarea></label>
  <div class="wide"><button class="btn primary">Import</button></div><p class="note wide" id="imMsg" role="status"></p></form>`);
}
const fill = (tpl, c) => tpl.replace(/\{(first_name|name|organization|title)\}/g, (_, k) => (k === 'first_name' ? c.name.split(/\s+/)[0] : c[k] || ''));
function bulkMailDrawer() {
  const list = CRM.contacts.filter((c) => CRM.sel.has(c.id)), withEmail = list.filter((c) => c.email);
  const prov = CLOUD.provider ? CLOUD.provider() : '';
  showDrawer(`<div class="row"><h2>Email ${plural2(withEmail.length, 'person')}</h2><button class="btn sm" data-act="close">Close</button></div>
  <p class="note">Each person gets their own copy from your ${prov === 'microsoft' ? 'Outlook' : prov === 'google' ? 'Gmail' : 'Gmail or Outlook'} account, so replies come to you. Use {first_name}, {name}, {organization} or {title} to personalize. Each send is logged on the contact.${list.length > withEmail.length ? ` ${list.length - withEmail.length} selected contact${list.length - withEmail.length === 1 ? ' has' : 's have'} no email address and will be skipped.` : ''}</p>
  <form id="bmForm" class="form">
    <label class="wide">Subject<input id="bm_subject" required></label>
    <label class="wide">Message<textarea id="bm_body" rows="10">Hi {first_name},\n\n</textarea></label>
    <label class="wide">Campaign<select id="bm_camp">${campaignOptions()}</select></label>
    <div class="wide btnrow"><button class="btn primary" id="bmGo">Send ${withEmail.length} emails</button></div>
    <p class="note wide" id="bmMsg" role="status"></p></form>`);
}
async function sendBulk(access) {
  const list = CRM.contacts.filter((c) => CRM.sel.has(c.id) && c.email), subject = $('#bm_subject').value.trim(), body = $('#bm_body').value, msg = $('#bmMsg');
  if (!subject) { msg.textContent = 'Add a subject.'; return; }
  $('#bmGo').disabled = true;
  try { await access; } catch (e) { msg.textContent = e.message; $('#bmGo').disabled = false; return; }
  const done = [];
  for (const c of list) {
    msg.textContent = `Sending ${done.length + 1} of ${list.length}`;
    try { await CLOUD.mail.send({ to: [c.email], subject: fill(subject, c), body: fill(body, c) }); done.push(c.id); }
    catch (e) { msg.textContent = `Stopped after ${done.length}: ${e.message}`; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (done.length) {
    try { await CLOUD.api('POST', wsPath('/interactions'), { contactIds: done, type: 'Email', note: subject, campaignId: $('#bm_camp').value }); } catch (e) { fail(e); }
    CRM.contacts = null; CRM.sel.clear();
  }
  if (done.length === list.length) { closeDrawer(); toast(`${plural2(done.length, 'email')} sent and logged`); }
  else $('#bmGo').disabled = false;
  renderContacts();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-x]'); if (!t) return;
  const x = t.dataset.x, id = t.dataset.id;
  switch (x) {
    case 'newWatch': return watchDrawer(null);
    case 'editWatch': return watchDrawer(MON.watches.find((w) => w.id === id));
    case 'delWatch': {
      if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = 'Delete this watch and what it found'; return; }
      try { await CLOUD.api('DELETE', wsPath(`/watches/${id}`)); closeDrawer(); MON.watches = null; MON.watch = ''; renderMonitor(); toast('Watch deleted'); } catch (err) { fail(err); }
      return;
    }
    case 'runWatch': {
      MON.busy = id; renderMonitor();
      try { const r = await CLOUD.api('POST', wsPath(`/watches/${id}/run`)); toast(r.error ? r.error : r.added || r.changed ? `${plural2(r.added, 'new item')}${r.changed ? `, ${r.changed} moved` : ''}` : 'Nothing new'); } catch (err) { fail(err); }
      MON.busy = ''; MON.watches = null; renderMonitor(); return;
    }
    case 'pickWatch': MON.watch = id || ''; MON.view = 'all'; await loadItems(); return;
    case 'monView': MON.view = t.dataset.v; await loadItems(); return;
    case 'itemState': {
      try { await CLOUD.api('PATCH', wsPath(`/items/${id}`), { state: t.dataset.state }); toast(t.dataset.state === 'tracked' ? 'Tracking: you will hear when it moves' : t.dataset.state === 'dismissed' ? 'Dismissed' : 'Back in the inbox'); } catch (err) { fail(err); }
      MON.watches = null; renderMonitor(); return;
    }
    case 'itemCampaign': { const it = (MON.items || []).find((i) => String(i.id) === id); if (it) await campaignFromItem(it); return; }
    case 'lobbying': return lobbyingDrawer(t.dataset.number, t.dataset.title);
    case 'incumbents': return incumbentsDrawer(t.dataset.agency, t.dataset.naics);
    case 'osRoster': return fetchRoster(t);
    case 'actionCenter': $('#moreMenu').open = false; return actionDrawer();
    case 'actCsv': return actionCsv();
    case 'newContact': showDrawer(`<div class="row"><h2>Add a contact</h2><button class="btn sm" data-act="close">Close</button></div>${contactForm(null)}`); return;
    case 'openContact': return contactDrawer(id);
    case 'delContact': {
      if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = 'Delete this contact and their history'; return; }
      try { await CLOUD.api('DELETE', wsPath(`/contacts/${id}`)); CRM.sel.delete(id); CRM.contacts = CRM.contacts.filter((c) => c.id !== id); closeDrawer(); renderContacts(); toast('Contact deleted'); } catch (err) { fail(err); }
      return;
    }
    case 'importContacts': return importDrawer();
    case 'exportContacts': return csvDownload(`contacts-${today()}.csv`, [['Name', 'Title', 'Organization', 'Email', 'Phone', 'Tags', 'Owner', 'Last touch', 'Notes'], ...shownContacts().map((c) => [c.name, c.title, c.organization, c.email, c.phone, c.tags.join(', '), personName(c.ownerId), c.lastTouch, c.notes])]);
    case 'clearSel': CRM.sel.clear(); return renderContacts();
    case 'bulkMail': return bulkMailDrawer();
    case 'bulkLog': showDrawer(`<div class="row"><h2>Log for ${plural2(CRM.sel.size, 'contact')}</h2><button class="btn sm" data-act="close">Close</button></div>${logForm([...CRM.sel])}`); return;
    default: return undefined;
  }
});
// The send button submits the form; ask for email access on the click itself.
document.addEventListener('click', (e) => {
  const b = e.target.closest('#bmGo'); if (!b) return;
  e.preventDefault(); sendBulk(signedIn() && (!CLOUD.connected() || !CLOUD.provider()) ? CLOUD.connect() : Promise.resolve());
}, true);
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'mw_kind') { document.querySelectorAll('.mwf').forEach((f) => { f.hidden = f.dataset.for !== t.value; }); return; }
  if (t.id === 'mon_kind') { MON.kind = t.value; loadItems(); return; }
  if (t.id === 'ct_tag') { CRM.tag = t.value; renderContacts(); return; }
  if (t.classList && t.classList.contains('ct-sel')) { if (t.checked) CRM.sel.add(t.dataset.id); else CRM.sel.delete(t.dataset.id); renderContacts(); return; }
  if (t.id === 'ct_all') { shownContacts().forEach((c) => { if (t.checked) CRM.sel.add(c.id); else CRM.sel.delete(c.id); }); renderContacts(); return; }
  if (t.id === 'im_file' && t.files[0]) { t.files[0].text().then((txt) => { $('#im_text').value = txt; }); }
});
let monTimer = null;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'mon_q') { MON.q = t.value; clearTimeout(monTimer); monTimer = setTimeout(async () => { await loadItems(); const el = $('#mon_q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 300); }
  if (t.id === 'ct_q') { CRM.q = t.value; renderContacts(); const el = $('#ct_q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target, id = f.id;
  if (!['mwForm', 'acForm', 'ctForm', 'ciForm', 'imForm', 'bmForm'].includes(id)) return;
  e.preventDefault();
  if (id === 'mwForm') return saveWatch(f);
  if (id === 'acForm') return saveAction();
  if (id === 'bmForm') return undefined; // sent by the button handler above
  if (id === 'ctForm') {
    const body = { name: $('#ct_name').value, title: $('#ct_title').value, organization: $('#ct_org').value, email: $('#ct_email').value, phone: $('#ct_phone').value, tags: $('#ct_tags').value, notes: $('#ct_notes').value, ownerId: $('#ct_owner') ? $('#ct_owner').value : '', clientId: $('#ct_client').value };
    try {
      const c = f.dataset.id ? await CLOUD.api('PATCH', wsPath(`/contacts/${f.dataset.id}`), body) : await CLOUD.api('POST', wsPath('/contacts'), body);
      CRM.contacts = [...CRM.contacts.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      renderContacts(); if (f.dataset.id) { toast('Saved'); contactDrawer(c.id); } else { closeDrawer(); toast(`${c.name} added`); }
    } catch (err) { $('#ctMsg').textContent = err.message; }
    return;
  }
  if (id === 'ciForm') {
    const ids = f.dataset.ids.split(',').filter(Boolean);
    try {
      await CLOUD.api('POST', wsPath('/interactions'), { contactIds: ids, type: $('#ci_type').value, day: $('#ci_day').value, note: $('#ci_note').value, campaignId: $('#ci_camp').value });
      toast(ids.length > 1 ? `Logged for ${ids.length} contacts` : 'Logged'); CRM.contacts = null;
      await loadContacts(); if (ids.length === 1) contactDrawer(ids[0]); else { CRM.sel.clear(); closeDrawer(); renderContacts(); }
    } catch (err) { fail(err); }
    return;
  }
  if (id === 'imForm') {
    const rows = rowsFromCsv($('#im_text').value);
    if (!rows.length) { $('#imMsg').textContent = 'Nothing to import yet.'; return; }
    try {
      const r = await CLOUD.api('POST', wsPath('/contacts/import'), { rows });
      $('#imMsg').textContent = `${plural2(r.added, 'contact')} added, ${r.updated} updated.${r.skipped.length ? ` Skipped: ${r.skipped.slice(0, 5).join(' ')}` : ''}`;
      CRM.contacts = null; loadContacts();
    } catch (err) { $('#imMsg').textContent = err.message; }
  }
});

// Installable app: an offline shell for the road and the capitol.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
