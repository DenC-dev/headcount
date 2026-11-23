'use strict';
// Headcount: whip counts, meeting requests and bill briefs. Plain browser JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POS = ['No', 'Lean no', 'Undecided', 'Lean yes', 'Yes'];
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Official pages say "Legislative Aide: None" when there is nobody in the job.
const NOBODY = /^(none|vacant|tbd|tba|n\/?a|to be (announced|determined)|position vacant|unassigned)\.?$/i;
const PROB = [0.03, 0.25, 0.5, 0.75, 0.97];
const RULES = { majority: ['Simple majority', (n) => Math.floor(n / 2) + 1], three5: ['Three-fifths', (n) => Math.ceil(n * 0.6)], two3: ['Two-thirds', (n) => Math.ceil(n * 2 / 3)] };
const PARTY_ORDER = { D: 0, I: 1, R: 2 };
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const today = () => iso(new Date());
const daysAgo = (n) => iso(new Date(Date.now() - n * 864e5));
const dayDiff = (d) => Math.round((Date.parse(d + 'T00:00:00') - Date.parse(today() + 'T00:00:00')) / 864e5);
const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pct = (p) => (p * 100 >= 99.5 ? '>99' : p * 100 < 0.5 ? '<1' : String(Math.round(p * 100)));
const clamp = (v) => Math.min(0.97, Math.max(0.03, v));

// ---------- example campaign (fictional chamber, bill and members) ----------
const EX = `Marisol Vega|D|4|1|4|2||rural health
Theo Lindqvist|D|11|1|4|1||labor
Aiyana Redcloud|D|27|1|4|2||tribal lands, broadband
Calvin Okafor|D|2|1|3|4|0|small business
Rosalind Achterberg|D|19|1|2|4||the state budget
Dev Banerjee|D|8|0|4|1||tech
Imogen Castellanos|D|14|0|4|2||education
Hollis Tran|D|22|0|4|1||transit
Beatrix Nakamura|D|31|0|4|2||utilities
Jonah Abernathy|D|6|0|4|1||seniors
Priscilla Adeyemi|D|17|0|4|2||housing
Rufus Delacroix|D|35|0|3|3|1|ports
Saoirse Whitlock|D|9|0|3|3||farm co-ops
Emeka Sorensen|D|25|0|3|4|4|budget
Lucinda Marchetti|D|38|0|2|3|4|telecom donors
Wendell Phan|D|13|0|2|4||urban district
Odalys Brennan|D|29|0|2|3|4|budget
Gideon Yamamoto|D|40|0|1|3||telecom donors
Petra Voss|D|20|0|1|2||incumbent carriers in district
Amos Fairweather|D|33|0|0|1||opposes subsidy model
Harlan Buckley|R|5|1|4|2||rural co-ops, sponsor
Darlene Ostrowski|R|16|1|3|3|20|agriculture
Wyatt Thibodeaux|R|30|1|2|4||farm bureau
Kendra Hallstrom|R|12|1|2|3|24|fiscal
Preston Vandermeer|R|1|1|0|1||majority leader ally, fiscal
Loretta Quist|R|23|1|1|3|24|fiscal
Boyd Stanhope|R|36|0|4|2|20|rural hospitals
Tabitha Rourke|R|7|0|3|3|20|agriculture
Clement Aldous|R|18|0|3|2||telehealth
Marguerite Pell|R|26|0|2|4||schools
Dashiell Kowalczyk|R|34|0|2|3|24|fiscal
Nolan Featherstone|R|39|0|1|3|24|fiscal
Greta Lindholm|R|10|0|1|2||carriers
Ezekiel Braddock|R|15|0|0|1|24|anti-subsidy
Winifred Castellaw|R|21|0|0|1||anti-subsidy
Rhett Dunmore|R|28|0|0|2|24|fiscal
Cordelia Ashby|R|32|0|0|1||carriers
Silas Montague|R|37|0|0|1||anti-subsidy
Junia Halvorsen|R|41|0|0|2|24|fiscal
Barnaby Creel|R|24|0|0|1||anti-subsidy
Esperanza Teague|I|3|1|0|2||property rights`;

function exampleState() {
  const rows = EX.split('\n').map((l) => l.split('|'));
  const members = rows.map((r, i) => ({ id: 'x' + i, name: r[0], party: r[1], district: r[2], cmte: r[3] === '1', pos: +r[4], mov: +r[5], follows: r[6] === '' ? '' : 'x' + r[6], interests: r[7], notes: '', history: [], staffers: [] }));
  return { v: 2, id: 'ex', example: true, campaign: { bill: 'SB 214: Rural Broadband Expansion Act', chamber: 'State Senate', committee: 'Commerce & Utilities', rule: 'majority', side: 'pass', ask: '', client: '', me: '', cmteDate: '', floorDate: '' },
    brief: exampleBrief(), members, tasks: [], meetings: [], plan: [], trend: [{ d: daysAgo(28), p: 0.31 }, { d: daysAgo(21), p: 0.38 }, { d: daysAgo(14), p: 0.36 }, { d: daysAgo(7), p: 0.47 }] };
}
function blankState(name) {
  return { v: 2, id: uid(), campaign: { bill: name || 'New campaign', chamber: '', committee: '', rule: 'majority', side: 'pass', ask: '', client: '', me: '', cmteDate: '', floorDate: '' }, brief: blankBrief(), members: [], tasks: [], meetings: [], plan: [], trend: [] };
}
function normalize(st) {
  st.v = 2; st.id = st.id || uid();
  st.campaign = Object.assign({ bill: '', chamber: '', committee: '', rule: 'majority', side: 'pass', ask: '', client: '', me: '', cmteDate: '', floorDate: '' }, st.campaign);
  if (!RULES[st.campaign.rule]) st.campaign.rule = 'majority';
  st.tasks = Array.isArray(st.tasks) ? st.tasks : []; st.meetings = Array.isArray(st.meetings) ? st.meetings : []; st.plan = Array.isArray(st.plan) ? st.plan : []; st.trend = Array.isArray(st.trend) ? st.trend : [];
  if (!Array.isArray(st.members)) st.members = [];
  st.brief = Object.assign(blankBrief(), st.brief || {});
  st.members.forEach(normMember);
  return st;
}
function normMember(m) {
  m.history = Array.isArray(m.history) ? m.history : []; m.staffers = Array.isArray(m.staffers) ? m.staffers : [];
  if (m.staff) { m.staffers.push({ id: uid(), name: m.staff, role: '', phone: '', email: '', notes: '' }); delete m.staff; }
  m.staffers = m.staffers.filter((x) => !(x.src === 'directory' && NOBODY.test(String(x.name || '').trim()))); // "Legislative Aide: None" is not a person
  m.pos = Math.min(4, Math.max(0, +m.pos || 0)); m.mov = Math.min(5, Math.max(1, +m.mov || 3));
  return m;
}

// ---------- model ----------
const dirOf = (st) => (st.campaign.side === 'defeat' ? -1 : 1);
const goal = (st, p) => (dirOf(st) > 0 ? p : 1 - p);
function needs(st) {
  const n = st.members.length, c = st.members.filter((m) => m.cmte).length;
  return { n, c, needF: RULES[st.campaign.rule][1](n), needC: c ? Math.floor(c / 2) + 1 : 0 };
}
// Exact joint distribution over (committee yes votes, floor yes votes), as a flat C x W grid.
function distOf(members, probs, nd) {
  const W = nd.n + 1, C = nd.c + 1, a = new Float64Array(C * W);
  a[0] = 1;
  members.forEach((m, i) => {
    const p = probs[i], sh = m.cmte ? W + 1 : 1;
    for (let k = a.length - 1; k >= 0; k--) a[k] = a[k] * (1 - p) + (k >= sh ? a[k - sh] * p : 0);
  });
  return a;
}
function passFrom(a, nd, dc, df) {
  const W = nd.n + 1, C = nd.c + 1;
  let t = 0;
  for (let c = Math.max(0, nd.needC - dc); c < C; c++) for (let f = Math.max(0, nd.needF - df); f < W; f++) t += a[c * W + f];
  return t;
}
function passage(members, probs, nd) {
  const a = distOf(members, probs, nd), W = nd.n + 1, C = nd.c + 1;
  let cm = 0, fl = 0;
  for (let c = 0; c < C; c++) for (let f = 0; f < W; f++) { const v = a[c * W + f]; if (c >= nd.needC) cm += v; if (f >= nd.needF) fl += v; }
  return { both: nd.n ? passFrom(a, nd, 0, 0) : 0, cm, fl: nd.n ? fl : 0, a };
}
// Change in the odds of passage per unit of one member's yes-probability:
// take that member out of the distribution, then compare "votes yes" with "votes no".
function partialFor(a, nd, p, cmte) {
  const W = nd.n + 1, C = nd.c + 1, g = new Float64Array(C * W), dc = cmte ? 1 : 0;
  if (p <= 0.5) {
    for (let c = 0; c < C; c++) for (let f = 0; f < W; f++) {
      const prev = f >= 1 && c >= dc ? g[(c - dc) * W + f - 1] : 0;
      g[c * W + f] = Math.max(0, (a[c * W + f] - p * prev) / (1 - p));
    }
  } else {
    for (let c = C - 1; c >= 0; c--) for (let f = W - 1; f >= 0; f--) {
      if (f + 1 >= W || c + dc >= C) { g[c * W + f] = 0; continue; }
      const nx = (c + dc) * W + f + 1;
      g[c * W + f] = Math.max(0, (a[nx] - (1 - p) * g[nx]) / p);
    }
  }
  return passFrom(g, nd, dc, 1) - passFrom(g, nd, 0, 0);
}
const baseProbs = (st) => st.members.map((m) => PROB[m.pos]);
const canStep = (st, m) => (dirOf(st) > 0 ? m.pos < 4 : m.pos > 0);
function nudged(st, probs, ids) {
  const out = probs.slice(), dir = dirOf(st);
  const idx = new Map(st.members.map((m, i) => [m.id, i]));
  ids.forEach((id) => {
    const i = idx.get(id); if (i === undefined) return;
    const m = st.members[i]; if (!canStep(st, m)) return;
    const delta = PROB[m.pos + dir] - PROB[m.pos];
    out[i] = PROB[m.pos + dir];
    st.members.forEach((f, j) => { if (f.follows === id && j !== i) out[j] = clamp(out[j] + delta / 2); });
  });
  return out;
}
function callSheet(st, nd, base, limit = 8) {
  const cache = {}, dir = dirOf(st);
  const part = (m) => { const k = m.pos + (m.cmte ? 'c' : 'f'); return k in cache ? cache[k] : (cache[k] = partialFor(base.a, nd, PROB[m.pos], m.cmte)); };
  const fol = new Map();
  st.members.forEach((f) => { if (f.follows) fol.set(f.follows, (fol.get(f.follows) || []).concat(f)); });
  return st.members.filter((m) => canStep(st, m)).map((m) => {
    const delta = PROB[m.pos + dir] - PROB[m.pos], fs = (fol.get(m.id) || []).filter((f) => f.id !== m.id);
    let change = delta * part(m);
    fs.forEach((f) => { change += (clamp(PROB[f.pos] + delta / 2) - PROB[f.pos]) * part(f); });
    const gain = dir * change;
    return { m, gain, followers: fs.length, score: gain * m.mov / 5 };
  }).filter((r) => r.gain > 0.0005).sort((a, b) => b.score - a.score).slice(0, limit);
}
function verbFor(st, m) {
  const dir = dirOf(st), near = dir > 0 ? 3 : 1, far = dir > 0 ? 0 : 4;
  return m.pos === near ? 'Lock in' : m.pos === far ? 'Soften' : 'Persuade';
}

// ---------- preset rosters and contact details ----------
let ROSTERS = null, DIR = {};
// ---------- official staff ----------
// Each built-in chamber has a staff file from the official directories:
// names, titles and phones, with emails in the chamber's usual format.
const STAFF = {};
const STAFF_KEYS = ['ushouse', 'flhouse', 'flsenate']; // the U.S. Senate publishes no staff list
async function staffFor(key) {
  if (!STAFF_KEYS.includes(key)) return null;
  if (STAFF[key] !== undefined) return STAFF[key];
  try { const res = await fetch(`/staff/${key}.json`); STAFF[key] = res.ok ? await res.json() : null; } catch (_) { STAFF[key] = null; }
  return STAFF[key];
}
const dirStaff = (key, ref) => ((STAFF[key] && STAFF[key].people[ref]) || []).filter((r) => !NOBODY.test(String(r[0] || '').trim())).map(([n, t, ph, em]) => ({ id: uid(), name: n, role: t, phone: ph, email: em, notes: '', fmt: true, src: 'directory' }));
// Official staff show up on their own: every member of a built-in chamber gets
// the staff from the official list, including campaigns made before the list
// existed, and names added when the list is refreshed. Staff someone removed
// stay removed.
const nameKey = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
function refByName(key, m) {
  const p = ROSTERS && ROSTERS[key]; if (!p || !m.name) return '';
  const last = nameKey(lastName(m.name)), d = String(m.district || '').replace(/^0+/, '');
  const hit = p.members.filter((x) => nameKey(lastName(x.n)) === last && (!d || String(x.d).replace(/^0+/, '') === d));
  return hit.length === 1 ? hit[0].k : '';
}
function autoStaff() {
  if (S.example) return;
  const key = presetKey(), dir = STAFF_KEYS.includes(key) ? STAFF[key] : null;
  if (STAFF_KEYS.includes(key) && dir === undefined) staffFor(key).then((x) => { if (x) render(); });
  else if (dir && S.members.some((m) => m.dirAt !== dir.asOf)) {
    for (const m of S.members) {
      if (m.dirAt === dir.asOf) continue;
      m.dirAt = dir.asOf;
      const ref = m.ref || refByName(key, m); if (!ref) continue;
      m.ref = ref;
      const have = new Set(m.staffers.map((x) => nameKey(x.name))), gone = new Set(m.dirGone || []);
      m.staffers.push(...dirStaff(key, ref).filter((x) => !have.has(nameKey(x.name)) && !gone.has(nameKey(x.name))));
    }
    if (canEditNow()) save(); // viewers see the staff without saving anything
  }
  const L = orgStaffList();
  if (L && S.members.some((m) => m.lsAt !== L.at)) matchOrgStaff(L);
}
// ----- the workspace's own staff list, such as a LegiStorm export -----
// An admin uploads it on the Workspace page; the server matches it to each
// campaign's members and its real email addresses replace the usual-format ones.
let ORG_STAFF = { oid: null, list: undefined, busy: false, failedAt: 0 };
function orgStaffList() {
  if (!S.cloud) return null;
  loadOrgStaff();
  return ORG_STAFF.list || null;
}
function loadOrgStaff() {
  if (!ORG || ORG.role === 'guest' || !signedIn()) return;
  if (ORG_STAFF.oid !== ORG.id) {
    const oid = ORG.id; ORG_STAFF = { oid, list: undefined, busy: false, failedAt: 0 };
    CLOUD.api('GET', wsPath('/staff-list')).then((r) => { if (ORG_STAFF.oid === oid) { ORG_STAFF.list = r.list; render(); if (page === 'workspace') renderWorkspace(true); } }).catch(() => { if (ORG_STAFF.oid === oid) ORG_STAFF.list = null; });
  }
}
function campaignChamber(st = S) {
  const j = st.campaign && st.campaign.juris;
  if (j && j.chamber) return { level: j.level === 'us' ? 'us' : 'state', state: j.state || '', chamber: j.chamber };
  return ({ ushouse: { level: 'us', chamber: 'lower' }, ussenate: { level: 'us', chamber: 'upper' }, flhouse: { level: 'state', state: 'FL', chamber: 'lower' }, flsenate: { level: 'state', state: 'FL', chamber: 'upper' } })[presetKey(st)] || { level: '', state: '', chamber: '' };
}
async function matchOrgStaff(list) {
  if (ORG_STAFF.busy || Date.now() - ORG_STAFF.failedAt < 60e3) return;
  ORG_STAFF.busy = true;
  const camp = S.id, todo = S.members.filter((m) => m.lsAt !== list.at && m.name);
  try {
    const r = await CLOUD.api('POST', wsPath('/staff-list/match'), { ...campaignChamber(), members: todo.map((m) => ({ id: m.id, name: m.name, district: m.district })) });
    if (S.id !== camp) return;
    for (const m of todo) {
      m.lsAt = list.at;
      const gone = new Set(m.dirGone || []);
      for (const [name, role, phone, email] of (r.staff || {})[m.id] || []) {
        const cur = m.staffers.find((x) => nameKey(x.name) === nameKey(name));
        if (cur) { if (email) { cur.email = email; cur.fmt = false; } if (phone && (!cur.phone || cur.src === 'directory')) cur.phone = phone; if (role) cur.role = role; cur.src = 'legistorm'; }
        else if (!gone.has(nameKey(name))) m.staffers.push({ id: uid(), name, role, phone, email, notes: '', src: 'legistorm' });
      }
    }
    if (canEditNow()) save();
    render();
  } catch (_) { ORG_STAFF.failedAt = Date.now(); } finally { ORG_STAFF.busy = false; }
}
const STAFF_COLS = {
  name: ['name', 'full name', 'staff name', 'staffer', 'contact name', 'person'], first: ['first name', 'first', 'given name'], last: ['last name', 'last', 'surname', 'family name'],
  title: ['title', 'job title', 'position', 'staff title', 'role'], email: ['email', 'email address', 'e mail', 'work email', 'official email'],
  phone: ['phone', 'phone number', 'office phone', 'work phone', 'telephone', 'direct phone'],
  office: ['office', 'member', 'office name', 'member name', 'legislator', 'boss', 'employer', 'organization', 'committee', 'member office', 'works for', 'official'],
  state: ['state', 'member state', 'office state'], district: ['district', 'member district'], chamber: ['chamber', 'body', 'house senate', 'legislature'],
};
function staffRowsFromCsv(text) {
  const rows = parseCsv(text); if (rows.length < 2) return { rows: [], missing: ['a header row'] };
  const w = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), head = rows[0].map(w);
  const find = (names) => { for (const n of names) { const i = head.indexOf(w(n)); if (i >= 0) return i; } for (const n of names) { const i = head.findIndex((h) => h.includes(w(n))); if (i >= 0) return i; } return -1; };
  const ix = Object.fromEntries(Object.entries(STAFF_COLS).map(([k, n]) => [k, find(n)]));
  const missing = [ix.name < 0 && (ix.first < 0 || ix.last < 0) ? 'staff name' : '', ix.office < 0 ? 'the office they work for' : ''].filter(Boolean);
  if (missing.length) return { rows: [], missing };
  const v = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
  return { rows: rows.slice(1).map((r) => [v(r, ix.name) || [v(r, ix.first), v(r, ix.last)].filter(Boolean).join(' '), v(r, ix.title), v(r, ix.email), v(r, ix.phone), v(r, ix.office), v(r, ix.state), v(r, ix.district), v(r, ix.chamber)]), missing: [] };
}
async function uploadStaffList(file) {
  const msg = $('#slMsg'); if (!file) return;
  if (/\.xlsx?$/i.test(file.name)) { msg.textContent = 'That is an Excel file. In Excel, choose File, then Save As, then CSV, and upload the CSV file.'; return; }
  msg.textContent = 'Reading the file…';
  const { rows, missing } = staffRowsFromCsv(await file.text());
  if (missing.length) { msg.textContent = `Headcount could not find a column for ${missing.join(' or ')}. The first row of the file should name the columns.`; return; }
  msg.textContent = `Uploading ${rows.length.toLocaleString()} staff…`;
  try {
    const r = await CLOUD.api('PUT', wsPath('/staff-list'), { source: 'LegiStorm', rows });
    ORG_STAFF.list = r.list; toast(`${r.list.count.toLocaleString()} staff saved. Campaigns fill them in as they open.`);
    renderWorkspace(true); render();
  } catch (e) { msg.textContent = e.message; }
}
function staffListPanel() {
  if (!ORG || ORG.role === 'guest') return '';
  loadOrgStaff();
  const L = ORG_STAFF.list, admin = isAdmin();
  return `<div class="panel"><span class="label">Staff list</span>
    <p class="note">Have LegiStorm? Upload its staff export to show real staff emails in every campaign.</p>
    ${L ? `<p><b>${esc(L.count.toLocaleString())} staff</b> from ${esc(L.source)}, uploaded ${esc(fmtDate(L.at))}${L.by ? ` by ${esc(L.by)}` : ''}.</p>` : L === null ? '<p class="note">No staff list uploaded yet.</p>' : ''}
    ${admin ? `<div class="btnrow"><label class="btn${L ? '' : ' primary'}" for="sl_file">${L ? 'Upload a newer file' : 'Upload a LegiStorm export'}</label><input type="file" id="sl_file" accept=".csv,text/csv,text/plain" hidden>${L ? '<button class="btn" data-act="slRemove">Remove it</button>' : ''}</div>
    <p class="note">A CSV with each person's name and office. Upload only what your LegiStorm license allows.</p>
    <p class="note" id="slMsg" role="status"></p>` : ''}
  </div>`;
}
// Which built-in chamber a campaign counts, also for campaigns made before the key was saved.
function presetKey(st = S) {
  if (st.preset && st.preset.key) return st.preset.key;
  const j = st.campaign && st.campaign.juris;
  return j ? ({ 'us-lower': 'ushouse', 'us-upper': 'ussenate', 'FL-lower': 'flhouse', 'FL-upper': 'flsenate' })[`${j.level === 'us' ? 'us' : j.state}-${j.chamber}`] || '' : '';
}
function presetMember(key, p, m, extra = {}) {
  const live = Boolean(p.juris && p.source === 'Open States' && /^os-/.test(key));
  return { id: 'p' + m.k, ref: m.k, name: m.n, party: m.p, district: m.d, cmte: false, role: '', pos: 2, mov: 3, follows: '', interests: '', notes: '', history: [], staffers: dirStaff(key, m.k),
    ...(live ? { c: { ph: m.ph || '', of: m.of || '', em: m.em || '', dph: m.dph || '', dof: m.dof || '', url: m.url || '' } } : {}), ...extra };
}
// Brings a campaign's members up to date with the current list: returning
// members keep their positions, notes and history; new members start undecided.
async function updateMembers() {
  const key = presetKey(), p = ROSTERS && ROSTERS[key];
  if (!p || p.stale) return toast('No newer list is available yet.');
  await staffFor(key);
  const byRef = new Map(S.members.filter((m) => m.ref).map((m) => [m.ref, m]));
  const kept = [], added = [];
  for (const x of p.members) {
    const old = byRef.get(x.k);
    if (old) { Object.assign(old, { name: x.n, party: x.p, district: x.d }); if (!old.staffers.some((s) => s.src === 'directory')) old.staffers.push(...dirStaff(key, x.k)); kept.push(old); }
    else added.push(presetMember(key, p, x));
  }
  const gone = S.members.filter((m) => m.ref && !p.members.some((x) => x.k === m.ref)), custom = S.members.filter((m) => !m.ref && !m.draft);
  S.members = [...kept, ...added, ...custom];
  S.preset = { ...(S.preset || {}), key, label: p.label, asOf: p.asOf, stale: false, vacant: p.seats - p.members.length };
  commit(`${p.label} updated: ${added.length} new member${added.length === 1 ? '' : 's'}, ${gone.length} gone${gone.length ? ` (${gone.slice(0, 4).map((m) => m.name).join(', ')}${gone.length > 4 ? ', …' : ''})` : ''}`);
}
async function loadRosters() {
  try {
    const res = await fetch('/rosters.json');
    if (!res.ok) return;
    ROSTERS = (await res.json()).presets;
    Object.values(ROSTERS).forEach((p) => p.members.forEach((m) => { DIR[m.k] = m; }));
    render();
  } catch (_) { /* presets stay unavailable */ }
}
function contact(m) {
  const r = (m.ref && DIR[m.ref]) || m.c || {};
  return { phone: m.phone || r.ph || '', email: m.email || r.em || '', office: r.of || '', dphone: r.dph || '', doffice: r.dof || '', url: r.url || '', form: r.cf || '',
    phoneUsual: !m.phone && Boolean(r.phf), emailUsual: !m.email && Boolean(r.emf) };
}
// Each state's chambers by their own names (the California Assembly, the
// Maryland House of Delegates, the Texas House) and what members are called,
// as the server lists them.
function chambersOf(st, name = '') {
  const list = CLOUD.config && CLOUD.config.chambers && CLOUD.config.chambers[st];
  if (list && list.length) return list;
  return st === 'NE' ? [{ chamber: 'legislature', label: 'Nebraska Legislature', title: 'Senator' }] : [{ chamber: 'upper', label: `${name || st} Senate`, title: 'Senator' }, { chamber: 'lower', label: `${name || st} House`, title: 'Representative' }];
}
// The chambers someone can count: the built-in ones, and every state once
// legislator data is turned on.
function chamberOptions() {
  const cfg = CLOUD.config || {}, states = cfg.rosters && signedIn() ? cfg.states || {} : {};
  const presets = ROSTERS ? Object.entries(ROSTERS).filter(([k]) => !/^os-/.test(k)).map(([k, p]) => `<option value="p:${esc(k)}">${esc(p.label)}</option>`).join('') : '';
  const live = Object.entries(states).filter(([k]) => !(ROSTERS && ['FL'].includes(k))).flatMap(([k, v]) => chambersOf(k, v).map((c) => [`s:${k}:${c.chamber}`, c.label])).map(([val, label]) => `<option value="${val}">${esc(label)}</option>`).join('');
  return { presets, live };
}
// Fills a campaign with a chamber's current members and staff: "p:ushouse" or "s:TX:upper".
async function fillChamber(choice, st = S) {
  const [kind, a, b] = String(choice).split(':');
  if (kind === 'p') { await staffFor(a); loadPreset(a, -1, '', st); return ROSTERS[a].label; }
  const r = await CLOUD.api('GET', `/api/rosters/state?state=${encodeURIComponent(a)}&chamber=${encodeURIComponent(b)}`);
  if (!ROSTERS) ROSTERS = {};
  ROSTERS[r.key] = r; r.members.forEach((m) => { DIR[m.k] = m; });
  loadPreset(r.key, -1, '', st); return `${r.label}: ${r.members.length} members`;
}
// The legislature a campaign's bill belongs to: 'US', a state code, or '' when
// nothing says (a vote typed in by hand).
function billLegislature(st = S) {
  const c = st.campaign || {}, j = c.juris;
  if (j && j.level === 'us') return 'US';
  if (j && j.level === 'state' && j.state) return j.state;
  if (c.leg) return c.leg;
  const text = `${(st.brief && st.brief.jurisdiction) || ''} ${c.chamber || ''}`;
  if (/\bU\.?S\.?\b|\bcongress\b/i.test(text)) return 'US';
  const states = Object.assign({ FL: 'Florida' }, (CLOUD.config && CLOUD.config.states) || {});
  const hit = Object.entries(states).sort((x, y) => y[1].length - x[1].length).find(([, name]) => new RegExp(`\\b${name}\\b`, 'i').test(text));
  return hit ? hit[0] : '';
}
const legName = (leg) => (leg === 'US' ? 'Congress' : Object.assign({ FL: 'Florida' }, (CLOUD.config && CLOUD.config.states) || {})[leg] || leg);
// The chambers of one legislature that can be loaded here, House side first.
function legChoices(leg) {
  const P = ROSTERS || {};
  const preset = (pairs) => pairs.filter(([k]) => P[k]).map(([k, chamber]) => ({ value: `p:${k}`, chamber, label: P[k].label }));
  if (leg === 'US') return preset([['ushouse', 'lower'], ['ussenate', 'upper']]);
  if (leg === 'FL' && P.flhouse && P.flsenate) return preset([['flhouse', 'lower'], ['flsenate', 'upper']]);
  const cfg = CLOUD.config || {};
  if (!leg || !(cfg.rosters && signedIn()) || !(cfg.states || {})[leg]) return [];
  return chambersOf(leg, cfg.states[leg]).map((c) => ({ value: `s:${leg}:${c.chamber}`, chamber: c.chamber, label: c.label })).sort((x, y) => (x.chamber === 'lower' ? -1 : y.chamber === 'lower' ? 1 : 0));
}
// The chamber a bill number belongs to: HB, H.R., AB and A bills start in the
// House or Assembly, SB and S. bills in the Senate. A one-chamber legislature
// has only one answer.
function billChamber(number, leg) {
  const list = legChoices(leg); if (list.length === 1) return list[0].chamber;
  const n = String(number || '').trim().toUpperCase();
  return /^(H|A)/.test(n) ? 'lower' : /^S/.test(n) ? 'upper' : '';
}
// Shortens a long official title on a word, not in the middle of one.
function clipWords(t, n) {
  t = String(t || '').replace(/\s+/g, ' ').trim(); if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:(]+$/, '')}…`;
}
// A campaign for a known bill loads the chamber the bill is in, without asking.
let AUTO_CHAMBER = '';
function autoChamber() {
  if (AUTO_CHAMBER === S.id || S.members.length || S.example || SYNC.loading || !canEditNow()) return;
  const leg = billLegislature(), list = legChoices(leg), c = list.find((x) => x.chamber === billChamber(billNumberOf(), leg));
  if (!c) return;
  AUTO_CHAMBER = S.id; const st = S;
  setTimeout(async () => {
    if (S !== st || S.members.length) return;
    const msg = $('#q_msg'); if (msg) msg.textContent = `Loading the ${c.label}`;
    try { const label = await fillChamber(c.value, st); if (S === st) { commit(`${label} loaded`); if (recordReady()) fillFromRecord({ auto: true }); } }
    catch (e) { const m = $('#q_msg'); if (m) m.textContent = e.message; }
  }, 200);
}
// ---------- the bill's story: where it stands, each step in plain words ----------
let STORY = { key: '', data: null, loading: false, err: '' };
function storyKey(st = S) {
  const leg = billLegislature(st), num = billNumberOf(st), cfg = CLOUD.config || {};
  if (!leg || !num || !signedIn() || !CLOUD.api || !cfg.bills || !(leg === 'US' ? cfg.bills.federal : cfg.bills.states)) return '';
  return `${leg}|${num}|${st.brief.session || ''}`;
}
async function loadStory(force = false) {
  const key = storyKey(); if (!key) return;
  if (!force && (STORY.key === key && (STORY.data || STORY.loading || STORY.err))) return;
  const [jurisdiction, number, session] = key.split('|');
  STORY = { key, data: STORY.key === key ? STORY.data : null, loading: true, err: '' };
  try {
    const q = new URLSearchParams({ jurisdiction, number }); if (session) q.set('session', session); if (force) q.set('fresh', '1');
    const r = await CLOUD.api('GET', `/api/bills/story?${q}`);
    if (STORY.key === key) { STORY = { key, data: r, loading: false, err: '' }; if (page === 'brief') track('story_viewed'); }
    if (STORY.key === storyKey()) hearingDate(r);
  } catch (e) { if (STORY.key === key) STORY = { key, data: STORY.data, loading: false, err: e.message }; }
  if (STORY.key === storyKey()) { if (page === 'brief' && !briefEdit) renderBrief(); storyLine(); }
}
// When the bill is on a committee's agenda in the chamber being counted, that
// date becomes the campaign's committee vote (unless someone set a later one).
function hearingDate(d) {
  if (!canEditNow() || S.example) return;
  const ch = campaignChamber().chamber, h = upcomingHearings(d).find((x) => !x.chamber || !ch || x.chamber === ch);
  if (!h || S.campaign.cmteDate === h.date || (S.campaign.cmteDate && dayDiff(S.campaign.cmteDate) >= 0 && S.campaign.cmteFrom !== 'agenda')) return;
  S.campaign.cmteDate = h.date; S.campaign.cmteFrom = 'agenda';
  if (!S.campaign.committee && h.committee) S.campaign.committee = h.committee.slice(0, 80);
  commit(`On the agenda: ${h.committee || 'committee'} ${fmtDay(h.date)}`);
}
const storyNow = () => (STORY.key && STORY.key === storyKey() && STORY.data ? STORY.data : null);
// One line under the campaign title: where the bill is now.
function storyLine() {
  const el = $('#hNow'); if (!el) return;
  const d = storyNow(), show = d && d.stage && d.stage.now && (page === 'count' || page === 'brief');
  el.hidden = !show; if (!show) return;
  const fresh = d.changedAt && Date.now() - d.changedAt < 3 * 864e5;
  // Counting one chamber while the bill sits in the other: offer the switch.
  const counting = campaignChamber().chamber, there = d.stage.chamber, leg = billLegislature();
  const moving = ['filed', 'committee-wait', 'committee', 'floor', 'crossed'].includes(d.stage.where);
  const other = moving && there && counting && there !== counting && S.members.length && canEditNow() ? legChoices(leg).find((c) => c.chamber === there) : null;
  el.innerHTML = `<span class="dot${fresh ? ' fresh' : ''}"></span><b>${esc(billNumberOf())}</b> ${esc(d.stage.now)} ${page === 'count' ? '<button class="linkbtn" data-page="brief">What happens next</button>' : ''}${other ? ` <button class="btn sm primary" data-act="pickChamber" data-v="${esc(other.value)}" data-label="${esc(other.label)}">Count the ${esc(other.label)}</button>` : ''}`;
}
const VOTE_WORD = { yes: 'Yes', no: 'No', other: 'Not voting' };
// A hearing's start as a local time ("1:00 pm" on the date), for calendar links.
function hearingStart(h) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(h.time || '');
  let hr = m ? Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0) : 9; const mn = m && m[2] ? Number(m[2]) : 0;
  return new Date(`${h.date}T${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}:00`);
}
function hearingLink(h, bill) {
  if (!CLOUD.calendarLink) return '';
  const start = hearingStart(h), end = new Date(start.getTime() + 2 * 3600e3);
  return CLOUD.calendarLink('google', { title: `${bill}: ${h.committee ? `${h.committee} committee` : 'Committee'} hearing`, description: `${bill} is on the agenda.${h.room ? ` Room: ${h.room}.` : ''}`, start, end, location: h.room || '', attendees: [], meet: false });
}
const upcomingHearings = (d) => ((d && d.hearings) || []).filter((h) => dayDiff(h.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));
// ext: { d, leg, number } shows a bill that is not the open campaign's (the Bills page).
let STORY_LEG = '';
function storyPanelHtml(ext = null) {
  const key = ext ? 'ext' : storyKey();
  if (!key) return '';
  const d = ext ? ext.d : storyNow();
  STORY_LEG = ext ? ext.leg : billLegislature();
  if (!d) return `<section class="story"><span class="label">Where it stands</span><p class="note">${STORY.err && STORY.key === key ? `${esc(STORY.err)} <button class="linkbtn" data-act="storyAgain">Try again</button>` : 'Reading the bill\'s record'}</p></section>`;
  const st = d.stage || { steps: [], step: 0 }, checked = d.checkedAt ? new Date(d.checkedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const steps = `<ol class="stepper" aria-label="How far the bill has come">${st.steps.map((x, i) => `<li class="${i < st.step || (st.done && i === st.step) ? 'done' : i === st.step ? (st.stopped ? 'stopped' : 'here') : ''}"><span>${esc(x)}</span></li>`).join('')}</ol>`;
  const stops = (d.stops || []).length ? `<h3>Committee stops</h3><div class="tablewrap"><table class="stops"><thead><tr><th>Committee</th><th>Sent there</th><th>Result</th><th>Committee vote</th></tr></thead><tbody>${d.stops.map((x, i) => `<tr>
      <td><b>${esc(x.committee)}</b><div class="meta">${esc(chamberWord(x.chamber))}</div></td><td>${esc(fmtDay(x.referred))}</td>
      <td>${x.result === 'pending' ? `<span class="status st-wait">Waiting</span>${x.hearing && dayDiff(x.hearing.date) >= 0 ? ` <span class="meta">On the agenda ${esc(fmtDay(x.hearing.date))}${x.hearing.time ? `, ${esc(x.hearing.time)}` : ''}</span>` : ''}` : x.result === 'approved' ? `<span class="status st-ok">Approved</span> <span class="meta">${esc(fmtDay(x.resultDate))}</span>` : `<span class="status st-bad">${x.result === 'unfavorable' ? 'Unfavorable' : 'Stopped'}</span> <span class="meta">${esc(fmtDay(x.resultDate))}</span>`}</td>
      <td>${x.vote ? `${x.vote.yes} yes, ${x.vote.no} no ${x.vote.members && x.vote.members.length ? `<details class="votes"><summary>Who voted how</summary><ul>${x.vote.members.map((m) => `<li><span class="v-${esc(m.v)}">${esc(VOTE_WORD[m.v] || m.v)}</span> ${esc(m.name)}</li>`).join('')}</ul></details>` : ''}` : '<span class="meta">Not recorded</span>'}</td></tr>`).join('')}</tbody></table></div>` : '';
  const floor = (d.floor || []).length ? `<h3>Floor votes</h3><ul class="floorvotes">${d.floor.map((v) => `<li><b>${esc(chamberWord(v.chamber))}</b>, ${esc(fmtDay(v.date))}: ${v.yes} yes, ${v.no} no${v.motion ? ` <span class="meta">· ${esc(v.motion)}</span>` : ''}</li>`).join('')}</ul>` : '';
  const news = (d.news || []).filter((n) => Date.now() - n.foundAt < 14 * 864e5);
  const tl = (d.timeline || []).slice().reverse();
  return `<section class="story" aria-label="Where the bill stands">
    <div class="row"><span class="label">Where it stands</span><span class="btnrow"><button class="linkbtn" data-act="glossary">What the words mean</button>${ext ? '' : '<button class="btn sm" data-act="storyAgain" title="Read the record again now">Check now</button>'}</span></div>
    ${steps}
    <p class="now"><b>Now.</b> ${esc(st.now || 'No recorded actions yet.')}</p>
    ${st.last && st.last.plain && !(st.now || '').startsWith(st.last.plain) ? `<p class="next"><b>Latest.</b> ${esc(st.last.plain)}${st.last.date ? `, ${esc(fmtDay(st.last.date))}` : ''}.</p>` : ''}
    ${st.next ? `<p class="next"><b>Next.</b> ${esc(st.next)}</p>` : ''}
    ${upcomingHearings(d).map((h) => `<div class="hearing"><span class="label">On the agenda</span><p><b>${esc(h.committee ? `${h.committee}${/committee/i.test(h.committee) ? '' : ' committee'}` : 'Committee')}</b>, ${esc(fmtDay(h.date))}${h.time ? ` at ${esc(h.time)}` : ''}${h.room ? `, ${esc(h.room)}` : ''} <span class="meta">(${esc(inDays(h.date))})</span></p><a class="btn sm" href="${esc(hearingLink(h, ext ? ext.number : billNumberOf()))}" target="_blank" rel="noopener">Add to Google Calendar</a></div>`).join('')}
    ${news.length ? `<div class="news"><span class="label">New in the last two weeks</span><ul>${news.map((n) => `<li><span class="meta">${esc(fmtDay(n.date))}</span> ${esc(n.plain)}</li>`).join('')}</ul></div>` : ''}
    ${stops}${floor}
    ${tl.length ? `<details class="timeline"><summary>Every step (${tl.length})</summary><ol>${tl.map((t) => `<li${t.minor ? ' class="minor"' : ''}><span class="when">${esc(fmtDay(t.date))}</span><span class="what">${esc(t.plain)}${t.plain !== t.text ? `<span class="official">Official record: ${esc(t.text)}</span>` : ''}</span></li>`).join('')}</ol></details>` : ''}
    <p class="note">From ${esc(d.source || 'the public record')}${checked ? `, checked ${esc(checked)}` : ''}. Headcount rereads it every few hours and tells your team when the bill moves.${d.stale ? ` Last check failed: ${esc(d.stale)}` : ''}</p>
  </section>`;
}
// Similar bills in other legislatures (Plural's "global bill search"): a few
// words from the bill's name, searched in every state and Congress.
const STOP = new Set('a an and act acts amending amend the of to for in on by with from relating concerning providing further known as its or be this that relative regarding regards'.split(' '));
function similarWords() {
  const name = String(S.campaign.bill || '').split(':').slice(1).join(':') || S.brief.title || '';
  return name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 4).join(' ');
}
function similarHtml() {
  const cfg = CLOUD.config || {};
  if (SIMILAR.key && SIMILAR.key !== storyKey()) SIMILAR = { key: '', q: '', html: '' };
  if (!signedIn() || !cfg.bills || !cfg.bills.states || S.example || !storyKey()) return '';
  return `<section class="panel noprint similar"><span class="label">Similar bills elsewhere</span>
    <p class="note">The same idea in other states and Congress.</p>
    <div class="btnrow"><input id="sim_q" value="${esc(SIMILAR.q || similarWords())}" aria-label="Words to search for" placeholder="A few words about the bill"><button class="btn" data-act="simSearch">Search every state</button></div>
    <div id="sim_out">${SIMILAR.html || ''}</div></section>`;
}
let SIMILAR = { key: '', q: '', html: '' };
async function similarSearch() {
  const q = $('#sim_q').value.trim(), out = $('#sim_out'), mine = billLegislature(), num = billNumberOf();
  if (q.length < 3) { out.innerHTML = '<p class="note">Type a few words.</p>'; return; }
  SIMILAR = { key: storyKey(), q, html: '<p class="note">Searching every state and Congress</p>' }; out.innerHTML = SIMILAR.html;
  const put = (html) => { SIMILAR = { key: storyKey(), q, html }; const o = $('#sim_out'); if (o) o.innerHTML = html; }; // the page may have been redrawn meanwhile
  try {
    const r = await CLOUD.api('GET', `/api/bills/search?${new URLSearchParams({ leg: 'ALL', q })}`);
    const list = r.bills.filter((b) => !(b.leg === mine && b.number.replace(/\W/g, '') === num.replace(/\W/g, '')));
    const html = list.length ? `<ul class="ns-list">${list.map((b) => `<li><div><b>${esc(b.number)}</b> <span class="meta">${esc(legLabel(b.leg))} · ${esc(b.session)}</span><div>${esc(clipWords(b.title, 150))}</div><div class="meta">${esc(b.status)}${b.statusDate ? `, ${esc(fmtDay(b.statusDate))}` : ''}</div></div><button type="button" class="btn sm" data-act="simFollow" data-n="${esc(b.number)}" data-leg="${esc(b.leg)}" data-s="${esc(b.session)}" data-title="${esc(b.title)}">Follow</button></li>`).join('')}</ul>` : '<p class="note">No similar bills found. Try fewer or different words.</p>';
    put(html);
  } catch (e) { put(`<p class="note">${esc(e.message)}</p>`); }
}
function chamberWord(ch) {
  const leg = STORY_LEG || billLegislature();
  if (leg === 'US') return ch === 'upper' ? 'U.S. Senate' : 'U.S. House';
  const c = chambersOf(leg).find((x) => x.chamber === ch) || chambersOf(leg)[0];
  return c ? c.label : ch === 'upper' ? 'Senate' : 'House';
}
// An empty campaign asks which chamber to count, and loads it in one step.
function chamberPicker() {
  if (!canEditNow()) return '<p class="note" style="margin:24px 0">No members yet.</p>';
  const leg = billLegislature(), mine = legChoices(leg);
  if (mine.length) {
    const want = billChamber(billNumberOf(), leg);
    autoChamber();
    return `<div class="pickchamber"><b>${mine.length === 1 ? `Count the ${esc(mine[0].label)}` : `Which ${esc(legName(leg))} chamber?`}</b>
      <p class="note">${want ? `${esc(billNumberOf())} is ${want === 'upper' ? 'a Senate' : `a ${esc((mine.find((x) => x.chamber === 'lower') || { label: 'House' }).label.replace(/^(U\.S\.|[A-Z][a-z]+( [A-Z][a-z]+)?) /, ''))}`} bill, so its members load now.` : 'Choose one to load every current member, with their office and phone number.'}</p>
      <div class="btnrow">${mine.map((c) => `<button class="btn${c.chamber === want ? ' primary' : ''}" data-act="pickChamber" data-v="${esc(c.value)}" data-label="${esc(c.label)}">${esc(c.label)}</button>`).join('')}</div>
      <p class="note" id="q_msg" role="status">Not this one? <button class="linkbtn" data-act="setup">Paste your own list</button>.</p></div>`;
  }
  const { presets, live } = chamberOptions();
  return `<div class="pickchamber"><b>Which chamber are you counting?</b>
    <p class="note">Choose it to load every current member, with their office and phone number.</p>
    <div class="btnrow"><select id="q_chamber" aria-label="Chamber"><option value="">Choose a chamber</option>${presets}${live}</select><button class="btn primary" data-act="quickChamber">Load the members</button></div>
    <p class="note" id="q_msg" role="status">${live ? '' : 'Other states appear here once an admin turns on legislator data. '}Not listed? <button class="linkbtn" data-act="setup">Paste your own list</button>.</p></div>`;
}
async function quickChamber(btn) {
  const v = $('#q_chamber').value, msg = $('#q_msg');
  if (!v) { msg.textContent = 'Choose a chamber first.'; return; }
  btn.disabled = true; msg.textContent = 'Getting the current members';
  try { const label = await fillChamber(v); commit(`${label} loaded`); }
  catch (e) { msg.textContent = e.message; btn.disabled = false; }
}
function loadPreset(key, cmteIdx, backed, st = S) {
  const S = st; // the campaign to fill: the open one unless another is given
  const p = ROSTERS[key], cm = p.committees[cmteIdx], on = new Set(cm ? cm.m : []), titles = (cm && cm.t) || {};
  const start = (party) => (!backed ? 2 : party === backed ? 3 : party === 'I' ? 2 : 1);
  S.members = p.members.map((m) => presetMember(key, p, m, { cmte: on.has(m.k), role: titles[m.k] || '', pos: start(m.p) }));
  const juris = p.juris || { ushouse: { level: 'us', chamber: 'lower' }, ussenate: { level: 'us', chamber: 'upper' }, flhouse: { level: 'state', state: 'FL', chamber: 'lower' }, flsenate: { level: 'state', state: 'FL', chamber: 'upper' } }[key] || null;
  Object.assign(S.campaign, { chamber: p.chamber, committee: cm ? cm.name : '', rule: 'majority', juris });
  if (S.example) S.campaign.bill = 'Your bill';
  S.preset = { key, label: p.label, asOf: p.asOf, stale: !!p.stale, vacant: p.seats - p.members.length };
  S.plan = []; S.trend = []; S.tasks = S.tasks.filter((t) => !t.mid); S.meetings = []; S.brief = blankBrief();
}

// ---------- workspace: campaigns in this browser, or in your account ----------
let S = exampleState();
let view = 'floor', page = 'count', openId = null, renderTimer = null;
const PAGES = ['portfolio', 'bills', 'people', 'count', 'brief', 'monitor', 'contacts', 'workspace'];
let LAST_PAGE = '';
let BOOK = { v: 2, active: 'ex', list: [{ id: 'ex', name: S.campaign.bill }] };
let ME = null, ROLE = 'owner', PEOPLE = {}, JOIN = null;
const ACCOUNT = { list: [], loaded: false };
const LSB = 'headcount.book', LSC = 'headcount.c.', LAST = 'headcount.lastCloud';
const lsGet = (k) => { try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (_) { /* nothing stored */ } };
const valid = (x) => x && x.campaign && Array.isArray(x.members);
const plain = (x) => JSON.parse(JSON.stringify(x));
const signedIn = () => Boolean(window.CLOUD && CLOUD.user && ME);
const canEditNow = () => !S.cloud || ROLE !== 'viewer';
const stamp = (o) => { if (S.cloud && ME) o.by = ME; return o; };
function soon() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); }
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
}

function setSaveState() {
  const el = $('#saveState');
  if (S.cloud) {
    el.textContent = SYNC.loading ? 'Loading' : ROLE === 'viewer' ? 'View only' : SYNC.error ? SYNC.error : SYNC.busy || SYNC.timer || SYNC.creating ? 'Saving' : 'Saved to your account';
    return;
  }
  el.textContent = S.example ? '' : 'Saved in this browser only';
}

// ----- this browser -----
function syncBook() {
  const name = S.campaign.bill || 'Untitled campaign', e = BOOK.list.find((c) => c.id === S.id);
  if (e) e.name = name; else BOOK.list.push({ id: S.id, name });
  BOOK.active = S.id;
}
function saveLocal() { syncBook(); lsSet(LSB, BOOK); lsSet(LSC + S.id, S); }
function loadLocal() {
  const book = lsGet(LSB);
  if (book && Array.isArray(book.list) && book.list.length) {
    const st = lsGet(LSC + book.active) || lsGet(LSC + book.list[0].id);
    if (valid(st)) { BOOK = book; S = normalize(st); delete S.cloud; BOOK.active = S.id; return true; }
  }
  return false;
}
const localIds = () => BOOK.list.map((e) => e.id).filter((id) => { const st = lsGet(LSC + id); return valid(st) && !st.example; });

function save() {
  if (S.cloud) {
    if (ROLE === 'viewer') { cloudRevert(); toast('You have view-only access to this campaign, so that change was not saved.'); return; }
    clearTimeout(SYNC.timer); SYNC.timer = setTimeout(() => { SYNC.timer = null; cloudPush(); }, 400); setSaveState(); return;
  }
  if (S.example && signedIn() && ORG && ORG.role !== 'guest') { delete S.example; adoptIntoAccount(null); return; }
  delete S.example; saveLocal(); setSaveState();
}
async function flushNow() { if (S.cloud && SYNC.timer) { clearTimeout(SYNC.timer); SYNC.timer = null; await cloudPush(); } }

// ----- your account: records sync with the server, merged per member -----
const LISTS = ['members', 'tasks', 'meetings'];
const metaOf = (st) => ({ campaign: st.campaign, preset: st.preset || null });
function newSync(cid) { return { cid, shadow: { meta: null, brief: null, trend: null, summary: null, members: new Map(), tasks: new Map(), meetings: new Map() }, cursor: 0, timer: null, poll: null, busy: false, again: false, loading: false, creating: false, error: '', failures: 0 }; }
let SYNC = newSync(null);

function diffOps(st, sh) {
  const ops = [];
  const one = (kind, data) => { const j = canon(data); if (sh[kind] !== j) ops.push({ kind, data: plain(data), j }); };
  one('meta', metaOf(st)); one('brief', st.brief); one('trend', { points: st.trend }); one('summary', summaryOf(st));
  LISTS.forEach((kind) => {
    const seen = new Set();
    st[kind].forEach((x) => { if (x.draft) return; seen.add(x.id); const j = canon(x); if (sh[kind].get(x.id) !== j) ops.push({ kind, id: x.id, data: plain(x), j }); });
    sh[kind].forEach((_, id) => { if (!seen.has(id)) ops.push({ kind, id, data: null, j: null }); });
  });
  return ops;
}
function shadowSet(sh, op) {
  if (LISTS.includes(op.kind)) { if (op.j === null) sh[op.kind].delete(op.id); else sh[op.kind].set(op.id, op.j); } else sh[op.kind] = op.j;
}
async function sendOps(cid, ops, sh) {
  for (let i = 0; i < ops.length; i += 500) {
    const chunk = ops.slice(i, i + 500);
    await CLOUD.api('POST', `/api/campaigns/${encodeURIComponent(cid)}/records`, { ops: chunk.map(({ kind, id, data }) => ({ kind, id, data })) });
    if (sh) chunk.forEach((op) => shadowSet(sh, op));
  }
}
async function cloudPush() {
  const cid = SYNC.cid;
  if (!S.cloud || S.id !== cid || SYNC.loading || SYNC.creating) return;
  if (SYNC.busy) { SYNC.again = true; return; }
  const ops = diffOps(S, SYNC.shadow);
  if (!ops.length) return setSaveState();
  SYNC.busy = true; setSaveState();
  try {
    await sendOps(cid, ops, SYNC.shadow);
    if (SYNC.cid === cid) { SYNC.error = ''; SYNC.failures = 0; }
  } catch (e) {
    if (SYNC.cid !== cid) return;
    if (e.status === 403) { ROLE = 'viewer'; cloudRevert(); fail(e); }
    else if (e.status === 404) { SYNC.busy = false; return lostCampaign(); }
    else {
      SYNC.failures++; SYNC.error = e.code === 'offline' ? 'Offline: will save when you reconnect' : 'Not saved yet: retrying';
      if (SYNC.failures === 1) fail(e);
      clearTimeout(SYNC.timer); SYNC.timer = setTimeout(() => { SYNC.timer = null; cloudPush(); }, Math.min(30000, 2000 * SYNC.failures));
    }
  } finally {
    if (SYNC.cid === cid) { SYNC.busy = false; if (SYNC.again) { SYNC.again = false; cloudPush(); } setSaveState(); }
  }
}
function cloudRevert() {
  const sh = SYNC.shadow;
  S.members = [...sh.members.values()].map((j) => normMember(JSON.parse(j)));
  S.tasks = [...sh.tasks.values()].map((j) => JSON.parse(j)); S.meetings = [...sh.meetings.values()].map((j) => JSON.parse(j));
  if (sh.meta) { const m = JSON.parse(sh.meta); S.campaign = m.campaign; if (m.preset) S.preset = m.preset; else delete S.preset; }
  if (sh.brief) S.brief = JSON.parse(sh.brief);
  if (sh.trend) S.trend = JSON.parse(sh.trend).points || [];
  closeDrawer(); render();
}
// Applies teammates' changes. A record you changed but have not saved yet is
// left alone; your save follows within a second.
function applyRecords(recs) {
  const sh = SYNC.shadow; let changed = false, openChanged = false;
  recs.forEach((r) => {
    if (LISTS.includes(r.kind)) {
      const list = S[r.kind], i = list.findIndex((x) => x.id === r.id), had = sh[r.kind].has(r.id);
      if (i >= 0 && (!had || canon(list[i]) !== sh[r.kind].get(r.id))) return;
      if (r.data === null) { if (had) { sh[r.kind].delete(r.id); if (i >= 0) { list.splice(i, 1); changed = true; } } return; }
      const body = r.kind === 'members' ? normMember(r.data) : r.data, j = canon(body);
      if (i >= 0) { if (canon(list[i]) !== j) { list[i] = body; changed = true; if (r.id === openId) openChanged = true; } }
      else { list.push(body); changed = true; }
      sh[r.kind].set(r.id, j);
      return;
    }
    if (r.kind === 'summary') { if (r.data !== null) sh.summary = canon(r.data); return; }
    const local = r.kind === 'meta' ? metaOf(S) : r.kind === 'brief' ? S.brief : { points: S.trend };
    if (sh[r.kind] !== null && canon(local) !== sh[r.kind]) return;
    if (r.data === null) return;
    if (r.kind === 'meta') { S.campaign = normalize({ campaign: r.data.campaign || {}, members: [] }).campaign; if (r.data.preset) S.preset = r.data.preset; else delete S.preset; sh.meta = canon(metaOf(S)); }
    else if (r.kind === 'brief') { S.brief = Object.assign(blankBrief(), r.data); sh.brief = canon(S.brief); }
    else { S.trend = Array.isArray(r.data.points) ? r.data.points : []; sh.trend = canon({ points: S.trend }); }
    changed = true;
  });
  return { changed, openChanged };
}
function stopPoll() { clearTimeout(SYNC.poll); SYNC.poll = null; }
function startPoll() {
  stopPoll();
  const cid = SYNC.cid;
  const tick = async () => {
    if (!S.cloud || SYNC.cid !== cid) return;
    if (!document.hidden && !SYNC.loading) {
      try {
        const r = await CLOUD.api('GET', `/api/campaigns/${encodeURIComponent(cid)}/records?since=${SYNC.cursor}`);
        if (SYNC.cid !== cid) return;
        if (r.role !== ROLE) { ROLE = r.role; soon(); }
        if (r.records.length) {
          const { changed, openChanged } = applyRecords(r.records);
          if (changed) soon();
          if (openChanged && !$('#drawer').hidden) toast('A teammate just updated this member. Close and reopen to see the change.');
        }
        SYNC.cursor = Math.max(SYNC.cursor, r.cursor);
        if (SYNC.error && !SYNC.busy && !SYNC.timer) { SYNC.error = ''; SYNC.failures = 0; cloudPush(); setSaveState(); }
      } catch (e) {
        if (SYNC.cid !== cid) return;
        if (e.status === 404) return lostCampaign();
      }
    }
    if (SYNC.cid === cid) SYNC.poll = setTimeout(tick, document.hidden ? 30000 : 4000);
  };
  SYNC.poll = setTimeout(tick, 4000);
}
async function cloudOpen(cid) {
  await flushNow();
  stopPoll(); SYNC = newSync(cid); SYNC.loading = true;
  const known = ACCOUNT.list.find((e) => e.id === cid);
  S = normalize({ id: cid, cloud: true, campaign: { bill: known ? known.name : '' }, members: [] });
  S.cloud = true; ROLE = known ? known.role : 'viewer'; PEOPLE = {}; view = 'floor'; closeDrawer(); render();
  try {
    const r = await CLOUD.api('GET', `/api/campaigns/${encodeURIComponent(cid)}/records?since=0`);
    if (SYNC.cid !== cid) return;
    if (r.orgId && (!ORG || ORG.id !== r.orgId)) await loadOrg(r.orgId, { quiet: true });
    ROLE = r.role; applyRecords(r.records); SYNC.cursor = r.cursor;
  } catch (e) {
    if (SYNC.cid !== cid) return;
    SYNC.loading = false;
    if (e.status === 404) return lostCampaign();
    SYNC.error = 'Could not load: retrying'; render(); fail(e);
    setTimeout(() => { if (SYNC.cid === cid && S.cloud) cloudOpen(cid); }, 8000);
    return;
  }
  SYNC.loading = false; lsSet(LAST, cid); render(); startPoll();
}
// Turns the open campaign into one saved in your account (the example or a
// campaign kept in this browser). Edits made while it uploads are kept.
async function adoptIntoAccount(localId) {
  const cid = uid();
  S.id = cid; S.cloud = true; delete S.example; ROLE = 'owner';
  stopPoll(); SYNC = newSync(cid); SYNC.creating = true; setSaveState();
  try { await CLOUD.api('POST', '/api/campaigns', { id: cid, workspaceId: ORG.id, name: S.campaign.bill, clientId: S.campaign.clientId || undefined }); }
  catch (e) {
    SYNC.creating = false; delete S.cloud; S.id = localId || uid(); saveLocal(); render();
    return toast(`${e.message} The campaign is saved in this browser instead.`);
  }
  if (localId) { lsDel(LSC + localId); BOOK.list = BOOK.list.filter((x) => x.id !== localId); lsSet(LSB, BOOK); }
  ACCOUNT.list.unshift({ id: cid, name: S.campaign.bill, role: 'owner', people: 1 });
  SYNC.creating = false; lsSet(LAST, cid);
  await cloudPush(); startPoll(); render();
}
async function moveLocalToAccount() {
  const ids = localIds(); let moved = 0, first = null;
  if (!S.cloud && ids.includes(S.id)) { first = S.id; await adoptIntoAccount(S.id); moved++; }
  for (const id of ids) {
    if (id === first) continue;
    const st = normalize(lsGet(LSC + id)), cid = uid();
    try {
      await CLOUD.api('POST', '/api/campaigns', { id: cid, workspaceId: ORG.id, name: st.campaign.bill });
      await sendOps(cid, diffOps(st, newSync(cid).shadow), null);
    } catch (e) { fail(e); break; }
    lsDel(LSC + id); BOOK.list = BOOK.list.filter((x) => x.id !== id); lsSet(LSB, BOOK); moved++;
  }
  await refreshAccount();
  if (!S.cloud && ACCOUNT.list.length) await cloudOpen(ACCOUNT.list[0].id);
  render(); toast(`${moved} campaign${moved === 1 ? '' : 's'} moved to your account`);
}
async function refreshAccount() {
  if (!signedIn() || !ORG) return;
  try { const r = await CLOUD.api('GET', `/api/workspaces/${ORG.id}/campaigns`); ACCOUNT.list = r.campaigns; ACCOUNT.loaded = true; soon(); } catch (_) { /* try again later */ }
}
setInterval(() => { if (signedIn() && !document.hidden) refreshAccount(); }, 60000);
async function loadPeople(force) {
  if (!S.cloud || (!force && Object.keys(PEOPLE).length)) return;
  try { const r = await CLOUD.api('GET', `/api/campaigns/${encodeURIComponent(S.id)}/people`); PEOPLE = Object.fromEntries(r.people.map((p) => [p.id, p])); } catch (_) { /* names stay generic */ }
}
function fillNames() {
  const els = [...document.querySelectorAll('#drawer [data-by]')]; if (!els.length) return;
  const put = () => els.forEach((el) => { const p = PEOPLE[el.dataset.by] || (WS.members || []).find((x) => x.id === el.dataset.by); el.textContent = `logged by ${el.dataset.by === ME ? 'you' : (p && p.name) || 'a teammate'}`; });
  put(); if (S.cloud) loadPeople().then(() => (WS.members === null && ORG && ORG.role !== 'guest' ? CLOUD.api('GET', `/api/workspaces/${ORG.id}/members`).then((r) => { WS.members = r.members; }).catch(() => {}) : null)).then(put);
}

async function switchTo(v) {
  await flushNow();
  if (v.startsWith('cloud:')) return cloudOpen(v.slice(6));
  const id = v.slice(6);
  stopPoll(); SYNC = newSync(null);
  const st = lsGet(LSC + id);
  S = valid(st) ? normalize(st) : exampleState(); delete S.cloud;
  BOOK.active = S.id; lsSet(LSB, BOOK); lsDel(LAST); view = 'floor'; closeDrawer(); render();
}
async function addCampaign(st) {
  await flushNow();
  if (signedIn() && ORG) {
    const vis = st.visibility; delete st.visibility;
    try { await CLOUD.api('POST', '/api/campaigns', { id: st.id, workspaceId: ORG.id, name: st.campaign.bill, clientId: st.campaign.clientId || undefined, visibility: vis }); } catch (e) { return fail(e); }
    stopPoll(); S = normalize(st); S.cloud = true; SYNC = newSync(S.id); ROLE = 'owner'; PEOPLE = {};
    ACCOUNT.list.unshift({ id: S.id, name: S.campaign.bill, role: 'owner', people: 1, clientId: S.campaign.clientId, client: clientOf(), visibility: vis === 'team' ? 'team' : 'org' }); lsSet(LAST, S.id);
    view = 'floor'; recordTrend(); await cloudPush(); startPoll(); render(); return;
  }
  if (S.example) BOOK.list = BOOK.list.filter((c) => c.id !== 'ex');
  stopPoll(); SYNC = newSync(null); S = st; view = 'floor'; recordTrend(); save(); render();
}
async function openFallback() {
  if (signedIn() && ORG) { stopPoll(); SYNC = newSync(null); if (!loadLocal()) goExample(); page = 'portfolio'; closeDrawer(); return render(); }
  const ids = localIds();
  stopPoll(); SYNC = newSync(null);
  if (ids.length) { S = normalize(lsGet(LSC + ids[0])); delete S.cloud; BOOK.active = S.id; }
  else goExample();
  closeDrawer(); render();
}
async function lostCampaign() {
  const name = S.campaign.bill;
  stopPoll(); ACCOUNT.list = ACCOUNT.list.filter((x) => x.id !== S.id); lsDel(LAST);
  await refreshAccount(); await openFallback();
  toast(`${name || 'That campaign'} was deleted, or your access to it was removed.`);
}
async function deleteCampaign() {
  if (S.cloud) {
    const cid = S.id;
    try { await CLOUD.api('DELETE', `/api/campaigns/${encodeURIComponent(cid)}`); } catch (e) { return fail(e); }
    stopPoll(); ACCOUNT.list = ACCOUNT.list.filter((x) => x.id !== cid); lsDel(LAST);
    return openFallback();
  }
  const id = S.id;
  BOOK.list = BOOK.list.filter((c) => c.id !== id); lsDel(LSC + id); lsSet(LSB, BOOK);
  return openFallback();
}
function goExample() { S = exampleState(); BOOK.list = BOOK.list.filter((c) => c.id !== 'ex'); BOOK.list.unshift({ id: 'ex', name: S.campaign.bill }); BOOK.active = 'ex'; }

// ----- sign-in -----
async function onAuthChange(user) {
  if (user && !ME) return onSignedIn();
  if (!user && ME) {
    ME = null; OPERATOR = false; MAIL_PROBLEM = null; TWOFA = { on: false, left: null }; ACCOUNT.list = []; ACCOUNT.loaded = false; PEOPLE = {}; ORGS = []; ORG = null; CLIENTS = []; DOMAIN_MATCHES = []; PREFS = null;
    WS.members = WS.invites = WS.audit = WS.report = WS.lastInvite = null;
    if (S.cloud) { stopPoll(); SYNC = newSync(null); if (!loadLocal()) goExample(); }
    if (page === 'portfolio' || page === 'workspace') page = 'count';
    closeDrawer(); render();
  }
}
async function onSignedIn() {
  try { const r = await CLOUD.api('GET', '/api/me'); ME = r.user.id; OPERATOR = Boolean(r.operator); MAIL_PROBLEM = r.emailProblem || null; TWOFA = { on: Boolean(r.user.twoFactor), left: r.recoveryLeft }; ORGS = r.workspaces; DOMAIN_MATCHES = r.domainMatches || []; PREFS = r.prefs; }
  catch (e) { fail(e); return render(); }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })();
  if (tz && PREFS && PREFS.tz !== tz) CLOUD.api('PATCH', '/api/me/prefs', { tz }).then((x) => { PREFS = x; }).catch(() => {});
  if (location.hash === '#email') setTimeout(() => accountDrawer(true), 0);
  const jump = { '#monitor': 'monitor', '#contacts': 'contacts' }[location.hash];
  if (JOIN && JOIN.info) return acceptJoin();
  const blocked = ORGS.filter((o) => o.ssoRequired), tfa = ORGS.filter((o) => o.twoFactorRequired && !o.ssoRequired), open = ORGS.filter((o) => !o.ssoRequired && !o.twoFactorRequired);
  SSO_NEEDED = blocked.length ? blocked.map((o) => o.name).join(' and ') : null;
  TFA_NEEDED = tfa.length ? tfa.map((o) => o.name).join(' and ') : null;
  const want = lsGet(LASTORG), oid = open.some((o) => o.id === want) ? want : open[0] && open[0].id;
  if (oid) await loadOrg(oid, { quiet: true });
  if (!ORG) { page = SSO_NEEDED || TFA_NEEDED ? 'count' : 'workspace'; return render(); }
  if (jump && ORG.role !== 'guest') { page = jump; return render(); }
  // Links in emails open one campaign: #open=<id>, or #open=<id>/brief
  const deep = /^#open=([A-Za-z0-9_.:%-]{1,90})(?:\/(brief|count))?$/.exec(location.hash);
  if (deep) {
    history.replaceState(null, '', location.pathname);
    const id = decodeURIComponent(deep[1]);
    if (ACCOUNT.list.some((e) => e.id === id)) { await cloudOpen(id); if (deep[2] === 'brief') { page = 'brief'; render(); } return; }
    toast('That campaign is not in this workspace, or you no longer have access to it.');
  }
  if (!S.cloud) {
    const last = lsGet(LAST);
    if (last && ACCOUNT.list.some((e) => e.id === last)) return cloudOpen(last);
    if (S.example && ORG && ORG.role !== 'guest') page = 'portfolio'; // their own work, not the invented example
  }
  render();
}
async function acceptJoin() {
  try {
    const r = await CLOUD.api('POST', JOIN.kind === 'org' ? `/api/workspace-invites/${JOIN.code}` : `/api/invites/${JOIN.code}`);
    const info = JOIN.info; JOIN = null; history.replaceState(null, '', '/app');
    ORGS = (await CLOUD.api('GET', '/api/workspaces')).workspaces;
    await loadOrg(r.orgId);
    if (r.campaignId) { await cloudOpen(r.campaignId); toast(`You joined ${info.campaign}`); }
    else { page = 'portfolio'; render(); toast(`Welcome to ${info.workspace}`); }
  } catch (e) { JOIN.error = e.message; render(); }
}
function recordTrend() {
  if (!S.members.length) return;
  const p = goal(S, passage(S.members, baseProbs(S), needs(S)).both);
  const last = S.trend[S.trend.length - 1];
  if (last && last.d === today()) last.p = p; else S.trend.push({ d: today(), p });
  if (S.trend.length > 90) S.trend = S.trend.slice(-90);
}
function commit(msg) { recordTrend(); save(); render(); if (msg) toast(msg); }
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
function copyText(v, fallbackEl) {
  const fail = () => { if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); toast('Copy is blocked here. The text is selected: copy it by hand.'); } else toast('Copy is blocked here. Select the text instead.'); };
  try { navigator.clipboard.writeText(v).then(() => toast('Copied'), fail); } catch (_) { fail(); }
}

// ---------- rendering ----------
const fmtDay = (d) => { const t = Date.parse(d + 'T00:00:00'); return Number.isNaN(t) ? d : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const inDays = (d) => { const n = dayDiff(d); return n === 0 ? 'today' : n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`; };
const lastContact = (m) => { for (let i = m.history.length - 1; i >= 0; i--) if (m.history[i].type !== 'Count update') return m.history[i]; return null; };
function seatLayout(n) {
  const rowsN = n <= 15 ? 2 : n <= 45 ? 3 : n <= 90 ? 4 : n <= 160 ? 5 : n <= 300 ? 7 : 10;
  const radii = Array.from({ length: rowsN }, (_, i) => 118 + (i * (268 - 118)) / Math.max(1, rowsN - 1));
  const tot = radii.reduce((a, b) => a + b, 0);
  const counts = radii.map((r) => Math.round((n * r) / tot));
  counts[rowsN - 1] += n - counts.reduce((a, b) => a + b, 0);
  const seats = [];
  radii.forEach((r, ri) => { for (let i = 0; i < counts[ri]; i++) { const a = Math.PI - (Math.PI * (i + 0.5)) / counts[ri]; seats.push({ a, x: 300 + r * Math.cos(a), y: 300 - r * Math.sin(a) }); } });
  const gap = rowsN > 1 ? radii[1] - radii[0] : 60;
  const size = Math.max(2.5, Math.min(gap / 2 - 3, (Math.PI * radii[0]) / Math.max(1, counts[0]) / 2 - 2, 20));
  return { seats: seats.sort((p, q) => q.a - p.a), size };
}
const HEMI = { id: null, pos: null, short: null };
function renderHemi(nd) {
  if (!S.members.length) { $('#hemi').innerHTML = SYNC.loading ? '<p class="note" style="margin:24px 0">Loading the campaign.</p>' : chamberPicker(); $('#tally').innerHTML = ''; $('#path').textContent = ''; return; }
  const order = S.members.slice().sort((a, b) => b.pos - a.pos || (PARTY_ORDER[a.party] ?? 1) - (PARTY_ORDER[b.party] ?? 1));
  const { seats, size } = seatLayout(order.length);
  const inView = (m) => view === 'floor' || m.cmte;
  const grp = S.members.filter(inView), cnt = (p) => grp.filter((m) => m.pos === p).length;
  const need = view === 'floor' ? nd.needF : nd.needC, defeat = dirOf(S) < 0;
  const have = defeat ? cnt(0) + cnt(1) : cnt(4) + cnt(3), target = defeat ? grp.length - need + 1 : need, where = view === 'floor' ? 'on the floor' : 'in committee';
  const prev = HEMI.id === S.id ? HEMI.pos : null, intro = HEMI.id !== S.id;
  HEMI.pos = new Map(S.members.map((m) => [m.id, m.pos])); HEMI.id = S.id;
  $('#hemi').innerHTML = `<svg class="${intro ? 'intro' : ''}" viewBox="0 0 600 322" style="--sw:${Math.min(2, size / 4).toFixed(2)}px" role="group" aria-label="Seating chart coloured by position">
    ${order.map((m, i) => `<circle class="seat p${m.pos}${m.cmte ? ' cmte' : ''}${inView(m) ? '' : ' dim'}${prev && prev.has(m.id) && prev.get(m.id) !== m.pos ? ' pop' : ''}" style="--i:${i}" cx="${seats[i].x.toFixed(1)}" cy="${seats[i].y.toFixed(1)}" r="${size.toFixed(1)}" tabindex="0" role="button" data-open="${esc(m.id)}" aria-label="${esc(m.name)}, ${POS[m.pos]}"><title>${esc(m.name)} (${esc(m.party)}-${esc(m.district)}): ${POS[m.pos]}</title></circle>`).join('')}
    <text class="hub" x="300" y="268" text-anchor="middle" font-size="46" font-weight="800">${grp.length ? have : 0}<tspan font-size="22" font-weight="500"> / ${grp.length ? target : 0}</tspan></text>
    <text class="hub small" x="300" y="292" text-anchor="middle" font-size="13">${defeat ? 'no and lean no / needed to block' : 'yes and lean yes / needed'}${view === 'cmte' ? ' in committee' : ''}</text>
  </svg>`;
  if (!grp.length) { $('#tally').innerHTML = '<p class="note" style="margin-top:10px">No committee members marked yet. Tick "Sits on the committee" on a member.</p>'; $('#path').textContent = ''; return; }
  const total = grp.length, left = (need / total) * 100;
  $('#tally').innerHTML = `<div class="tallywrap"><div class="tally" style="margin-top:0">${[4, 3, 2, 1, 0].map((p) => `<i class="b${p}" style="width:${(cnt(p) / total) * 100}%"></i>`).join('')}</div>
    <div class="need${left > 70 ? ' flip' : ''}" style="left:${left}%"><span>${need} to pass</span></div></div>
    <div class="legend">${[4, 3, 2, 1, 0].map((p) => `<span><span class="dot b${p}"></span>${POS[p]} <b>${cnt(p)}</b></span>`).join('')}${nd.c ? `<span>Outlined seats sit on ${esc(S.campaign.committee || 'the committee')}</span>` : ''}</div>`;
  const short = target - have, soft = defeat ? cnt(1) : cnt(3), play = cnt(2) + (defeat ? cnt(3) : cnt(1));
  // Reaching the votes you need, after a change you made: a small celebration.
  if (view === 'floor' && prev && HEMI.short > 0 && short <= 0) setTimeout(() => toast(defeat ? 'You have enough votes to block it.' : 'You have the votes to pass it.'), 250);
  if (view === 'floor') HEMI.short = short;
  $('#path').innerHTML = short > 0
    ? `Counting leaners you are <b>${short} short</b> ${defeat ? 'of blocking it ' : ''}${where}. ${play} undecided or leaning against you are in play.`
    : `Counting leaners you have <b>${-short} to spare</b> ${where}${defeat ? ' to block it' : ''}. ${soft} of your votes are only leaning.`;
}
function movesList(days) {
  const from = daysAgo(days), out = [], dir = dirOf(S);
  S.members.forEach((m) => m.history.forEach((h) => { if (h.d >= from && h.from !== h.to) out.push({ m, h, good: (h.to - h.from) * dir > 0 }); }));
  return out.sort((a, b) => (a.h.d < b.h.d ? 1 : -1));
}
function renderOdds(nd, base) {
  const defeat = dirOf(S) < 0;
  $('#oddsLabel').textContent = defeat ? 'Odds of defeating it today' : 'Odds of passage today';
  const oe = $('#odds');
  if (!S.members.length) { oe.innerHTML = '<small>No members yet</small>'; oe.className = 'big'; delete oe.dataset.v; }
  else {
    const to = pct(goal(S, base.both)), from = oe.dataset.v === undefined || oe.dataset.id !== S.id ? to : +oe.dataset.v;
    oe.dataset.v = to; oe.dataset.id = S.id;
    const n = goal(S, base.both) * 100;
    oe.className = `big ${n >= 60 ? 'good' : n >= 35 ? 'mid' : 'low'}`;
    const paint = (v) => { oe.innerHTML = `${v}<small>%</small>`; };
    if (from === to || REDUCED || !/^\d+$/.test(String(to)) || !/^\d+$/.test(String(from))) paint(to);
    else {
      oe.classList.add('bump'); setTimeout(() => oe.classList.remove('bump'), 500);
      const t0 = performance.now(), tick = (t) => { const k = Math.min(1, (t - t0) / 650), e = 1 - Math.pow(1 - k, 3); paint(Math.round(from + (to - from) * e)); if (k < 1 && oe.dataset.v == to) requestAnimationFrame(tick); else paint(oe.dataset.v); };
      requestAnimationFrame(tick);
    }
  }
  $('#stages').innerHTML = !S.members.length ? '<p class="note">The odds appear once the chamber is loaded and you mark where members stand.</p>' : defeat
    ? `<div class="stage"><b>${nd.c ? pct(1 - base.cm) + '%' : 'n/a'}</b><span>Stopped in committee (${nd.c - nd.needC + 1} of ${nd.c} to block)</span></div><div class="stage"><b>${pct(1 - base.fl)}%</b><span>Fails on the floor (${nd.n - nd.needF + 1} of ${nd.n} to block)</span></div>`
    : `<div class="stage"><b>${nd.c ? pct(base.cm) + '%' : 'n/a'}</b><span>Clears committee (${nd.needC} of ${nd.c})</span></div><div class="stage"><b>${pct(base.fl)}%</b><span>Wins the floor (${nd.needF} of ${nd.n})</span></div>`;
  const now = goal(S, base.both);
  const pts = S.trend.slice(-30).concat(S.trend.length && S.trend[S.trend.length - 1].d === today() ? [] : [{ d: today(), p: now }]);
  if (pts.length < 2 || !S.members.length) $('#spark').innerHTML = '<p class="note">The trend appears after a second day of changes.</p>';
  else {
    const X = (i) => 6 + (i * 288) / (pts.length - 1), Y = (p) => 62 - p * 54;
    const line = pts.map((t, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(t.p).toFixed(1)}`).join(' ');
    const e = pts[pts.length - 1];
    $('#spark').innerHTML = `<svg viewBox="0 0 300 70" preserveAspectRatio="none" role="img" aria-label="Odds from ${pct(pts[0].p)}% on ${pts[0].d} to ${pct(e.p)}% today">
      <line x1="6" x2="294" y1="${Y(0.5)}" y2="${Y(0.5)}" stroke="var(--line)" stroke-dasharray="3 4" fill="none"/>
      <path d="${line} L294 66 L6 66 Z" fill="var(--soft)" stroke="none"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(pts.length - 1)}" cy="${Y(e.p)}" r="3.5" fill="var(--accent)"/></svg>
      <div class="row note"><span>${esc(fmtDay(pts[0].d))}: ${pct(pts[0].p)}%</span><span>Dashed line is 50%</span><span>Today: ${pct(e.p)}%</span></div>`;
  }
  const mv = movesList(7);
  $('#moves').innerHTML = mv.length ? mv.slice(0, 6).map(({ m, h, good }) => `<li><span class="${good ? 'good' : 'bad'}">${good ? 'Toward you' : 'Away'}</span> · <button class="linkbtn" data-open="${esc(m.id)}">${esc(m.name)}</button>: ${POS[h.from]} to ${POS[h.to]} <span class="note">${esc(fmtDay(h.d))}</span></li>`).join('') + (mv.length > 6 ? `<li class="note">and ${mv.length - 6} more</li>` : '')
    : '<li class="note">No position changes logged this week.</li>';
}
function renderCalls(nd, base) {
  const list = callSheet(S, nd, base);
  const ids = new Set(list.map((r) => r.m.id));
  S.plan = S.plan.filter((id) => ids.has(id));
  $('#calls').innerHTML = list.length ? list.map((r) => {
    const m = r.m, lc = lastContact(m);
    const why = [`${POS[m.pos]} now`, m.role ? `${m.role} of the committee` : m.cmte ? 'votes in committee' : '', r.followers ? `${r.followers} take${r.followers === 1 ? 's' : ''} cues from them` : '', m.interests ? `cares about ${m.interests}` : ''].filter(Boolean).join(' · ');
    return `<li><input type="checkbox" id="pl_${esc(m.id)}" data-plan="${esc(m.id)}" ${S.plan.includes(m.id) ? 'checked' : ''} aria-label="Add ${esc(m.name)} to plan">
      <div><button class="who" data-open="${esc(m.id)}">${verbFor(S, m)} ${esc(m.name)}</button> <span class="note">${esc(m.party)}-${esc(m.district)}</span><div class="why">${esc(why)}</div>
      <div class="why">${contact(m).phone ? `<span class="tel">${esc(contact(m).phone)}</span> · ` : ''}${lc ? `last contact ${esc(inDays(lc.d))}` : 'never contacted'}</div></div>
      <div class="gain">+${(r.gain * 100).toFixed(1)} pts<small>movable ${m.mov}/5</small></div></li>`;
  }).join('') : `<li style="display:block" class="note">${S.members.length ? 'No single meeting moves the odds right now.' : 'The call sheet fills in once the campaign has a roster.'}</li>`;
  const plan = $('#plan');
  if (S.plan.length) {
    const p = passage(S.members, nudged(S, baseProbs(S), S.plan), nd).both;
    plan.innerHTML = `If the ${S.plan.length} ticked meeting${S.plan.length > 1 ? 's' : ''} each move one step: <b>${pct(goal(S, base.both))}% to ${pct(goal(S, p))}%</b>`;
  } else plan.innerHTML = 'Tick meetings to see where the odds land if they all go your way.';
}
function assignSelect(id, name, value) {
  const people = (WS.members || []).filter((x) => x.id !== ME && x.role !== 'guest');
  return `<select id="${id}" name="${name}" aria-label="For"><option value="">For anyone</option><option value="${esc(ME)}" ${value === ME ? 'selected' : ''}>For me</option>${people.map((x) => `<option value="${esc(x.id)}" ${value === x.id ? 'selected' : ''}>For ${esc(x.name || x.email)}</option>`).join('')}</select>`;
}
const whoFor = (t) => (!t.assignee ? '' : t.assignee === ME ? 'for you' : `for ${((WS.members || []).find((x) => x.id === t.assignee) || PEOPLE[t.assignee] || { name: 'a teammate' }).name}`);
function ensureMembers() {
  if (!S.cloud || !ORG || ORG.role === 'guest' || WS.members !== null || WS.loadingMembers) return;
  WS.loadingMembers = true;
  CLOUD.api('GET', `/api/workspaces/${ORG.id}/members`).then((r) => { WS.members = r.members; soon(); }).catch(() => {}).finally(() => { WS.loadingMembers = false; });
}
function taskHtml(t) {
  const m = t.mid && S.members.find((x) => x.id === t.mid), n = t.due ? dayDiff(t.due) : null;
  return `<li><input type="checkbox" data-task="${esc(t.id)}" ${t.done ? 'checked' : ''} aria-label="Mark done: ${esc(t.text)}">
    <div><div>${esc(t.text)}</div><div class="due${n !== null && n < 0 && !t.done ? ' over' : ''}">${t.due ? `${n < 0 && !t.done ? 'Overdue, was due ' : 'Due '}${esc(fmtDay(t.due))} (${esc(inDays(t.due))})` : 'No due date'}${m ? ` · <button class="linkbtn" data-open="${esc(m.id)}">${esc(m.name)}</button>` : ''}${t.assignee ? ` · <b>${esc(whoFor(t))}</b>` : ''}</div></div></li>`;
}
const openTasks = () => S.tasks.filter((t) => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
function renderTasks() {
  const tf = $('#t_for');
  if (tf) { tf.hidden = !S.cloud || !signedIn(); if (S.cloud && signedIn()) { const v = tf.value; tf.outerHTML = assignSelect('t_for', 'for', v); } ensureMembers(); }
  const open = openTasks(), done = S.tasks.filter((t) => t.done).slice(-8).reverse();
  $('#tasks').innerHTML = (open.length ? open.map(taskHtml).join('') : upcoming().length ? '' : '<li style="display:block" class="note">Nothing scheduled. Request a meeting from any member, or add a follow-up.</li>')
    + (done.length ? `<li style="display:block"><details><summary class="note">Recently completed (${done.length})</summary><ul class="tasks">${done.map(taskHtml).join('')}</ul></details></li>` : '');
}
function lastTouch(m) { const h = m.history[m.history.length - 1]; return h ? `${fmtDay(h.d)} · ${h.type}${h.who ? ` (${h.who})` : ''}` : 'None logged'; }
function renderRows() {
  const q = $('#q').value.trim().toLowerCase(), raw = $('#fGroup').value, fp = /^p\d$/.test(raw) ? raw[1] : '', fg = fp ? '' : raw, so = 'pos';
  const group = (m) => !fg || (fg === 'cmte' ? m.cmte : fg === 'cold' ? !lastContact(m) : fg === 'staff' ? m.staffers.length > 0 : m.party === fg);
  const touch = (m) => { const h = lastContact(m); return h ? h.d : ''; };
  const sorts = { pos: (a, b) => b.pos - a.pos || a.name.localeCompare(b.name), name: (a, b) => a.name.localeCompare(b.name), dist: (a, b) => String(a.district).localeCompare(String(b.district), undefined, { numeric: true }), touch: (a, b) => touch(a).localeCompare(touch(b)) || a.name.localeCompare(b.name) };
  const list = S.members.filter((m) => (!fp || m.pos === +fp) && group(m) && (!q || `${m.name} ${m.district} ${m.interests} ${m.party} ${m.role || ''}`.toLowerCase().includes(q))).sort(sorts[so] || sorts.pos);
  $('#rowCount').textContent = list.length === S.members.length ? '' : `Showing ${list.length} of ${S.members.length} members`;
  $('#rows').innerHTML = list.length ? list.map((m) => `<tr>
    <td><button class="who" data-open="${esc(m.id)}">${esc(m.name)}</button><div class="meta">${esc(m.party)}-${esc(m.district)}${m.role ? ` · ${esc(m.role)}` : m.cmte ? ' · committee' : ''}${contact(m).phone ? ` · <span class="tel">${esc(contact(m).phone)}</span>` : ''}${m.staffers.length ? ` · ${m.staffers.length} staff` : ''}${typeof actCount === 'function' ? actCount(m) : ''}</div></td>
    <td style="white-space:nowrap"><span class="dot b${m.pos}"></span><select data-pos="${esc(m.id)}" aria-label="Position of ${esc(m.name)}">${[4, 3, 2, 1, 0].map((p) => `<option value="${p}" ${m.pos === p ? 'selected' : ''}>${POS[p]}</option>`).join('')}</select></td>
    <td><span class="pips" aria-label="${m.mov} of 5">${'●'.repeat(m.mov)}<i>${'●'.repeat(5 - m.mov)}</i></span></td>
    <td class="meta">${esc(lastTouch(m))}</td></tr>`).join('') : `<tr><td colspan="4" class="note">${S.members.length ? 'No members match.' : 'No members yet.'}</td></tr>`;
}
// ---------- bill brief: one per campaign ----------
function blankBrief() {
  return { number: '', title: '', jurisdiction: '', session: '', sponsors: '', status: '', committees: '', introduced: '', url: '', officialSummary: '', officialSummaryLabel: '', source: '', fetchedAt: '',
    plainSummary: '', keyProvisions: [], whoItAffects: '', fiscalImpact: '', supporters: '', opponents: '', talkingPoints: [], objections: [], needsChecking: [], draftedAt: '' };
}
function exampleBrief() {
  return Object.assign(blankBrief(), {
    number: 'SB 214', title: 'Rural Broadband Expansion Act', jurisdiction: 'State Senate (example)', session: '2027 regular session',
    sponsors: 'Sen. Harlan Buckley (R-5); Sen. Marisol Vega (D-4)', status: 'Referred to Commerce & Utilities', committees: 'Commerce & Utilities',
    plainSummary: 'Creates a state grant program for internet providers that build high-speed service in rural areas with no broadband today. Grants cover up to 60 percent of build-out costs, and recipients must offer a low-cost plan for ten years.',
    keyProvisions: ['Creates the Rural Broadband Grant Program in the Department of Commerce.', 'Caps each grant at 60 percent of eligible construction costs.', 'Requires grant recipients to offer a low-cost service tier for ten years.', 'Directs the department to publish a map of unserved areas each year.'],
    whoItAffects: 'Rural households and businesses without broadband, internet providers and electric co-ops that apply for grants, and the Department of Commerce, which runs the program.',
    fiscalImpact: 'Appropriates $40 million a year for five years from the general fund.',
    supporters: 'Rural electric co-ops, the farm bureau, rural hospital associations.', opponents: 'Some incumbent carriers; members concerned about the appropriation.',
    talkingPoints: ['Thousands of rural homes in member districts have no broadband provider today.', 'The state pays at most 60 percent; providers carry the rest of the risk.', 'The low-cost tier keeps service affordable for ten years.'],
    objections: [{ objection: 'The state should not subsidize private companies.', response: 'Grants only go where no provider has built, and recipients must keep a low-cost plan for a decade.' }, { objection: '$200 million is too much.', response: 'The appropriation can be phased, and the cap keeps the state share at 60 percent or less.' }],
    needsChecking: ['Current count of unserved locations by district.'],
  });
}
let briefEdit = false, briefPanel = '';
const hasBrief = (b) => Boolean(b && (b.number || b.title || b.plainSummary || b.officialSummary));
const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
function firstSentences(text, max = 260) {
  // CRS summaries open with the bill's short title on a line of its own ("CLARITY Act of 2025"); skip it.
  const ls = String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (ls.length > 1 && !/[.!?:]$/.test(ls[0]) && ls[0].length < 160) ls.shift();
  const t = ls.join(' ').replace(/\s+/g, ' ').trim(); if (!t) return '';
  const m = t.match(/^(.{40,}?[.!?])(\s|$)/); const s = m ? m[1] : t;
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}
const briefSummaryLine = (b) => firstSentences(b.plainSummary || b.officialSummary);
const billLabel = (b) => (b.number ? `${b.number}${b.title ? ` (${b.title})` : ''}` : S.campaign.bill || 'the bill');
function guessJurisdiction() {
  const t = `${S.brief.jurisdiction} ${S.campaign.chamber}`;
  if (/U\.?S\.|Congress|United States/i.test(t)) return 'US';
  const states = (CLOUD.config && CLOUD.config.states) || {};
  const hit = Object.entries(states).find(([, name]) => new RegExp(`\\b${name}\\b`, 'i').test(t));
  return hit ? hit[0] : 'US';
}

function briefDoc(b) {
  const c = S.campaign, sec = (title, body) => (body ? `<section><h3>${title}</h3>${body}</section>` : '');
  const list = (arr, tag = 'ul') => (arr.length ? `<${tag}>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</${tag}>` : '');
  const para = (s) => (s ? `<p>${esc(s)}</p>` : '');
  const facts = [['Sponsors', b.sponsors], ['Status', b.status], ['Committee', b.committees], ['Introduced', b.introduced]].filter((x) => x[1]);
  return `<article class="brief">
    <div><div class="eyebrow">Bill brief${b.jurisdiction ? ` · ${esc(b.jurisdiction)}` : ''}${b.session ? ` · ${esc(b.session)}` : ''}</div>
    <h2>${esc(b.number || '')}${b.number && b.title ? ': ' : ''}${esc(b.title || (b.number ? '' : c.bill))}</h2></div>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    <div class="position"><b>Our position:</b> we ${c.side === 'defeat' ? 'oppose' : 'support'} this bill${clientOf() ? ` on behalf of ${esc(clientOf())}` : ''}.${c.ask ? ` <b>The ask:</b> ${esc(c.ask)}.` : ''}</div>
    ${b.draftedAt ? `<p class="draftnote noprint">The analysis below was drafted by AI (Claude) on ${esc(fmtDay(b.draftedAt.slice(0, 10)))} from the bill material. Check every point against the bill before you rely on it.</p>` : ''}
    ${sec('Summary', para(b.plainSummary || firstSentences(b.officialSummary, 900)))}
    ${sec('What it does', list(lines(b.keyProvisions)))}
    ${sec('Who it affects', para(b.whoItAffects))}
    ${sec('Fiscal impact', para(b.fiscalImpact))}
    ${sec('Support and opposition', `${b.supporters ? `<p><b>Supporters:</b> ${esc(b.supporters)}</p>` : ''}${b.opponents ? `<p><b>Opponents:</b> ${esc(b.opponents)}</p>` : ''}`)}
    ${sec('Talking points', list(lines(b.talkingPoints), 'ol'))}
    ${sec('Likely objections and responses', (b.objections || []).filter((o) => o.objection).map((o) => `<div class="obj"><b>${esc(o.objection)}</b><span>${esc(o.response || '')}</span></div>`).join(''))}
    ${sec('Check before use', list(lines(b.needsChecking)))}
    ${b.officialSummary ? sec(esc(b.officialSummaryLabel || 'Official summary'), `<p style="white-space:pre-wrap">${esc(b.officialSummary)}</p>`) : ''}
    <p class="src">${b.source ? `Bill details from ${esc(b.source)}${b.fetchedAt ? `, retrieved ${esc(fmtDay(b.fetchedAt.slice(0, 10)))}` : ''}. ` : ''}${/^https:\/\//.test(b.url || '') ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">Read the bill</a>. ` : ''}Prepared ${esc(fmtDay(today()))}${c.me ? ` by ${esc(c.me)}` : ''}.</p>
  </article>`;
}
function briefFormHtml(b) {
  const f = (id, label, val, wide) => `<label${wide ? ' class="wide"' : ''}>${label}<input id="bf_${id}" name="${id}" value="${esc(val || '')}"></label>`;
  const ta = (id, label, val, hint) => `<label class="wide">${label}${hint ? ` <span class="note">${hint}</span>` : ''}<textarea id="bf_${id}" name="${id}">${esc(val || '')}</textarea></label>`;
  return `<div class="panel briefform"><form id="bfForm" class="form">
    ${f('number', 'Bill number', b.number)}${f('title', 'Title', b.title)}
    ${f('jurisdiction', 'Legislature', b.jurisdiction)}${f('session', 'Session', b.session)}
    ${f('sponsors', 'Sponsors', b.sponsors, true)}${f('status', 'Status', b.status)}${f('committees', 'Committee', b.committees)}
    ${f('url', 'Link to the bill', b.url, true)}
    ${ta('plainSummary', 'Summary', b.plainSummary)}
    ${ta('keyProvisions', 'What it does', lines(b.keyProvisions).join('\n'), 'one per line')}
    ${ta('whoItAffects', 'Who it affects', b.whoItAffects)}${ta('fiscalImpact', 'Fiscal impact', b.fiscalImpact)}
    ${f('supporters', 'Supporters', b.supporters, true)}${f('opponents', 'Opponents', b.opponents, true)}
    ${ta('talkingPoints', 'Talking points', lines(b.talkingPoints).join('\n'), 'one per line')}
    ${ta('objections', 'Likely objections', (b.objections || []).map((o) => `${o.objection}\n${o.response}`).join('\n\n'), 'objection on the first line, response below it, blank line between each')}
    ${ta('needsChecking', 'Check before use', lines(b.needsChecking).join('\n'), 'one per line')}
    ${ta('officialSummary', 'Official summary', b.officialSummary)}
    <div class="wide btnrow"><button class="btn primary">Save brief</button><button type="button" class="btn" data-act="briefCancel">Cancel</button></div>
  </form></div>`;
}
function briefPanelHtml() {
  const cfg = CLOUD.config || {}, states = cfg.states || {};
  if (briefPanel === 'lookup') {
    const ok = (cfg.bills && (cfg.bills.federal || cfg.bills.states));
    return `<div class="panel noprint" style="max-width:860px;margin:0 auto 14px"><form id="lkForm" class="form">
      <label>Legislature<select id="lk_j" name="j"><option value="US">U.S. Congress</option>${Object.entries(states).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <label>Bill number<input id="lk_n" name="n" required placeholder="H.R. 1234, S. 56, HB 123" value="${esc(S.brief.number || '')}"></label>
      <label>Congress or session <span class="note">optional</span><input id="lk_s" name="s" placeholder="119, or 2026"></label>
      <div class="wide btnrow"><button class="btn primary">Look it up</button><button type="button" class="btn" data-act="briefPanelOff">Cancel</button></div>
      <p class="wide note">${!signedIn() ? 'Sign in to look up bills.' : !ok ? 'Bill lookup is not turned on yet (an admin adds it under Admin settings), so fill in the brief by hand.' : `Federal bills come from Congress.gov${cfg.bills.states ? ' and state bills from Open States' : ''}. This fills in the bill's details and official summary and keeps your analysis.`}</p>
    </form></div>`;
  }
  if (briefPanel === 'draft') {
    return `<div class="panel noprint" style="max-width:860px;margin:0 auto 14px"><form id="dfForm" class="form">
      <p class="wide note">AI (Claude) drafts the summary, what the bill does, talking points and likely objections, working only from the official summary and anything you paste here. It argues for your position: ${S.campaign.side === 'defeat' ? 'defeat' : 'pass'} the bill${S.campaign.ask ? `, with the ask "${esc(S.campaign.ask)}"` : ''}. Check every point before you use it.</p>
      <label class="wide">Bill text, analysis or notes <span class="note">optional</span><textarea id="df_text" name="material" style="min-height:150px" placeholder="Paste the bill text or a committee analysis for a better draft"></textarea></label>
      <div class="wide btnrow"><button class="btn primary" id="dfGo">${hasBrief(S.brief) && (S.brief.plainSummary || lines(S.brief.talkingPoints).length) ? 'Draft and replace my analysis' : 'Draft it'}</button><button type="button" class="btn" data-act="briefPanelOff">Cancel</button><span class="note" id="dfMsg"></span></div>
    </form></div>`;
  }
  return '';
}
function renderBrief() {
  const b = S.brief, ro = !canEditNow(), cfg = CLOUD.config || {};
  const tools = `<div class="brieftools noprint">${ro ? '' : `<button class="btn" data-act="briefEdit">${hasBrief(b) ? 'Edit' : 'Write it by hand'}</button><button class="btn" data-act="briefLookup">Look up the bill</button>${cfg.ai ? '<button class="btn" data-act="briefDraft">Draft it with AI</button>' : ''}`}${hasBrief(b) ? '<button class="btn" data-act="briefCopy">Copy as text</button><button class="btn" data-act="briefPrint">Print or save as PDF</button>' : ''}${typeof intelBriefButtons === 'function' ? intelBriefButtons(b) : ''}</div>`;
  const empty = `<div class="brief" style="text-align:center"><h2 style="font-size:22px">No brief for this bill yet</h2><p class="note" style="margin:0 auto">Look up the bill to fill in its sponsors, status and summary. Then add your talking points.</p></div>`;
  $('#briefPage').innerHTML = briefEdit ? briefFormHtml(b) : tools + briefPanelHtml() + storyPanelHtml() + (hasBrief(b) ? briefDoc(b) : empty) + similarHtml();
  loadStory();
  if (briefPanel === 'lookup' && $('#lk_j')) $('#lk_j').value = guessJurisdiction();
}
function briefPlain(b) {
  const c = S.campaign, out = [];
  out.push(`BILL BRIEF: ${b.number || ''}${b.number && b.title ? ': ' : ''}${b.title || ''}`.trim());
  [['Legislature', [b.jurisdiction, b.session].filter(Boolean).join(', ')], ['Sponsors', b.sponsors], ['Status', b.status], ['Committee', b.committees]].forEach(([k, v]) => { if (v) out.push(`${k}: ${v}`); });
  out.push('', `Our position: we ${c.side === 'defeat' ? 'oppose' : 'support'} this bill${clientOf() ? ` on behalf of ${clientOf()}` : ''}.${c.ask ? ` The ask: ${c.ask}.` : ''}`);
  const block = (t, body) => { if (body && body.length) out.push('', t.toUpperCase(), ...[].concat(body)); };
  block('Summary', b.plainSummary || firstSentences(b.officialSummary, 900));
  block('What it does', lines(b.keyProvisions).map((x) => `- ${x}`));
  block('Who it affects', b.whoItAffects); block('Fiscal impact', b.fiscalImpact);
  block('Support and opposition', [b.supporters && `Supporters: ${b.supporters}`, b.opponents && `Opponents: ${b.opponents}`].filter(Boolean));
  block('Talking points', lines(b.talkingPoints).map((x, i) => `${i + 1}. ${x}`));
  block('Likely objections and responses', (b.objections || []).filter((o) => o.objection).map((o) => `- ${o.objection}\n  ${o.response}`));
  block('Check before use', lines(b.needsChecking).map((x) => `- ${x}`));
  if (b.url) out.push('', `Read the bill: ${b.url}`);
  return out.join('\n');
}
function billLines() {
  const b = S.brief; if (!hasBrief(b)) return [];
  const pts = lines(b.talkingPoints).slice(0, 3), obj = (b.objections || []).filter((o) => o.objection).slice(0, 2);
  return ['THE BILL', `${billLabel(b)}${b.status ? `. Status: ${b.status}` : ''}`, briefSummaryLine(b) || null,
    ...(pts.length ? ['Talking points:', ...pts.map((x) => `- ${x}`)] : []),
    ...(obj.length ? ['If they object:', ...obj.map((o) => `- ${o.objection} ${o.response}`)] : []), ''].filter((l) => l !== null);
}
async function lookupBill(form) {
  const fd = new FormData(form), msgEl = form.querySelector('.note:last-child');
  if (!signedIn()) return toast('Sign in to look up bills.');
  const btn = form.querySelector('.primary'), key = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const b0 = S.brief, analysis = b0.plainSummary || lines(b0.talkingPoints).length || (b0.objections || []).length;
  const other = b0.number && key(b0.number) !== key(fd.get('n'));
  if (other && analysis && btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = 'Look it up and clear the old analysis'; if (msgEl) msgEl.textContent = `This is a different bill from ${b0.number}. The summary, talking points and objections written for ${b0.number} will be cleared.`; return; }
  btn.disabled = true; btn.textContent = 'Looking it up';
  try {
    const q = new URLSearchParams({ jurisdiction: fd.get('j'), number: String(fd.get('n')).trim() }); if (String(fd.get('s') || '').trim()) q.set('session', String(fd.get('s')).trim());
    const r = await CLOUD.api('GET', `/api/bills/lookup?${q}`);
    fillBrief(r, other);
    briefPanel = ''; save(); render(); toast(`${r.number} filled in from ${r.source}`);
  } catch (e) { btn.disabled = false; btn.textContent = 'Look it up'; btn.dataset.sure = ''; if (msgEl) msgEl.textContent = e.message; else fail(e); }
}
function fillBrief(r, other) {
    const b = S.brief;
    if (other) { const blank = blankBrief(); ['plainSummary', 'keyProvisions', 'whoItAffects', 'fiscalImpact', 'supporters', 'opponents', 'talkingPoints', 'objections', 'needsChecking', 'draftedAt'].forEach((k) => { b[k] = blank[k]; }); }
    Object.assign(b, { number: r.number, title: r.title, jurisdiction: r.jurisdiction, session: r.session,
      sponsors: r.sponsors.map((s) => `${s.name}${!/\[/.test(s.name) && (s.party || s.district) ? ` (${[s.party, s.district].filter(Boolean).join('-')})` : ''}`).join('; ') + (r.cosponsors ? `; ${r.cosponsors} cosponsor${r.cosponsors === 1 ? '' : 's'}` : ''),
      status: r.latestAction ? `${r.latestAction.text}${r.latestAction.date ? ` (${r.latestAction.date})` : ''}` : '', committees: r.committees.join('; '), introduced: r.introduced,
      url: r.url, officialSummary: r.officialSummary, officialSummaryLabel: r.officialSummaryLabel, source: r.source, fetchedAt: r.fetchedAt });
    if (!S.campaign.bill || /^(your bill|new campaign|untitled)/i.test(S.campaign.bill)) S.campaign.bill = `${r.number}: ${r.title}`.slice(0, 140);
}

// ---------- filling the count from the public record ----------
// Sponsors and cosponsors, the committee that has the bill and its members,
// and how each member voted on it. Only members nobody has worked yet change;
// what you learned yourself always wins. Runs when a campaign is created and
// again once a day while it is open, so new cosponsors and votes show up.
const FED_NUM = /\b(H\.?\s?R\.?|S\.?|H\.?\s?Res\.?|S\.?\s?Res\.?|H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?Con\.?\s?Res\.?|S\.?\s?Con\.?\s?Res\.?)\s?(\d{1,5})\b/i;
function billNumberOf(st = S) {
  if (st.brief && st.brief.number) return st.brief.number;
  const head = String(st.campaign.bill || '').split(':')[0];
  const f = FED_NUM.exec(head); if (f) return `${f[1]} ${f[2]}`;
  const m = /\b([A-Z]{1,4})\.?\s?(\d{1,5})\b/.exec(head); return m ? `${m[1]} ${m[2]}` : '';
}
function recordReady(st = S) {
  const ch = campaignChamber(st);
  return Boolean(signedIn() && CLOUD.api && ch.level && (ch.level === 'us' || ch.state) && billNumberOf(st) && !st.example);
}
function personMatch(p, ch, idx) {
  if (p.id && idx.ref.has(p.id)) return idx.ref.get(p.id);
  const last = nameKey(p.last || lastName(p.name)); if (!last) return null;
  let c = idx.last.get(last) || [];
  if (ch.level === 'us') {
    if (ch.chamber === 'lower' && p.district === '' && !p.state) return null;
    if (ch.chamber === 'upper' && p.district) return null; // a House member
    if (p.state) c = c.filter((m) => String(m.district || '').toUpperCase().startsWith(p.state.toUpperCase()));
    if (ch.chamber === 'lower' && p.district) c = c.filter((m) => { const d = String(m.district).split('-')[1] || ''; return d === String(p.district) || (/^(al|0)$/i.test(d) && /^(0|al|)$/i.test(String(p.district))); });
  } else {
    if (p.chamber && p.chamber !== ch.chamber) return null;
    if (p.district) c = c.filter((m) => String(m.district).replace(/^0+/, '') === String(p.district).replace(/^0+/, ''));
  }
  if (c.length > 1 && p.first) c = c.filter((m) => nameKey(m.name).startsWith(nameKey(p.first)));
  return c.length === 1 ? c[0] : null;
}
function applyRecord(r, ch) {
  const idx = { ref: new Map(), last: new Map() };
  for (const m of S.members) { if (m.ref) idx.ref.set(m.ref, m); const k = nameKey(lastName(m.name)); if (!idx.last.has(k)) idx.last.set(k, []); idx.last.get(k).push(m); }
  const free = (m) => !lastContact(m) && (m.pos === 2 || m.posFrom === 'record');
  const ev = new Map(), set = (m, pos, why, mov) => { if (m && !ev.has(m.id)) ev.set(m.id, { pos, why, mov }); };
  // A recorded vote on the bill itself is the strongest sign, newest first.
  for (const v of r.votes.filter((x) => x.stance === 'for' && (!x.chamber || x.chamber === ch.chamber))) {
    const when = v.date ? fmtDay(v.date) : '';
    for (const x of v.votes) if (x.v !== 'other') set(personMatch(x, ch, idx), x.v === 'yes' ? 4 : 0, `Voted ${x.v} on "${v.motion}"${when ? `, ${when}` : ''}`, 2);
  }
  r.sponsors.forEach((p) => set(personMatch(p, ch, idx), 4, `Sponsor of ${r.bill}`, 1));
  r.cosponsors.forEach((p) => set(personMatch(p, ch, idx), 4, `Cosponsor of ${r.bill}`, 1));
  const out = { yes: 0, no: 0, skipped: 0, committee: '', cmte: 0 };
  for (const m of S.members) {
    const e = ev.get(m.id); if (!e) continue;
    if (!free(m)) { if (m.pos !== e.pos) out.skipped++; continue; }
    if (m.pos !== e.pos) m.history.push({ d: iso(new Date()), type: 'Count update', from: m.pos, to: e.pos, note: `From the public record (${r.source}): ${e.why}`, by: ME || '' });
    m.pos = e.pos; m.mov = e.mov; m.posFrom = 'record'; m.recordNote = e.why;
    if (e.pos === 4) out.yes++; else out.no++;
  }
  // The committee that has the bill now, in this chamber
  const cm = r.committees.filter((x) => (!x.chamber || x.chamber === ch.chamber) && x.members.length);
  const now = cm.find((x) => x.now) || cm.find((x) => !x.reported) || null;
  if (now && (!S.campaign.committee || S.campaign.cmteFrom === 'record')) {
    S.campaign.committee = now.name.replace(/^(House|Senate) /, '').slice(0, 80); S.campaign.cmteFrom = 'record';
    const on = new Map(); for (const p of now.members) { const m = personMatch(p, ch, idx); if (m) on.set(m.id, p.role || ''); }
    for (const m of S.members) { const was = m.cmte; m.cmte = on.has(m.id); if (m.cmte) m.role = /chair|ranking/i.test(on.get(m.id)) ? on.get(m.id) : (was ? m.role : ''); else if (m.role && /chair|ranking/i.test(m.role)) m.role = ''; }
    out.committee = S.campaign.committee; out.cmte = on.size;
  }
  S.record = { at: Date.now(), bill: r.bill, source: r.source };
  return out;
}
async function fillFromRecord({ auto = false } = {}) {
  if (!recordReady()) { if (!auto) toast(signedIn() ? 'Add the bill number to the campaign name (for example HB 123 or H.R. 1234) and load the chamber first.' : 'Sign in to fill the count from the public record.'); return null; }
  if (!canEditNow()) return null;
  const ch = campaignChamber(), camp = S.id;
  const q = new URLSearchParams({ jurisdiction: ch.level === 'us' ? 'US' : ch.state, number: billNumberOf() });
  if (S.brief.session && ch.level !== 'us') q.set('session', S.brief.session);
  if (!auto) toast('Checking the public record');
  try {
    const r = await CLOUD.api('GET', `/api/bills/record?${q}`);
    if (S.id !== camp) return null;
    if (!hasBrief(S.brief) && !S.brief.number) { try { fillBrief(await CLOUD.api('GET', `/api/bills/lookup?${new URLSearchParams({ jurisdiction: q.get('jurisdiction'), number: q.get('number') })}`), false); } catch (_) { /* the count still fills */ } }
    const out = applyRecord(r, ch); if (out.yes || out.no || out.committee) track('record_filled');
    commit();
    const bits = [out.yes ? `${out.yes} marked Yes` : '', out.no ? `${out.no} marked No` : '', out.committee ? `committee: ${out.committee} (${out.cmte})` : ''].filter(Boolean);
    if (!auto || bits.length) toast(bits.length ? `From the public record: ${bits.join(', ')}` : `Nothing new on the record for ${r.bill} yet`);
    return out;
  } catch (e) { if (!auto) fail(e); else S.recordTried = Date.now(); return null; }
}
let RECORD_CHECK = '';
function recordDaily() {
  if (!S.cloud || !recordReady() || !canEditNow()) return;
  const due = !S.record || Date.now() - S.record.at > 864e5, tried = S.recordTried && Date.now() - S.recordTried < 36e5;
  if (!due || tried || RECORD_CHECK === S.id) return;
  RECORD_CHECK = S.id; setTimeout(() => { if (RECORD_CHECK === S.id) fillFromRecord({ auto: true }).finally(() => { RECORD_CHECK = ''; }); }, 800);
}
async function draftAnalysis(form) {
  const go = $('#dfGo'), msg = $('#dfMsg');
  if (go.dataset.sure !== '1' && /replace/i.test(go.textContent)) { go.dataset.sure = '1'; msg.textContent = 'This replaces your summary, talking points and objections. Press again to go ahead.'; return; }
  if (!signedIn()) return toast('Sign in to draft with AI.');
  const b = S.brief, c = S.campaign, material = $('#df_text').value;
  go.disabled = true; msg.textContent = 'Drafting with AI. This can take up to a minute.';
  try {
    const r = await CLOUD.api('POST', '/api/bills/draft', { bill: { number: b.number, title: b.title || c.bill, jurisdiction: b.jurisdiction, session: b.session, sponsors: b.sponsors, status: b.status, committees: b.committees, officialSummary: b.officialSummary }, material, side: c.side, ask: c.ask, client: clientOf(), campaignId: S.cloud ? S.id : undefined });
    Object.assign(b, { plainSummary: r.plainSummary, keyProvisions: r.keyProvisions, whoItAffects: r.whoItAffects, fiscalImpact: r.fiscalImpact, talkingPoints: r.talkingPoints, objections: r.objections, needsChecking: r.needsChecking, draftedAt: r.draftedAt });
    briefPanel = ''; save(); render(); toast('Draft ready. Check it against the bill before you use it.');
  } catch (e) { go.disabled = false; msg.textContent = e.message; }
}
function saveBriefForm(form) {
  const fd = new FormData(form), g = (k, n = 4000) => String(fd.get(k) || '').trim().slice(0, n);
  const objections = String(fd.get('objections') || '').split(/\n\s*\n/).map((blk) => blk.trim().split('\n')).filter((x) => x[0].trim()).map(([o, ...r]) => ({ objection: o.trim().slice(0, 500), response: r.join(' ').trim().slice(0, 1500) })).slice(0, 20);
  Object.assign(S.brief, { number: g('number', 40), title: g('title', 300), jurisdiction: g('jurisdiction', 120), session: g('session', 60), sponsors: g('sponsors', 600), status: g('status', 400), committees: g('committees', 400), url: /^https?:\/\//.test(g('url')) ? g('url', 500) : '',
    plainSummary: g('plainSummary'), keyProvisions: lines(g('keyProvisions', 8000)).slice(0, 30), whoItAffects: g('whoItAffects'), fiscalImpact: g('fiscalImpact'), supporters: g('supporters', 800), opponents: g('opponents', 800),
    talkingPoints: lines(g('talkingPoints', 8000)).slice(0, 30), objections, needsChecking: lines(g('needsChecking', 4000)).slice(0, 30), officialSummary: g('officialSummary', 40000) });
  briefEdit = false; save(); render(); toast('Brief saved');
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- text a lobbyist takes out of the tool ----------
// What to call a member of this campaign's chamber: Senator, Representative,
// Assemblymember, Delegate or Councilmember.
function honorific() {
  const ch = campaignChamber();
  if (ch.level === 'us') return ch.chamber === 'upper' ? 'Senator' : 'Representative';
  if (ch.level === 'state' && ch.state) {
    const list = chambersOf(ch.state), c = list.find((x) => x.chamber === ch.chamber) || (list.length === 1 ? list[0] : null);
    if (c) return c.title;
  }
  const t = S.campaign.chamber || '';
  return /senate/i.test(t) ? 'Senator' : /house of delegates/i.test(t) ? 'Delegate' : /council/i.test(t) ? 'Councilmember' : /assembly/i.test(t) && !/wisconsin/i.test(t) ? 'Assemblymember' : /house|assembly/i.test(t) ? 'Representative' : '';
}
const lastName = (n) => { const p = String(n).replace(/,? (Jr\.?|Sr\.?|II|III|IV)$/i, '').trim().split(/\s+/); return p[p.length - 1] || n; };
function suggestedAsk(m) {
  const dir = dirOf(S), c = S.campaign, on = dir > 0 ? m.pos : 4 - m.pos;
  const base = c.ask ? `Our ask: ${c.ask}. ` : '';
  if (on === 4) return base + (dir > 0 ? 'Already with us. Ask them to co-sponsor, speak in caucus, or call a colleague on the call sheet.' : 'Already opposed. Ask them to say so publicly and to work a colleague on the call sheet.');
  if (on === 3) return base + 'Leaning our way. Ask for a firm commitment and find out what would shake it.';
  if (on === 2) return base + 'Undecided. Ask what they need to see, who they are hearing from, and offer the district numbers.';
  if (on === 1) return base + 'Leaning against us. Ask for the specific objection and whether an amendment or a commitment from the sponsor would answer it.';
  return base + 'Firmly against us. Do not expect a switch: ask them not to whip colleagues, or to stay quiet on the floor.';
}
function briefText(m) {
  const c = S.campaign, ct = contact(m), cue = S.members.find((x) => x.id === m.follows), fol = S.members.filter((x) => x.follows === m.id).map((x) => x.name);
  const hist = m.history.filter((h) => h.type !== 'Count update').slice(-5).reverse();
  const tasks = S.tasks.filter((t) => t.mid === m.id && !t.done);
  return [
    `MEETING BRIEF: ${m.name} (${m.party}-${m.district})`,
    `${c.bill}${clientOf() ? ` | ${clientOf()}` : ''} | prepared ${today()}`, '',
    `Position on the bill: ${POS[m.pos]} (movability ${m.mov}/5)`,
    m.role || m.cmte ? `Committee: ${m.role ? m.role + ', ' : 'member, '}${c.committee || 'committee of referral'}` : '',
    m.interests ? `Cares about: ${m.interests}` : '',
    cue ? `Takes cues from: ${cue.name} (${POS[cue.pos]})` : '',
    fol.length ? `Looked to by: ${fol.join(', ')}` : '', '',
    ...billLines(),
    `THE ASK`, suggestedAsk(m), '',
    `CONTACT`, ct.phone ? `Phone: ${ct.phone}` : '', ct.email ? `Email: ${ct.email}` : '', ct.office ? `Office: ${ct.office}` : '', ct.doffice ? `District office: ${ct.doffice}${ct.dphone ? ' ' + ct.dphone : ''}` : '',
    ...m.staffers.map((s) => `Staff: ${s.name}${s.role ? ', ' + s.role : ''}${s.phone ? ', ' + s.phone : ''}${s.email ? ', ' + s.email : ''}${s.notes ? ' (' + s.notes + ')' : ''}`), '',
    `RECENT CONTACT`, ...(hist.length ? hist.map((h) => `${h.d}: ${h.type}${h.who ? ' with ' + h.who : ''}${h.from !== h.to ? `, moved ${POS[h.from]} to ${POS[h.to]}` : ''}${h.note ? '. ' + h.note : ''}`) : ['None logged.']),
    tasks.length ? '' : null, tasks.length ? 'OPEN FOLLOW-UPS' : null, ...tasks.map((t) => `- ${t.text}${t.due ? ' (due ' + t.due + ')' : ''}`),
    m.notes ? '' : null, m.notes ? 'NOTES' : null, m.notes || null,
  ].filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}
function csv(rows) { return rows.map((r) => r.map((v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n'); }
function clientReport() {
  const nd = needs(S), base = passage(S.members, baseProbs(S), nd), c = S.campaign, defeat = dirOf(S) < 0;
  const count = (list) => [4, 3, 2, 1, 0].map((p) => `${POS[p]} ${list.filter((m) => m.pos === p).length}`).join(', ');
  const mv = movesList(7), calls = callSheet(S, nd, base, 6), from = daysAgo(7);
  const touched = S.members.reduce((n, m) => n + m.history.filter((h) => h.d >= from && h.type !== 'Count update').length, 0);
  const dates = [['Committee vote', c.cmteDate], ['Floor vote', c.floorDate]].filter((x) => x[1]).map((x) => `${x[0]}: ${x[1]} (${inDays(x[1])})`);
  return [
    `${c.bill}: status as of ${today()}`, clientOf() ? `Prepared for ${clientOf()}${c.me ? ' by ' + c.me : ''}${firmOf() ? `, ${firmOf()}` : ''}` : null, '',
    `Goal: ${defeat ? 'defeat' : 'pass'} the bill. Our estimate today: ${pct(goal(S, base.both))}% (${defeat ? `stopped in committee ${nd.c ? pct(1 - base.cm) + '%' : 'n/a'}, fails on the floor ${pct(1 - base.fl)}%` : `clears committee ${nd.c ? pct(base.cm) + '%' : 'n/a'}, wins the floor ${pct(base.fl)}%`}).`,
    hasBrief(S.brief) && S.brief.status ? `Bill: ${billLabel(S.brief)}. Status: ${S.brief.status}.` : null,
    `Floor count (${c.chamber || 'chamber'}, ${nd.n} members, ${nd.needF} needed to pass): ${count(S.members)}.`,
    nd.c ? `Committee count (${c.committee || 'committee'}, ${nd.needC} of ${nd.c} needed): ${count(S.members.filter((m) => m.cmte))}.` : null,
    dates.length ? `Key dates: ${dates.join('; ')}.` : null, '',
    `Movement in the last 7 days:`, ...(mv.length ? mv.map(({ m, h }) => `- ${m.name} (${m.party}-${m.district}): ${POS[h.from]} to ${POS[h.to]}, ${h.d}`) : ['- No position changes.']), '',
    `Contacts logged in the last 7 days: ${touched}.`, '',
    `Priority targets:`, ...(calls.length ? calls.map((r) => `- ${verbFor(S, r.m)} ${r.m.name} (${r.m.party}-${r.m.district}), currently ${POS[r.m.pos]}`) : ['- None: the count is settled.']), '',
    `Meetings:`, ...(upcoming().length ? upcoming().slice(0, 12).map((x) => `- ${x.status === 'requested' ? `Requested ${String(x.sentAt).slice(0, 10)}` : fmtWhen(x.start)}: ${x.title}`) : ['- None scheduled or requested.']), '',
    `Open follow-ups:`, ...(openTasks().length ? openTasks().slice(0, 12).map((t) => `- ${t.text}${t.due ? ' (due ' + t.due + ')' : ''}`) : ['- None.']), '',
    `The percentages are a planning estimate built on our own read of each member, not a forecast.`,
  ].filter((l) => l !== null).join('\n');
}
function contactsCsv(from) {
  const rows = [];
  S.members.forEach((m) => m.history.forEach((h) => { if (h.type !== 'Count update' && h.d >= from) rows.push([h.d, m.name, m.party, m.district, h.who || 'Member', h.type, POS[h.from], POS[h.to], h.note || '']); }));
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return csv([['Date', 'Office of', 'Party', 'District', 'Spoke with', 'Type', 'Position before', 'Position after', 'Notes']].concat(rows));
}
function whipCsv() {
  return csv([['Name', 'Party', 'District', 'Committee', 'Committee role', 'Position', 'Movable (1-5)', 'Phone', 'Email', 'Office', 'Last contact', 'Staff', 'Interests', 'Notes']].concat(
    S.members.map((m) => { const c = contact(m), l = lastContact(m); return [m.name, m.party, m.district, m.cmte ? 'yes' : '', m.role || '', POS[m.pos], m.mov, c.phone, c.email, c.office, l ? l.d : '', m.staffers.map((s) => `${s.name}${s.role ? ' (' + s.role + ')' : ''}`).join('; '), m.interests || '', m.notes || '']; })));
}

// ---------- meetings: ask by email, or send a calendar invitation ----------
let RQ = null;
const pad = (n) => String(n).padStart(2, '0');
const toInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtSlot = (d) => d.toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtWhen = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const tzName = () => { try { return new Intl.DateTimeFormat(undefined, { timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value; } catch (_) { return ''; } };
const mine = (mt) => !mt.by || mt.by === ME;
const ended = (mt) => mt.status === 'invited' && mt.start && new Date(mt.start).getTime() + (mt.mins || 30) * 60000 < Date.now();
const upcoming = () => S.meetings.filter((x) => x.status === 'requested' || x.status === 'invited').sort((a, b) => String(a.start || a.sentAt).localeCompare(String(b.start || b.sentAt)));
const REPLY = { accepted: ['Accepted', 'ok'], declined: ['Declined', 'bad'], tentative: ['Maybe', 'wait'], waiting: ['No reply yet', 'wait'] };
function addBusinessDays(n) { const d = new Date(); while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) n--; } return iso(d); }
function defaultSlots(mins) { return CLOUD.freeSlots([], { mins, count: 3 }); }
function recipients(m) {
  // Published addresses first; those written in the usual format after, marked
  const staff = m.staffers.filter((s) => isEmail(s.email || '')), lab = (s) => `${s.name}${s.role ? `, ${s.role}` : ''}${s.fmt ? ' (usual format)' : ''}`;
  const c = contact(m), office = isEmail(c.email) ? [{ email: c.email, label: `${m.name}'s office${c.emailUsual ? ' (usual format)' : ''}`, fmt: c.emailUsual }] : [];
  return [...staff.filter((s) => !s.fmt).map((s) => ({ email: s.email, label: lab(s), sid: s.id })), ...office.filter((o) => !o.fmt), ...office.filter((o) => o.fmt), ...staff.filter((s) => s.fmt).map((s) => ({ email: s.email, label: lab(s), sid: s.id, fmt: true }))];
}
function meetingTitle(m, st) { const h = honorific(), b = S.brief; return `${b.number || (S.campaign.bill || '').split(':')[0] || 'Meeting'}: ${st ? `${st.name}, office of ` : ''}${h ? h + ' ' : ''}${m.name}`.slice(0, 160); }
function rqStaffer(m) { return m.staffers.find((s) => s.email && RQ && s.email.toLowerCase() === String(RQ.to).toLowerCase()); }

const senderName = () => S.campaign.me || (CLOUD.user && CLOUD.user.name) || '[your name]';
function requestText(m) {
  const c = S.campaign, b = S.brief, h = honorific(), ref = h ? `${h} ${lastName(m.name)}` : m.name, st = rqStaffer(m);
  const hello = st ? st.name.split(/\s+/)[0] : RQ.to && RQ.to === contact(m).email ? ref : 'there';
  const times = RQ.times.filter(Boolean).map((t) => `- ${fmtSlot(new Date(t))}`), about = briefSummaryLine(b);
  return {
    subject: `Meeting request: ${b.number || (c.bill || 'legislation').split(':')[0]}`.slice(0, 140),
    body: [
      `Hi ${hello},`, '',
      `I'm ${senderName()}${firmOf() ? ` with ${firmOf()}${clientOf() && clientOf() !== firmOf() ? `, on behalf of ${clientOf()}` : ''}` : clientOf() ? ` with ${clientOf()}` : ''}. I'd like ${RQ.mins} minutes with ${ref}${st ? ' or with you' : ''} to discuss ${billLabel(b)}${m.cmte && c.committee ? `, which is before ${c.committee}` : ''}.`, '',
      ...(about ? [`In short: ${about}`, ''] : []),
      ...(c.ask ? [`What we are asking: ${c.ask}.`, ''] : []),
      ...(times.length ? ['Would one of these times work?', ...times, `(Times are ${tzName() || 'local time'}.)`] : ['What times would work over the next two weeks?']), '',
      'I can come to the office or meet by phone or video, whichever is easier.', '',
      'Thank you,', senderName(), ...(firmOf() || clientOf() ? [firmOf() || clientOf()] : []),
    ].join('\n'),
  };
}
function inviteText(m) {
  const c = S.campaign, b = S.brief, ct = contact(m);
  return [billLabel(b), briefSummaryLine(b), c.ask ? `Our ask: ${c.ask}.` : '', RQ.note, `Requested by ${senderName()}${firmOf() || clientOf() ? `, ${firmOf() || clientOf()}` : ''}.`, ct.phone ? `Office phone: ${ct.phone}` : ''].filter(Boolean).join('\n\n');
}
function rqStart(m, opts = {}) {
  const list = recipients(m), st = opts.sid && m.staffers.find((s) => s.id === opts.sid);
  const slots = defaultSlots(30);
  RQ = { mid: m.id, mode: opts.mode || 'email', to: opts.to || (st && st.email) || (list[0] && list[0].email) || '', other: false, mins: opts.mins || 30,
    times: opts.times || slots.map((d) => d.toISOString()), start: opts.start || (slots[0] ? slots[0].toISOString() : ''), where: ct0(m), video: true, note: '', subject: '', body: '', edited: false, meetingId: opts.meetingId || null, msg: '', sentVia: '' };
  if (!list.some((r) => r.email === RQ.to) && RQ.to) RQ.other = true;
  if (!RQ.to) RQ.other = true;
  rqRefreshText(m);
}
function ct0(m) { return contact(m).office || ''; }
function rqRefreshText(m) { if (RQ.edited) return; const t = requestText(m); RQ.subject = t.subject; RQ.body = t.body; }
function rqHtml(m) {
  const list = recipients(m), signed = signedIn() && CLOUD.canConnect(), prov = CLOUD.provider(), canSign = CLOUD.canSignIn() && CLOUD.canConnect();
  const toSel = `<select id="rq_to" aria-label="Send to">${list.map((r) => `<option value="${esc(r.email)}" ${!RQ.other && r.email === RQ.to ? 'selected' : ''}>${esc(r.label)}: ${esc(r.email)}</option>`).join('')}<option value="__other" ${RQ.other ? 'selected' : ''}>Someone else</option></select>`;
  const tabs = `<div class="seg wide" role="group" aria-label="How"><button type="button" data-rqmode="email" aria-pressed="${RQ.mode === 'email'}">Ask for a meeting by email</button><button type="button" data-rqmode="invite" aria-pressed="${RQ.mode === 'invite'}">Send a calendar invitation</button></div>`;
  const common = `<label class="wide">To ${toSel}</label>
    <label class="wide" ${RQ.other ? '' : 'hidden'}>Email address<input id="rq_other" type="email" value="${RQ.other ? esc(RQ.to) : ''}" placeholder="scheduler@senate.example.gov"></label>
    <label>Length<select id="rq_mins">${[15, 30, 45, 60].map((n) => `<option value="${n}" ${RQ.mins === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></label>
    ${signed && prov ? `<div style="align-self:end"><button type="button" class="btn" data-act="rqFind">${RQ.mode === 'email' ? 'Offer open times from my calendar' : 'Use my next open time'}</button></div>` : '<div></div>'}`;
  const sendAs = prov ? [prov] : CLOUD.connectable();
  const signNote = !signed && canSign ? `<p class="wide note">Sign in with ${CLOUD.config.providers.map(CLOUD.providerName).join(' or ')} to send this from your own email and calendar. <button type="button" class="btn sm" data-act="signin">Sign in</button></p>` : '';
  let body;
  if (RQ.mode === 'email') {
    body = `<div class="wide times"><span class="note">Times to offer (${esc(tzName())})</span>${[0, 1, 2].map((i) => `<input type="datetime-local" id="rq_t${i}" value="${RQ.times[i] ? toInput(new Date(RQ.times[i])) : ''}" aria-label="Time option ${i + 1}">`).join('')}</div>
      <label class="wide">Subject<input id="rq_subject" value="${esc(RQ.subject)}"></label>
      <label class="wide">Message<textarea id="rq_body" class="out" style="min-height:260px">${esc(RQ.body)}</textarea></label>
      ${signNote}
      <div class="wide btnrow">${signed ? sendAs.map((x, i) => `<button type="button" class="btn${i ? '' : ' primary'}" data-act="rqSend" data-mp="${x}">Send from ${CLOUD.mailName(x)}</button>`).join('') : ''}${mailButtons('rqMailto', !signed)}<button type="button" class="btn" data-act="rqCopy">Copy message</button><button type="button" class="btn" data-act="rqClose">Close</button></div>`;
  } else {
    body = `<label>Date and time<input type="datetime-local" id="rq_start" value="${RQ.start ? toInput(new Date(RQ.start)) : ''}"></label>
      <label>Where<input id="rq_where" value="${esc(RQ.where)}" placeholder="Office, phone or video"></label>
      ${signed ? `<label class="wide check"><input type="checkbox" id="rq_video" ${RQ.video !== false ? 'checked' : ''}> Add a ${prov ? CLOUD.videoName(prov) : 'Google Meet'} link</label>` : ''}
      <label class="wide">Note in the invitation <span class="note">optional</span><textarea id="rq_note">${esc(RQ.note)}</textarea></label>
      ${signNote}
      ${signed ? '' : '<p class="wide note">Google Calendar opens with the meeting filled in, the office invited and a Google Meet link added. Check it and click Save, and Google sends the invitation. Outlook works the same way, with its Teams switch.</p>'}
      <div class="wide btnrow">${signed ? sendAs.map((x, i) => `<button type="button" class="btn${i ? '' : ' primary'}" data-act="rqInvite" data-mp="${x}">Send invitation from ${CLOUD.calName(x)}</button>`).join('') + '<button type="button" class="btn" data-act="rqCalLink" data-cal="google">Open in Google Calendar</button>' : '<button type="button" class="btn primary" data-act="rqCalLink" data-cal="google">Open in Google Calendar</button><button type="button" class="btn" data-act="rqCalLink" data-cal="outlook">Open in Outlook</button>'}<button type="button" class="btn" data-act="rqIcs">Download a calendar invitation</button><button type="button" class="btn" data-act="rqClose">Close</button></div>`;
  }
  return `<form id="rqForm" class="form">${tabs}${common}${body}<p class="wide note" id="rqMsg" role="status">${esc(RQ.msg)}</p></form>`;
}
function rqMsg(text) { if (RQ) RQ.msg = text; const el = $('#rqMsg'); if (el) el.textContent = text; }
function rqRead() {
  if (!RQ) return;
  const v = (id) => { const el = $('#' + id); return el ? el.value : null; };
  const sel = v('rq_to'); if (sel !== null) { RQ.other = sel === '__other'; RQ.to = RQ.other ? String(v('rq_other') || '').trim() : sel; }
  if (v('rq_mins') !== null) RQ.mins = +v('rq_mins');
  if (RQ.mode === 'email') {
    RQ.times = [0, 1, 2].map((i) => { const x = v('rq_t' + i); return x ? new Date(x).toISOString() : ''; });
    if (v('rq_subject') !== null) RQ.subject = v('rq_subject');
    if (v('rq_body') !== null) RQ.body = v('rq_body');
  } else {
    const s = v('rq_start'); RQ.start = s ? new Date(s).toISOString() : '';
    RQ.where = v('rq_where') || ''; RQ.note = v('rq_note') || ''; const vid = $('#rq_video'); if (vid) RQ.video = vid.checked;
  }
}
function rqTextOut() { const s = $('#rq_subject'), b = $('#rq_body'); if (s && !RQ.edited) s.value = RQ.subject; if (b && !RQ.edited) b.value = RQ.body; }
// ---------- opening the person's own email ----------
// A mailto link only works when the computer has an email program set up,
// and some programs fail silently on long links. Gmail and Outlook on the web
// always open, so they are offered too, and the last choice comes first.
const MAILERS = { gmail: 'Gmail', outlook: 'Outlook', app: 'my email app' };
const mailerPref = () => { const v = lsGet('headcount.mailer'); return MAILERS[v] ? v : ''; };
function composeUrl(kind, { to = '', cc = '', bcc = '', subject = '', body = '' }) {
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  if (kind === 'gmail') return `https://mail.google.com/mail/?view=cm&fs=1&${q({ to, cc, bcc, su: subject, body })}`;
  if (kind === 'outlook') return `https://outlook.office.com/mail/deeplink/compose?${q({ to, cc, bcc, subject, body })}`;
  const addr = String(to).split(',').map((x) => encodeURIComponent(x.trim()).replace(/%40/g, '@')).filter(Boolean).join(',');
  return `mailto:${addr}?${q({ cc, bcc, subject, body: String(body).replace(/\r?\n/g, '\r\n') })}`;
}
// Tells the server about a moment that matters for the product numbers (no content).
function track(name) { if (signedIn() && CLOUD.api) CLOUD.api('POST', '/api/events', { name, workspaceId: ORG ? ORG.id : undefined }).catch(() => {}); }
function openMail(kind, msg) {
  lsSet('headcount.mailer', kind); if (RQ) track('meeting_requested');
  if (kind !== 'app') { window.open(composeUrl(kind, msg), '_blank', 'noopener'); return 'web'; }
  let url = composeUrl('app', msg), copied = false;
  if (url.length > 1900) { copyText(msg.body); copied = true; url = composeUrl('app', { ...msg, body: '(Your message is copied: paste it here.)' }); }
  const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  return copied ? 'copied' : 'app';
}
function mailButtons(act, primary) {
  const pref = mailerPref() || 'app', order = [pref, ...Object.keys(MAILERS).filter((k) => k !== pref)];
  return order.map((k, i) => `<button type="button" class="btn${i === 0 && primary ? ' primary' : ''}" data-act="${act}" data-mailer="${k}">Open in ${MAILERS[k]}</button>`).join('');
}
const mailOpenedNote = (how) => ({ web: 'It opened in a new tab. ', copied: 'Your message was long, so it is copied: paste it into the email that opened. ', app: 'Your email app should open with the message. If nothing happened, choose Gmail or Outlook instead, or Copy message. ' }[how]);
function rqCheckTo() { if (!isEmail(RQ.to)) { rqMsg('Enter a valid email address to send to.'); return false; } return true; }

// Records a sent request: the agenda, the member's history and a follow-up.
function recordRequest(m, via) {
  const st = rqStaffer(m), times = RQ.times.filter(Boolean);
  S.meetings.push(stamp({ id: uid(), mid: m.id, who: st ? st.name : '', to: [RQ.to], status: 'requested', proposed: times, mins: RQ.mins, sentAt: new Date().toISOString(), via, title: meetingTitle(m, st), where: '' }));
  m.history.push(stamp({ d: today(), type: 'Email', who: st ? st.name : '', from: m.pos, to: m.pos, note: `Asked for a ${RQ.mins}-minute meeting${times.length ? `, offering ${times.map((t) => fmtWhen(t)).join('; ')}` : ''}.` }));
  S.tasks.push(stamp({ id: uid(), text: `Follow up with ${st ? st.name : m.name} on the meeting request`, due: addBusinessDays(3), mid: m.id, done: false }));
  if (S.meetings.length > 300) S.meetings = S.meetings.slice(-300);
  const to = RQ.to; RQ = null; schedOpen = false; commit(`Meeting request sent to ${to}`); memberDrawer(m.id);
}
function recordInvite(m, ev, via) {
  const st = rqStaffer(m), start = RQ.start, existing = RQ.meetingId && S.meetings.find((x) => x.id === RQ.meetingId);
  const rec = Object.assign(existing || stamp({ id: uid(), mid: m.id }), { who: st ? st.name : (existing && existing.who) || '', to: [RQ.to], status: 'invited', start, mins: RQ.mins, where: RQ.where, via, title: meetingTitle(m, st),
    eventId: ev ? ev.id : '', link: ev ? ev.link : '', video: ev ? ev.video : '', provider: ev ? CLOUD.provider() : '', replies: ev ? { [RQ.to.toLowerCase()]: 'waiting' } : {}, by: (existing && existing.by) || ME || undefined });
  if (!existing) S.meetings.push(rec);
  const to = RQ.to; RQ = null; schedOpen = false;
  commit(ev ? `Invitation sent to ${to} from your ${CLOUD.calName(CLOUD.provider())}${ev.video ? ', with a Google Meet link' : ''}` : via === 'gcal-web' ? 'Google Calendar opened. Click Save there to send the invitation.' : via === 'outlook-web' ? 'Outlook opened. Click Send there to send the invitation.' : 'Invitation downloaded. Open it to add the meeting to your calendar, or attach it to an email.');
  memberDrawer(m.id);
}
async function findTimes(m) {
  rqMsg('Checking your calendar');
  try {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() + 1);
    const busy = await CLOUD.calendar.busy(from, new Date(from.getTime() + 15 * 864e5));
    const slots = CLOUD.freeSlots(busy, { mins: RQ.mins, count: 3 });
    if (!slots.length) return rqMsg('No open time found in the next two weeks between 9 and 5.');
    if (RQ.mode === 'email') {
      RQ.times = slots.map((d) => d.toISOString());
      slots.forEach((d, i) => { const el = $('#rq_t' + i); if (el) el.value = toInput(d); });
      rqRefreshText(m); rqTextOut(); rqMsg(`Offering ${slots.length} open time${slots.length === 1 ? '' : 's'} from your calendar.`);
    } else { RQ.start = slots[0].toISOString(); $('#rq_start').value = toInput(slots[0]); rqMsg(`Your next open time is ${fmtSlot(slots[0])}.`); }
  } catch (e) { rqMsg(e.message); }
}
function meetHtml(mt) {
  const m = S.members.find((x) => x.id === mt.mid);
  const title = m ? `<button class="linkbtn" data-open="${esc(m.id)}">${esc(mt.title)}</button>` : esc(mt.title);
  if (mt.status === 'requested') {
    return `<li style="grid-template-columns:minmax(0,1fr)"><div><div class="when"><span class="status wait">Requested</span> sent ${esc(fmtDay(String(mt.sentAt).slice(0, 10)))}${mt.via ? ` via ${esc(mt.via)}` : ''}</div>
      <div>${title}</div>${mt.proposed && mt.proposed.length ? `<div class="due">Offered ${esc(mt.proposed.map(fmtWhen).join('; '))}</div>` : ''}
      ${canEditNow() ? `<div class="btnrow" style="margin-top:6px"><button class="btn sm primary" data-act="bookTime" data-id="${esc(mt.id)}">They replied: book a time</button><button class="btn sm" data-act="cancelMeet" data-id="${esc(mt.id)}">Withdraw</button></div>` : ''}</div></li>`;
  }
  const replies = Object.entries(mt.replies || {}).map(([email, r]) => `<span class="status ${(REPLY[r] || REPLY.waiting)[1]}">${esc((REPLY[r] || REPLY.waiting)[0])}</span> <span class="note">${esc(email)}</span>`).join(' ');
  const onCal = mt.eventId ? (mine(mt) ? (/^https:\/\//.test(mt.link || '') ? `<a href="${esc(mt.link)}" target="_blank" rel="noopener">Open in ${esc(CLOUD.calName(mt.provider))}</a>` : `On your ${esc(CLOUD.calName(mt.provider))}`) : 'On a teammate\'s calendar') : mt.via === 'ics' ? 'Invitation file downloaded' : '';
  return `<li style="grid-template-columns:minmax(0,1fr)"><div><div class="when">${esc(fmtWhen(mt.start))} · ${mt.mins || 30} min</div><div>${title}</div>
    <div class="due">${replies}${replies && (mt.where || onCal) ? ' · ' : ''}${mt.where ? esc(mt.where) + (onCal ? ' · ' : '') : ''}${onCal}${/^https:\/\//.test(mt.video || '') ? ` · <a href="${esc(mt.video)}" target="_blank" rel="noopener">Video link</a>` : ''}</div>
    ${canEditNow() ? `<div class="btnrow" style="margin-top:6px">${ended(mt) ? `<button class="btn sm primary" data-act="logMeet" data-id="${esc(mt.id)}">Log the outcome</button>` : ''}<button class="btn sm" data-act="cancelMeet" data-id="${esc(mt.id)}">${ended(mt) ? 'Dismiss' : 'Cancel meeting'}</button></div>` : ''}</div></li>`;
}
function renderMeets() {
  const list = upcoming();
  $('#meets').innerHTML = list.map(meetHtml).join('');
  const checkable = list.some((x) => x.status === 'invited' && x.eventId && mine(x));
  $('#agendaTools').innerHTML = checkable && signedIn() ? '<button class="btn sm" data-act="checkReplies">Check replies</button>' : '';
}
async function checkReplies() {
  const list = S.meetings.filter((x) => x.status === 'invited' && x.eventId && mine(x) && x.provider === CLOUD.provider());
  let acc = 0, dec = 0, wait = 0, gone = 0;
  for (const mt of list) {
    try {
      const r = await CLOUD.calendar.get(mt.eventId);
      if (r.cancelled) { mt.status = 'cancelled'; gone++; continue; }
      if (r.start) mt.start = r.start.toISOString();
      if (r.start && r.end) mt.mins = Math.max(5, Math.round((r.end - r.start) / 60000));
      if (r.location) mt.where = r.location;
      if (r.link) mt.link = r.link;
      mt.replies = Object.fromEntries(Object.entries(r.replies || {}).filter(([e, s]) => s !== 'organizer' && (mt.to || []).map((x) => x.toLowerCase()).includes(e)));
      Object.values(mt.replies).forEach((s) => { if (s === 'accepted') acc++; else if (s === 'declined') dec++; else wait++; });
    } catch (e) { save(); render(); return fail(e); }
  }
  save(); render();
  toast(list.length ? [acc && `${acc} accepted`, dec && `${dec} declined`, wait && `${wait} waiting`, gone && `${gone} cancelled`].filter(Boolean).join(', ') || 'No replies yet' : 'No invitations to check on this calendar.');
}

let staffEdit = null, repKind = 'client', outKind = null;
const ROLES = ['Chief of Staff', 'Legislative Director', 'Legislative Assistant', 'Scheduler', 'District Director', 'Communications Director', 'Committee staff'];
const isEmail = (v) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);
const copyBtn = (v) => `<button type="button" class="btn sm" data-copy="${esc(v)}">Copy</button>`;
let drawerClosing = null;
function showDrawer(html) {
  const d = $('#drawer'), sc = $('#scrim'), was = d.hidden || d.classList.contains('closing');
  if (drawerClosing) { clearTimeout(drawerClosing); drawerClosing = null; }
  d.classList.remove('closing'); sc.classList.remove('closing');
  d.innerHTML = html; d.hidden = false; sc.hidden = false; d.scrollTop = 0;
  if (was) { d.classList.remove('opening'); void d.offsetWidth; d.classList.add('opening'); }
  const f = $('button, input', d); if (f) f.focus({ preventScroll: true });
}
function closeDrawer() {
  openId = null; RQ = null; schedOpen = false; staffEdit = null; outKind = null;
  const d = $('#drawer'), sc = $('#scrim');
  if (!d.hidden && !REDUCED) {
    d.classList.remove('opening'); d.classList.add('closing'); sc.classList.add('closing');
    clearTimeout(drawerClosing); drawerClosing = setTimeout(() => { drawerClosing = null; d.hidden = true; sc.hidden = true; d.classList.remove('closing'); sc.classList.remove('closing'); }, 210);
  } else { d.hidden = true; sc.hidden = true; }
  const n = S.members.length; S.members = S.members.filter((m) => !m.draft); if (S.members.length !== n) render();
}
function contactBlock(m) {
  const c = contact(m), safe = (u) => /^https?:\/\//.test(u);
  const rows = [
    c.phone && ['Phone', `<span class="tel">${esc(c.phone)}</span> ${copyBtn(c.phone)}${c.phoneUsual ? ' <span class="note">usual number for this office</span>' : ''}`],
    c.email && ['Email', `${esc(c.email)} ${copyBtn(c.email)}${c.emailUsual ? ' <span class="note">usual format, confirm</span>' : ''}`],
    c.office && ['Capitol office', esc(c.office)],
    (c.dphone || c.doffice) && ['District office', `${esc(c.doffice)}${c.dphone ? ` <span class="tel">${esc(c.dphone)}</span> ${copyBtn(c.dphone)}` : ''}`],
    (safe(c.url) || safe(c.form)) && ['Online', [safe(c.url) && `<a href="${esc(c.url)}" target="_blank" rel="noopener">Official page</a>`, safe(c.form) && `<a href="${esc(c.form)}" target="_blank" rel="noopener">Contact form</a>`].filter(Boolean).join(' · ')],
  ].filter(Boolean);
  if (typeof actCount === 'function' && actCount(m)) rows.push(['Constituents', esc(actCount(m).replace(/^ · /, '')) + ' through the action center']);
  return rows.length ? `<span class="label">Contact</span><dl class="kv">${rows.map((r) => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('')}</dl>` : '';
}
function staffLines(s) {
  return `${s.phone ? `<div><span class="tel">${esc(s.phone)}</span> ${copyBtn(s.phone)}</div>` : ''}${s.email ? `<div>${esc(s.email)} ${copyBtn(s.email)}${s.fmt ? ' <span class="note">usual format, confirm</span>' : s.src === 'legistorm' ? ' <span class="note">from LegiStorm</span>' : ''}</div>` : ''}`;
}
function staffForm(s) {
  return `<form id="stForm" class="form" data-sid="${esc(s.id || '')}">
    <label>Name<input id="st_name" name="name" required value="${esc(s.name || '')}"></label>
    <label>Role<input id="st_role" name="role" list="st_roles" value="${esc(s.role || '')}" placeholder="Scheduler"></label>
    <label>Phone<input id="st_phone" name="phone" value="${esc(s.phone || '')}"></label>
    <label>Email<input id="st_email" name="email" value="${esc(s.email || '')}"></label>
    <label class="wide">Notes<input id="st_notes" name="notes" value="${esc(s.notes || '')}" placeholder="Handles energy and telecom; prefers email"></label>
    <div class="wide"><button class="btn primary">Save staff member</button> <button type="button" class="btn" data-act="cancelStaff">Cancel</button></div>
    <datalist id="st_roles">${ROLES.map((r) => `<option value="${r}">`).join('')}</datalist>
  </form>`;
}
function staffSection(m) {
  const item = (s) => (staffEdit === s.id ? `<li>${staffForm(s)}</li>` : `<li><div class="row"><span><b>${esc(s.name)}</b>${s.role ? ` · ${esc(s.role)}` : ''}</span>
      <span class="btnrow">${isEmail(s.email || '') ? `<button class="btn sm" data-act="rq" data-sid="${esc(s.id)}">Request a meeting</button>` : ''}<button class="btn sm" data-act="logStaff" data-sid="${esc(s.id)}">Log contact</button><button class="btn sm" data-act="editStaff" data-sid="${esc(s.id)}">Edit</button><button class="btn sm warn" data-act="rmStaff" data-sid="${esc(s.id)}">Remove</button></span></div>
      ${staffLines(s)}${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ''}</li>`);
  const key = presetKey(), has = m.staffers.some((s) => s.src === 'directory');
  if (key && m.ref && !has && STAFF[key] === undefined) staffFor(key).then(() => { if (openId === m.id && tab === 'staff') memberDrawer(m.id); });
  const avail = key && m.ref && !has && STAFF[key] ? (STAFF[key].people[m.ref] || []).length : 0;
  return `<span class="label">Staff</span>
  ${avail && canEditNow() ? `<div class="callout"><b>${avail} staff listed for this office</b> in the ${esc(STAFF[key].source)}. <button class="btn sm primary" data-act="addDirStaff">Add them</button><div class="note">Emails follow the chamber's usual format: confirm before relying on them.</div></div>` : ''}
  <ul class="hist">${m.staffers.length ? m.staffers.map(item).join('') : `<li class="note">${key === 'ussenate' ? 'The Senate does not publish staff lists. ' : ''}No staff added yet. Add the scheduler, the chief of staff or the aide who handles your issue.</li>`}</ul>
  ${staffEdit === 'new' ? staffForm({}) : m.staffers.length < 60 ? '<div><button class="btn sm" data-act="addStaff">Add staff member</button></div>' : ''}`;
}
function staffDirList() {
  const q = ($('#sd_q') ? $('#sd_q').value : '').trim().toLowerCase(), out = [];
  S.members.forEach((m) => m.staffers.forEach((s) => { if (!q || `${s.name} ${s.role} ${s.notes} ${m.name}`.toLowerCase().includes(q)) out.push({ m, s }); }));
  out.sort((a, b) => a.s.name.localeCompare(b.s.name));
  $('#sd_list').innerHTML = out.length ? out.map(({ m, s }) => `<li><b>${esc(s.name)}</b>${s.role ? ` · ${esc(s.role)}` : ''}
    <div class="note">Office of <button class="linkbtn" data-open="${esc(m.id)}">${esc(m.name)}</button> (${esc(m.party)}-${esc(m.district)}, ${POS[m.pos]})</div>${staffLines(s)}${s.notes ? `<div class="note">${esc(s.notes)}</div>` : ''}</li>`).join('')
    : `<li class="note">${q ? 'No staff match that search.' : 'No staff saved yet. Open a member and use "Add staff member".'}</li>`;
}
function staffDirDrawer() {
  showDrawer(`<div class="row"><h2>Staff directory</h2><button class="btn sm" data-act="close">Close</button></div>
  <input type="search" id="sd_q" placeholder="Search staff, role, notes or member" aria-label="Search staff">
  <ul class="hist" id="sd_list"></ul>`);
  staffDirList();
}
const REPORTS = { client: ['Client update', 'txt'], contacts: ['Contact log', 'csv'], whip: ['Whip count', 'csv'] };
function reportText() { return repKind === 'client' ? clientReport() : repKind === 'contacts' ? contactsCsv(($('#rep_from') && $('#rep_from').value) || daysAgo(90)) : whipCsv(); }
function reportsDrawer() {
  const from = ($('#rep_from') && $('#rep_from').value) || daysAgo(90);
  showDrawer(`<div class="row"><h2>Reports</h2><button class="btn sm" data-act="close">Close</button></div>
  <div class="seg" role="group" aria-label="Report">${Object.entries(REPORTS).map(([k, v]) => `<button data-rep="${k}" aria-pressed="${repKind === k}">${v[0]}</button>`).join('')}</div>
  <p class="note">${repKind === 'client' ? 'A plain-text status update you can paste into an email to a client or coalition.' : repKind === 'contacts' ? 'Every logged contact as a spreadsheet, for activity reporting and disclosure records. Check it against your own records before filing anything.' : 'The full roster with positions and contact details as a spreadsheet.'}</p>
  ${repKind === 'contacts' ? `<label class="note" style="display:flex;gap:8px;align-items:center">Contacts since <input type="date" id="rep_from" value="${esc(from)}"></label>` : ''}
  <textarea id="outText" class="out" style="min-height:340px" readonly aria-label="Report">${esc(reportText())}</textarea>
  <div class="btnrow"><button class="btn primary" data-act="copyOut">Copy</button><button class="btn" data-act="saveRep">Download</button></div>`);
}
function presetNote() {
  const sel = $('#s_preset'), p = ROSTERS && ROSTERS[sel.value], box = $('#s_presetBox');
  if (!p) { box.innerHTML = ''; return; }
  box.innerHTML = `${p.committees.length ? `<label class="note" style="display:flex;flex-direction:column;gap:4px">Committee stage<select id="s_cmte"><option value="-1">No committee marked</option>${p.committees.map((c, i) => `<option value="${i}">${esc(c.name)} (${c.m.length})</option>`).join('')}</select></label>` : '<p class="note">No committee lists for this chamber. Mark members yourself.</p>'}
    <label class="note" style="display:flex;flex-direction:column;gap:4px">Starting positions<select id="s_backed"><option value="">Everyone undecided</option><option value="D">Democrats lean yes, Republicans lean no</option><option value="R">Republicans lean yes, Democrats lean no</option></select></label>
    <p class="note">${p.members.length} of ${p.seats} seats listed, with office phone${p.members[0].em ? ', email' : ''} and address. Source: ${esc(p.source)}, retrieved ${esc(p.asOf)}.${p.stale ? ' <b>This roster predates the November 3, 2026 election and has not been updated for new members.</b>' : ''} This replaces the current roster, its staff and its history.</p>
    <button class="btn" data-act="preset">Load ${esc(p.label)}</button>`;
}
function parseRoster(text) {
  const posOf = (s) => { const i = POS.findIndex((p) => p.toLowerCase() === s.toLowerCase().trim()); return i < 0 ? 2 : i; };
  return text.split(/\r?\n/).map((l) => l.split(/[,\t]/).map((x) => x.trim())).filter((r) => r[0] && r[0].toLowerCase() !== 'name').map((r) => ({
    id: uid(), name: r[0].slice(0, 80), party: /^[DRI]$/i.test(r[1] || '') ? r[1].toUpperCase() : 'I', district: (r[2] || '').slice(0, 12),
    cmte: /^(y|yes|1|true)$/i.test(r[3] || ''), pos: posOf(r[4] || ''), mov: 3, follows: '', interests: '', notes: '', history: [], staffers: [], phone: (r[5] || '').slice(0, 40), email: (r[6] || '').slice(0, 120) }));
}
// ---------- workspaces ----------
let MAIL_PROBLEM = null, OPERATOR = false, ORGS = [], ORG = null, CLIENTS = [], DOMAIN_MATCHES = [], PREFS = null, SSO_NEEDED = null, SSO_STEP = null, TFA_NEEDED = null;
const WS = { members: null, invites: null, audit: null, auditMore: true, report: null, lastInvite: null, loading: false, filter: { client: '', q: '', archived: false } };
const LASTORG = 'headcount.lastOrg';
const cfg2 = () => CLOUD.config || {};
const GUIDE = '/guide'; // the step-by-step guide; the free in-browser version points at the website's copy
const isAdmin = () => ORG && (ORG.role === 'owner' || ORG.role === 'admin');
const clientOf = (st = S) => (st.cloud && st.campaign.clientId ? (CLIENTS.find((k) => k.id === st.campaign.clientId) || {}).name || '' : st.campaign.client || '');
const firmOf = (st = S) => (st.cloud && ORG ? ORG.name : '');
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const limitText = (used, max) => (max === null || max === undefined ? `${used}` : `${used} of ${max}`);
function fail(e) { if (e && e.twoFactor) { TFA_NEEDED = e.workspace || 'This workspace'; render(); return toast(e.message); } if (e && e.sso) { SSO_NEEDED = e.workspace || 'This workspace'; render(); return toast(e.message); } if (e && e.upgrade) notify(e.message, isAdmin() ? 'See plans' : '', 'gotoPlans'); else toast(e && e.message ? e.message : String(e)); }
function notify(msg, label, act) {
  const t = $('#toast'); t.innerHTML = `${esc(msg)}${label ? ` <button class="btn sm" data-act="${act}">${esc(label)}</button>` : ''}`; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 7000);
}

async function loadOrg(oid, { quiet } = {}) {
  try {
    const [info, cl] = await Promise.all([CLOUD.api('GET', `/api/workspaces/${oid}`), CLOUD.api('GET', `/api/workspaces/${oid}/clients`)]);
    const changed = !ORG || ORG.id !== oid;
    ORG = info; CLIENTS = cl.clients; lsSet(LASTORG, oid);
    if (changed) { WS.members = WS.invites = WS.audit = WS.report = WS.lastInvite = null; WS.auditMore = true; ACCOUNT.list = []; }
    await refreshAccount();
    return true;
  } catch (e) { if (!quiet) fail(e); return false; }
}
async function switchOrg(oid) {
  await flushNow();
  if (!(await loadOrg(oid))) return render();
  if (S.cloud) { stopPoll(); SYNC = newSync(null); if (!loadLocal()) goExample(); }
  const last = lsGet(LAST);
  if (last && ACCOUNT.list.some((e) => e.id === last)) return cloudOpen(last);
  page = 'portfolio'; render();
}
async function createOrg(name) {
  try {
    const r = await CLOUD.api('POST', '/api/workspaces', { name });
    ORGS = (await CLOUD.api('GET', '/api/workspaces')).workspaces;
    await loadOrg(r.id); page = 'workspace'; render();
    toast(`${r.name} created. Invite your team next.`);
  } catch (e) { fail(e); }
}
function summaryOf(st) {
  const nd = needs(st), base = passage(st.members, baseProbs(st), nd), c = st.campaign;
  const ups = st.meetings.filter((x) => x.status === 'requested' || x.status === 'invited').sort((a, b) => String(a.start || a.sentAt).localeCompare(String(b.start || b.sentAt)));
  return {
    odds: st.members.length ? Math.round(goal(st, base.both) * 1000) / 1000 : null, side: c.side, n: nd.n, needF: nd.needF,
    counts: [4, 3, 2, 1, 0].map((p) => st.members.filter((m) => m.pos === p).length), trend: (st.trend || []).slice(-12),
    cmteDate: c.cmteDate || '', floorDate: c.floorDate || '', bill: billNumberOf(st), leg: billLegislature(st), session: st.brief.session || '', billStatus: st.brief.status || '',
    requested: ups.filter((x) => x.status === 'requested').length, meetings: ups.filter((x) => x.status === 'invited').slice(0, 3).map((x) => ({ start: x.start, title: x.title })),
    openTasks: st.tasks.filter((t) => !t.done).length, dueDates: st.tasks.filter((t) => !t.done && t.due).map((t) => t.due).sort().slice(0, 20),
  };
}

// ---------- getting started ----------
// A short checklist for a new workspace, until it is done or hidden.
function gettingStarted() {
  if (!ORG || ORG.role === 'guest' || !ORG.setup || lsGet('headcount.gs.' + ORG.id)) return '';
  const st = ORG.setup, cfg = CLOUD.config || {}, how = (id) => ` <a class="note" href="${GUIDE}#${id}" target="_blank" rel="noopener">How?</a>`;
  // For whoever runs Headcount: the two things everyone else depends on
  const admin = OPERATOR ? [
    [Boolean(cfg.email) && !MAIL_PROBLEM, 'Connect email', 'For invitations, password resets and digests.', '<button class="btn sm" data-x="serverSettings" data-open="email">Connect email</button>', 'admin-email'],
    [Boolean(cfg.bills && cfg.bills.federal && cfg.bills.states), 'Turn on bill data', 'Two free keys load bills and every legislature.', '<button class="btn sm" data-x="serverSettings" data-open="sources">Add the free keys</button>', 'admin-data'],
  ] : [];
  const steps = [...admin,
    [ACCOUNT.list.some((c) => c.summary && c.summary.n > 0), 'Count your first bill', 'Pick a legislature and type the bill number.', '<button class="btn sm" data-act="newCamp">New campaign</button>', 'first-count'],
    [ORG.usage.seats > 1 || st.invites > 0, 'Invite a colleague', 'Everyone sees the same count, live.', '<button class="btn sm" data-page="workspace">Invite</button>', 'invite'],
    [st.watches > 0, 'Watch for new bills', 'Hear about new bills and rules on your issues.', '<button class="btn sm" data-page="monitor">Open the Monitor</button>', 'monitor'],
  ];
  const done = steps.filter((x) => x[0]).length;
  if (done === steps.length) return '';
  return `<div class="panel getting"><div class="row"><span class="label">Getting started · ${done} of ${steps.length}</span><button class="btn sm" data-act="hideGetting">Hide</button></div>
    <div class="gbar" aria-hidden="true"><i style="width:${Math.round((done / steps.length) * 100)}%"></i></div>
    <ol class="gsteps">${steps.map(([ok, t, d, btn, id]) => `<li class="${ok ? 'done' : ''}"><span class="gcheck" aria-hidden="true"></span><div><b>${t}</b><span class="note">${d}${ok ? '' : how(id)}</span></div>${ok ? '<span class="status ok">Done</span>' : btn}</li>`).join('')}</ol>
    <p class="note">New here? Read the <a href="${GUIDE}" target="_blank" rel="noopener">guide</a>.</p></div>`;
}

// ---------- bills you follow ----------
// Every bill the team follows, with or without a whip count: the team's
// position, priority and client, where each stands, its next hearing and what
// moved. Lists can be shared as a public page or embedded on a website.
const POSITION = { support: ['Support', 'good'], oppose: ['Oppose', 'bad'], watch: ['Watching', 'muted'], amend: ['Seeking changes', 'warn'] };
let BILLS = { oid: '', at: 0, bills: null, shares: [], adding: false, f: { q: '', pos: '', leg: '', client: '', sort: 'moved' } };
async function loadBills(force = false) {
  if (!ORG || !signedIn() || typeof wsPath !== 'function') return;
  if (!force && BILLS.oid === ORG.id && BILLS.bills && Date.now() - BILLS.at < 60e3) return;
  const oid = ORG.id;
  try { const r = await CLOUD.api('GET', wsPath('/bills')); if (ORG && ORG.id === oid) { Object.assign(BILLS, { oid, at: Date.now(), bills: r.bills, shares: r.shares }); if (page === 'bills') renderBills(); } }
  catch (e) { if (page === 'bills') $('#billsPage').innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; }
}
const legLabel = (j) => (j === 'US' ? 'Congress' : ((CLOUD.config || {}).states || {})[j] || j);
function billAddForm() {
  const states = (CLOUD.config || {}).states || {}, last = lastLeg();
  return `<form id="tbForm" class="form panel" style="animation:popIn .2s var(--spring)">
    <div class="row wide"><span class="label">Follow a bill</span><button type="button" class="btn sm" data-act="tbCancel">Cancel</button></div>
    <label>Legislature<select id="tb_leg" name="juris" required><option value="US" ${last === 'US' ? 'selected' : ''}>U.S. Congress</option>${Object.entries(states).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="${k}" ${k === last ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label>Bill number<input id="tb_num" name="number" required placeholder="HB 123, SB 45, H.R. 1234" autocomplete="off"></label>
    <p class="wide note" style="margin-top:-4px"><button type="button" class="linkbtn" data-act="tbSearchToggle">Don't know the number? Search by topic</button></p>
    <div class="wide nsearch" id="tbSearch" hidden><div class="btnrow"><input id="tbs_q" placeholder="A few words, like sales tax or broadband" aria-label="Search bills by topic" autocomplete="off"><button type="button" class="btn" data-act="tbSearch">Search</button></div><div id="tbs_out" class="ns-out" role="status"></div></div>
    <label>Our position<select name="position">${Object.entries(POSITION).map(([k, v]) => `<option value="${k}" ${k === 'watch' ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
    <label>Priority<select name="priority"><option value="high">High</option><option value="normal" selected>Normal</option><option value="low">Low</option></select></label>
    <label>Client<select name="clientId"><option value="">No client</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('')}</select></label>
    <input type="hidden" name="title" id="tb_title"><input type="hidden" name="session" id="tb_session">
    <label class="wide">Notes for the team <span class="note">(optional, never shared)</span><textarea name="notes" rows="2" placeholder="Why it matters to the client, who to talk to"></textarea></label>
    <div class="wide btnrow"><button class="btn primary">Follow this bill</button><span class="note" id="tbMsg" role="status"></span></div>
  </form>`;
}
function renderBills() {
  const el = $('#billsPage'); if (!el) return;
  if (!ORG) { el.innerHTML = ''; return; }
  if (BILLS.oid !== ORG.id || !BILLS.bills) { el.innerHTML = '<div class="panel empty">Loading the bills you follow</div>'; loadBills(true); return; }
  loadBills();
  const f = BILLS.f, q = f.q.trim().toLowerCase(), todayIso = today();
  const next = (b) => (b.hearings || []).filter((h) => h.date >= todayIso).sort((x, y) => x.date.localeCompare(y.date))[0];
  let list = BILLS.bills.filter((b) => (!f.pos || b.position === f.pos) && (!f.leg || b.juris === f.leg) && (!f.client || b.clientId === f.client) && (!q || `${b.number} ${b.title} ${b.client} ${b.notes || ''} ${b.now}`.toLowerCase().includes(q)));
  const prio = { high: 0, normal: 1, low: 2 };
  list = list.slice().sort((a, b) => f.sort === 'hearing' ? String((next(a) || {}).date || '9999').localeCompare(String((next(b) || {}).date || '9999'))
    : f.sort === 'priority' ? (prio[a.priority] - prio[b.priority]) || String(a.number).localeCompare(String(b.number), undefined, { numeric: true })
      : f.sort === 'number' ? String(a.juris + a.number).localeCompare(String(b.juris + b.number), undefined, { numeric: true })
        : (b.changedAt || 0) - (a.changedAt || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  const legs = [...new Set(BILLS.bills.map((b) => b.juris))], counts = Object.fromEntries(Object.keys(POSITION).map((k) => [k, BILLS.bills.filter((b) => b.position === k).length]));
  const hearingsSoon = BILLS.bills.filter((b) => { const h = next(b); return h && dayDiff(h.date) <= 14; }).length, moved = BILLS.bills.filter((b) => b.changedAt && Date.now() - b.changedAt < 7 * 864e5).length;
  const row = (b) => { const h = next(b), [pw, tone] = POSITION[b.position] || POSITION.watch, fresh = b.changedAt && Date.now() - b.changedAt < 3 * 864e5;
    return `<tr class="prow" data-bill="${esc(b.id)}" tabindex="0">
      <td><b>${esc(b.number)}</b>${b.priority === 'high' ? ' <span class="prio" title="High priority">High</span>' : ''}<div class="meta">${esc(legLabel(b.juris))}${b.session ? ` · ${esc(b.session)}` : ''}</div></td>
      <td><span class="btitle">${esc(clipWords(b.title || '', 120))}</span>${b.client ? `<div class="meta">${esc(b.client)}</div>` : ''}</td>
      <td><span class="pchip ${tone}">${pw}</span>${b.campaignId ? `<div class="meta">${b.odds !== null && b.odds !== undefined ? `${pct(b.odds)}% odds` : 'Whip count'}</div>` : ''}</td>
      <td>${b.now ? `${fresh ? '<span class="dot fresh" title="Moved in the last three days"></span> ' : ''}${esc(b.now)}` : '<span class="meta">Reading the record</span>'}${h ? `<div class="hmeta">Hearing ${esc(fmtDay(h.date))}${h.time ? `, ${esc(h.time)}` : ''}${h.committee ? ` · ${esc(h.committee)}` : ''}</div>` : ''}</td></tr>`; };
  el.innerHTML = `${BILLS.adding ? billAddForm() : ''}
    <div class="panel">
      <div class="row"><span class="label">Bills you follow</span><span class="btnrow"><button class="btn sm" data-act="tbShare">Share the list</button><button class="btn sm primary" data-act="tbAdd">Follow a bill</button></span></div>
      ${BILLS.bills.length ? `<div class="bstats"><div><b>${BILLS.bills.length}</b><span>bills</span></div><div><b class="${counts.support ? 'good' : ''}">${counts.support}</b><span>support</span></div><div><b class="${counts.oppose ? 'bad' : ''}">${counts.oppose}</b><span>oppose</span></div><div><b>${counts.watch + counts.amend}</b><span>watching or seeking changes</span></div><div><b class="${moved ? 'warn' : ''}">${moved}</b><span>moved this week</span></div><div><b>${hearingsSoon}</b><span>hearings in two weeks</span></div></div>
      <div class="btnrow filters"><input id="bl_q" placeholder="Find a bill, client or note" value="${esc(f.q)}" aria-label="Find a bill">
        <select id="bl_pos" aria-label="Position"><option value="">Every position</option>${Object.entries(POSITION).map(([k, v]) => `<option value="${k}" ${f.pos === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
        ${legs.length > 1 ? `<select id="bl_leg" aria-label="Legislature"><option value="">Every legislature</option>${legs.map((j) => `<option value="${j}" ${f.leg === j ? 'selected' : ''}>${esc(legLabel(j))}</option>`).join('')}</select>` : ''}
        ${CLIENTS.length ? `<select id="bl_client" aria-label="Client"><option value="">Every client</option>${CLIENTS.map((k) => `<option value="${esc(k.id)}" ${f.client === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select>` : ''}
        <select id="bl_sort" aria-label="Sort"><option value="moved" ${f.sort === 'moved' ? 'selected' : ''}>Recently moved</option><option value="hearing" ${f.sort === 'hearing' ? 'selected' : ''}>Next hearing</option><option value="priority" ${f.sort === 'priority' ? 'selected' : ''}>Priority</option><option value="number" ${f.sort === 'number' ? 'selected' : ''}>Bill number</option></select></div>
      <div class="tablewrap"><table class="ptable btable"><thead><tr><th>Bill</th><th>What it is</th><th>Position</th><th>Where it stands</th></tr></thead><tbody>${list.map(row).join('') || '<tr><td colspan="4" class="note">No bills match.</td></tr>'}</tbody></table></div>`
    : `<div class="empty-hint"><p><b>Follow every bill that matters, not only the ones you count.</b> Add a bill by number or topic, mark whether you support or oppose it, and Headcount reads where it stands every few hours: its committee, its next hearing, every move, in plain words. Moves go in your digest.</p><button class="btn primary" data-act="tbAdd">Follow your first bill</button></div>`}
    </div>
    ${BILLS.shares.length || BILLS.sharing ? sharePanel() : ''}`;
}
function sharePanel() {
  const embed = (u) => `<iframe src="${u}?embed=1" width="100%" height="520" style="border:0" title="Bills we follow"></iframe>`;
  return `<div class="panel"><span class="label">Shared lists</span>
    <p class="note">A read-only page for clients or your website. Notes stay private. Anyone with the link can see it.</p>
    ${isAdmin() ? `<div class="btnrow"><select id="sh_client" aria-label="Which bills"><option value="">Every bill in ${esc(ORG.name)}</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}">Only ${esc(k.name)}'s bills</option>`).join('')}</select><button class="btn sm primary" data-act="tbShareMake">Create a link</button></div>` : '<p class="note">An admin creates the links.</p>'}
    <ul class="shares">${BILLS.shares.map((x) => `<li><div><b>${esc(x.client ? `${x.client}'s bills` : `Every bill in ${ORG.name}`)}</b><div class="meta">${esc(x.url)}</div></div><span class="btnrow"><a class="btn sm" href="${esc(x.url)}" target="_blank" rel="noopener">Open</a><button class="btn sm" data-act="tbCopy" data-v="${esc(x.url)}">Copy link</button><button class="btn sm" data-act="tbCopy" data-v="${esc(embed(x.url))}">Copy embed code</button>${isAdmin() ? `<button class="btn sm warn" data-act="tbShareOff" data-token="${esc(x.token)}">Turn off</button>` : ''}</span></li>`).join('')}</ul></div>`;
}
async function billDrawer(id) {
  const b = (BILLS.bills || []).find((x) => x.id === id); if (!b) return;
  if (b.campaignId) return cloudOpen(b.campaignId).then(() => { page = 'brief'; render(); });
  const head = `<div class="row"><h2>${esc(b.number)}</h2><button class="btn sm" data-act="close">Close</button></div><p class="note">${esc(legLabel(b.juris))}${b.session ? ` · ${esc(b.session)}` : ''}${b.client ? ` · ${esc(b.client)}` : ''}</p>${b.title ? `<p>${esc(b.title)}</p>` : ''}`;
  const form = `<form id="tbEdit" class="form" data-id="${esc(b.id)}">
    <label class="wide">Name on your list<input name="title" value="${esc(b.title || '')}" maxlength="400" placeholder="What the bill does, in your words"></label>
    <label>Our position<select name="position">${Object.entries(POSITION).map(([k, v]) => `<option value="${k}" ${b.position === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
    <label>Priority<select name="priority">${['high', 'normal', 'low'].map((k) => `<option value="${k}" ${b.priority === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select></label>
    <label class="wide">Client<select name="clientId"><option value="">No client</option>${CLIENTS.filter((k) => !k.archived || k.id === b.clientId).map((k) => `<option value="${esc(k.id)}" ${k.id === b.clientId ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
    <label class="wide">Notes for the team<textarea name="notes" rows="3">${esc(b.notes || '')}</textarea></label>
    <div class="wide btnrow"><button class="btn primary">Save</button><button type="button" class="btn" data-act="tbCount" data-id="${esc(b.id)}">Start a whip count</button><button type="button" class="btn warn" data-act="tbRemove" data-id="${esc(b.id)}">Stop following</button></div></form>`;
  showDrawer(`${head}${form}<p class="note">Reading the bill's record</p>`);
  try {
    const q = new URLSearchParams({ jurisdiction: b.juris, number: b.number }); if (b.session) q.set('session', b.session);
    const d = await CLOUD.api('GET', `/api/bills/story?${q}`);
    if ($('#tbEdit') && $('#tbEdit').dataset.id === b.id) showDrawer(`${head}${storyPanelHtml({ d, leg: b.juris, number: b.number })}${form}`);
  } catch (e) { if ($('#tbEdit') && $('#tbEdit').dataset.id === b.id) showDrawer(`${head}<p class="note">${esc(e.message)}</p>${form}`); }
}
async function billListSearch() {
  const out = $('#tbs_out'), q = $('#tbs_q').value.trim(), leg = $('#tb_leg').value;
  if (q.length < 3) { out.innerHTML = '<p class="note">Type a few words about the bill.</p>'; return; }
  out.innerHTML = `<p class="note">Searching ${esc(legLabel(leg))}</p>`;
  try {
    const r = await CLOUD.api('GET', `/api/bills/search?${new URLSearchParams({ leg, q })}`);
    out.innerHTML = r.bills.length ? `<ul class="ns-list">${r.bills.map((b) => `<li><div><b>${esc(b.number)}</b> <span class="meta">${esc(b.session)}</span><div>${esc(clipWords(b.title, 160))}</div><div class="meta">${esc(b.status)}</div></div><button type="button" class="btn sm" data-act="tbPick" data-n="${esc(b.number)}" data-title="${esc(b.title)}" data-s="${esc(b.session)}">Choose</button></li>`).join('')}</ul>` : `<p class="note">Nothing in ${esc(legLabel(leg))} matches. Try other words.</p>`;
  } catch (e) { out.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

// ---------- legislators ----------
// Every legislator in any campaign: where they stand on each of your bills,
// how often they are with you, and when anyone last talked to them.
let PEOPLE_PAGE = { oid: '', at: 0, list: null, f: { q: '', sort: 'bills', show: '' } };
async function loadPeople2(force = false) {
  if (!ORG || !signedIn() || typeof wsPath !== 'function') return;
  if (!force && PEOPLE_PAGE.oid === ORG.id && PEOPLE_PAGE.list && Date.now() - PEOPLE_PAGE.at < 60e3) return;
  const oid = ORG.id;
  try { const r = await CLOUD.api('GET', wsPath('/legislators')); if (ORG && ORG.id === oid) { Object.assign(PEOPLE_PAGE, { oid, at: Date.now(), list: r.people }); if (page === 'people') renderPeople(); } }
  catch (e) { if (page === 'people') $('#peoplePage').innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; }
}
const partyWord = (p) => ({ D: 'Democrat', R: 'Republican', I: 'Independent' })[p] || p || '';
function renderPeople() {
  const el = $('#peoplePage'); if (!el || !ORG) return;
  if (PEOPLE_PAGE.oid !== ORG.id || !PEOPLE_PAGE.list) { el.innerHTML = '<div class="panel empty">Gathering everyone from your campaigns</div>'; loadPeople2(true); return; }
  loadPeople2();
  const f = PEOPLE_PAGE.f, q = f.q.trim().toLowerCase();
  let list = PEOPLE_PAGE.list.filter((p) => (!q || `${p.name} ${p.district} ${p.chamber} ${partyWord(p.party)}`.toLowerCase().includes(q))
    && (!f.show || (f.show === 'with' ? p.withUs > 0 && !p.against : f.show === 'against' ? p.against > 0 : f.show === 'split' ? p.withUs > 0 && p.against > 0 : f.show === 'never' ? !p.lastContact : true)));
  list = list.slice().sort((a, b) => f.sort === 'score' ? (b.score ?? -1) - (a.score ?? -1) : f.sort === 'contact' ? String(a.lastContact || '0').localeCompare(String(b.lastContact || '0')) : f.sort === 'name' ? a.name.localeCompare(b.name) : b.bills - a.bills || a.name.localeCompare(b.name));
  const total = PEOPLE_PAGE.list.length, never = PEOPLE_PAGE.list.filter((p) => !p.lastContact).length, allies = PEOPLE_PAGE.list.filter((p) => p.score !== null && p.score >= 75).length;
  const chip = (x) => `<span class="pchip ${x.withUs ? 'good' : x.against ? 'bad' : 'muted'}" title="${esc(x.campaign)}">${esc(x.word)}</span>`;
  el.innerHTML = total ? `<div class="panel">
    <div class="row"><span class="label">Everyone in your campaigns</span><span class="note">${total} legislators</span></div>
    <div class="bstats"><div><b>${total}</b><span>legislators</span></div><div><b class="${allies ? 'good' : ''}">${allies}</b><span>with you on most bills</span></div><div><b class="${never ? 'warn' : ''}">${never}</b><span>no contact logged yet</span></div></div>
    <div class="btnrow filters"><input id="pp_q" placeholder="Find a legislator or district" value="${esc(f.q)}" aria-label="Find a legislator">
      <select id="pp_show" aria-label="Show"><option value="">Everyone</option><option value="with" ${f.show === 'with' ? 'selected' : ''}>Only with you</option><option value="against" ${f.show === 'against' ? 'selected' : ''}>Against you on a bill</option><option value="split" ${f.show === 'split' ? 'selected' : ''}>With you on some, against on others</option><option value="never" ${f.show === 'never' ? 'selected' : ''}>No contact logged</option></select>
      <select id="pp_sort" aria-label="Sort"><option value="bills" ${f.sort === 'bills' ? 'selected' : ''}>Most of your bills</option><option value="score" ${f.sort === 'score' ? 'selected' : ''}>Most often with you</option><option value="contact" ${f.sort === 'contact' ? 'selected' : ''}>Longest since contact</option><option value="name" ${f.sort === 'name' ? 'selected' : ''}>Name</option></select></div>
    <div class="tablewrap"><table class="ptable btable"><thead><tr><th>Legislator</th><th>With you</th><th>On your bills</th><th>Last contact</th></tr></thead><tbody>
    ${list.slice(0, 400).map((p) => `<tr class="prow" data-person="${esc(p.key)}" tabindex="0"><td><b>${esc(p.name)}</b><div class="meta">${esc([partyWord(p.party), p.district ? `District ${p.district}` : '', p.chamber].filter(Boolean).join(' · '))}</div></td>
      <td>${p.score === null ? '<span class="meta">No positions yet</span>' : `<div class="score-bar" title="With you on ${p.withUs} of ${p.bills} bills"><i style="width:${p.score}%"></i></div><span class="meta">${p.withUs} of ${p.bills} bill${p.bills === 1 ? '' : 's'}</span>`}</td>
      <td class="chips">${p.positions.slice(0, 4).map(chip).join(' ')}${p.positions.length > 4 ? ` <span class="meta">+${p.positions.length - 4}</span>` : ''}</td>
      <td>${p.lastContact ? `${esc(fmtDay(p.lastContact))}<div class="meta">${esc(inDays(p.lastContact))} · ${p.contacts} contact${p.contacts === 1 ? '' : 's'}</div>` : '<span class="meta">Never</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="note">No one matches.</td></tr>'}
    </tbody></table></div>${list.length > 400 ? `<p class="note">Showing 400 of ${list.length}. Search to narrow it.</p>` : ''}</div>`
    : '<div class="panel"><div class="empty-hint"><p><b>Legislators appear here once a campaign has members.</b> Each one gets a profile across all your bills: where they stand on each, how often they are with you, and every call and meeting your team has logged.</p><button class="btn primary" data-act="newCamp">Start a campaign</button></div></div>';
}
async function personDrawer(key) {
  showDrawer('<div class="row"><h2>Loading</h2><button class="btn sm" data-act="close">Close</button></div>');
  try {
    const p = await CLOUD.api('GET', wsPath(`/legislators/${encodeURIComponent(key)}`));
    const tel = (n) => `<a href="tel:${esc(String(n).replace(/[^0-9+]/g, ''))}">${esc(n)}</a>`;
    showDrawer(`<div class="row"><h2 id="personName">${esc(p.name)}</h2><button class="btn sm" data-act="close">Close</button></div>
      <p class="note">${esc([partyWord(p.party), p.district ? `District ${p.district}` : '', p.chamber].filter(Boolean).join(' · '))} · <button class="linkbtn" data-act="renamePerson" data-key="${esc(p.key)}" data-name="${esc(p.name)}">Fix the name</button></p>
      <div class="bstats"><div><b class="${p.score !== null && p.score >= 50 ? 'good' : p.score !== null ? 'bad' : ''}">${p.score === null ? '–' : `${p.score}%`}</b><span>with you</span></div><div><b>${p.bills}</b><span>of your bills</span></div><div><b>${p.contacts}</b><span>contacts logged</span></div></div>
      ${p.phone || p.email || p.office ? `<p>${[p.phone && tel(p.phone), p.email && `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`, p.office && esc(p.office)].filter(Boolean).join(' · ')}</p>` : ''}
      <span class="label">Where they stand</span>
      <ul class="moves">${p.positions.map((x) => `<li><span class="pchip ${x.withUs ? 'good' : x.against ? 'bad' : 'muted'}">${esc(x.word)}</span> <button class="linkbtn" data-opencamp="${esc(x.campaignId)}">${esc(x.campaign)}</button> <span class="meta">${x.side === 'defeat' ? 'you oppose it' : 'you support it'}${x.committee ? ' · on the committee' : ''}${x.role ? ` (${esc(x.role)})` : ''}</span></li>`).join('')}</ul>
      ${p.committees.length ? `<span class="label">Committees in your campaigns</span><p>${p.committees.map(esc).join('; ')}</p>` : ''}
      ${p.staff.length ? `<span class="label">Staff</span><ul class="moves">${p.staff.map((s) => `<li><b>${esc(s.name)}</b>${s.title ? `, ${esc(s.title)}` : ''}${s.email ? ` · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''}${s.phone ? ` · ${tel(s.phone)}` : ''}</li>`).join('')}</ul>` : ''}
      <span class="label">History with your team</span>
      ${p.history.length ? `<ul class="moves">${p.history.slice(0, 40).map((h) => `<li><span class="when">${esc(fmtDay(h.d))}</span> · <b>${esc(h.type)}</b>${h.note ? `: ${esc(h.note)}` : ''} <span class="meta">${esc(h.campaign)}${h.by ? ` · ${esc(h.by)}` : ''}</span></li>`).join('')}</ul>` : '<p class="note">Nothing logged yet. Log calls and meetings from a campaign\'s member panel.</p>'}`);
  } catch (e) { showDrawer(`<div class="row"><h2>Legislator</h2><button class="btn sm" data-act="close">Close</button></div><p class="bad">${esc(e.message)}</p>`); }
}

// ---------- the first thing a new team sees ----------
// One question instead of a checklist: the bill. A number makes the campaign
// straight away (the chamber comes from where the bill is now); a few words
// search the legislature first.
function fastStart() {
  if (!ORG || ORG.role === 'guest' || ACCOUNT.list.some((c) => !c.archived)) return '';
  const legs = legOptions(), last = lastLeg() || (legs.find(([k]) => k === 'FL') || legs[0] || [''])[0];
  return `<div class="panel faststart"><span class="label">Start here</span>
    <h2>What bill are you working on?</h2>
    <form id="fsForm" class="fsrow"><select id="fs_leg" aria-label="Legislature">${legs.map(([k, v]) => `<option value="${k}" ${k === last ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <input id="fs_bill" placeholder="HB 1021, or a few words like property insurance" aria-label="Bill number or topic" autocomplete="off" required><button class="btn primary">Count it</button></form>
    <div id="fs_out" role="status"></div>
    <p class="note">Every member loads with their staff, and votes fill in from the public record. About ten seconds.</p></div>`;
}
const looksLikeNumber = (t) => /^\s*(h\.?\s?r\.?|s\.?|[a-z]{1,5}\.?)\s*\d{1,5}\b/i.test(t);
function fastCreate(bill, leg, session = '') {
  track('fast_start');
  newCampDrawer();
  $('#n_bill').value = bill; const ls = $('#n_leg'); if (ls && [...ls.options].some((o) => o.value === leg)) ls.value = leg;
  if (session) $('#nForm').dataset.session = session;
  nChamberSync(true);
  $('#nForm').requestSubmit();
}
async function fastSearch(q, leg) {
  const out = $('#fs_out'); out.innerHTML = `<p class="note">Searching ${esc(legLabel(leg))}</p>`;
  try {
    const r = await CLOUD.api('GET', `/api/bills/search?${new URLSearchParams({ leg, q })}`); track('search_used');
    out.innerHTML = r.bills.length ? `<ul class="ns-list">${r.bills.slice(0, 8).map((b) => `<li><div><b>${esc(b.number)}</b> <span class="meta">${esc(b.session)}</span><div>${esc(clipWords(b.title, 150))}</div><div class="meta">${esc(b.status)}</div></div><button type="button" class="btn sm primary" data-act="fsPick" data-n="${esc(b.number)}" data-title="${esc(b.title)}" data-leg="${esc(b.leg)}" data-s="${esc(b.session)}">Count this bill</button></li>`).join('')}</ul>` : `<p class="note">Nothing in ${esc(legLabel(leg))} matches. Try the bill number or other words.</p>`;
  } catch (e) { out.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

// ---------- portfolio ----------
// Today: where every bill stands, hearings coming up and what moved this week,
// from the server's own reading of each bill.
let TODAY = { oid: '', at: 0, bills: null };
async function loadToday() {
  if (!ORG || !signedIn() || ORG.role === 'guest' || typeof wsPath !== 'function') return;
  if (TODAY.oid === ORG.id && Date.now() - TODAY.at < 5 * 60e3) return;
  const oid = ORG.id; TODAY = { oid, at: Date.now(), bills: TODAY.oid === oid ? TODAY.bills : null };
  try { const r = await CLOUD.api('GET', wsPath('/today')); if (TODAY.oid === oid) { TODAY.bills = r.bills || []; if (page === 'portfolio') renderPortfolio(); } }
  catch (_) { /* the portfolio works without it */ }
}
const todayOf = (id) => (TODAY.bills || []).find((b) => b.id === id);
function renderPortfolio() {
  const el = $('#portfolioPage');
  if (!signedIn()) { el.innerHTML = `<div class="panel empty">${CLOUD.canSignIn() ? 'Sign in to see every campaign in your workspace in one place. <button class="btn sm primary" data-act="signin">Sign in</button>' : 'The portfolio is part of the full version of Headcount, with accounts. This free version keeps everything in your browser.'}</div>`; return; }
  if (!ORG) { el.innerHTML = '<div class="panel empty">Create or join a workspace to see your portfolio. <button class="btn sm primary" data-page="workspace">Set up a workspace</button></div>'; return; }
  const f = WS.filter, q = f.q.trim().toLowerCase();
  const list = ACCOUNT.list.filter((c) => (f.archived || !c.archived) && (!f.client || c.clientId === f.client) && (!q || `${c.name} ${c.client} ${(c.summary || {}).bill || ''}`.toLowerCase().includes(q)));
  const soonest = (s) => [['Committee vote', s.cmteDate], ['Floor vote', s.floorDate]].filter((x) => x[1] && dayDiff(x[1]) >= 0).sort((a, b) => a[1].localeCompare(b[1]))[0];
  const upcoming = [];
  ACCOUNT.list.filter((c) => !c.archived && c.summary).forEach((c) => {
    const s = c.summary;
    [['Committee vote', s.cmteDate], ['Floor vote', s.floorDate]].forEach(([k, d]) => { if (d && dayDiff(d) >= 0 && dayDiff(d) <= 14) upcoming.push({ when: d + 'T00:00', label: `${k}: ${c.name}`, id: c.id, day: true }); });
    (s.meetings || []).forEach((m) => { const t = new Date(m.start); if (t > Date.now() && t - Date.now() < 7 * 864e5) upcoming.push({ when: m.start, label: m.title, id: c.id }); });
  });
  (TODAY.oid === ORG.id && TODAY.bills || []).forEach((b) => (b.hearings || []).forEach((h) => { if (dayDiff(h.date) >= 0 && dayDiff(h.date) <= 14) upcoming.push({ when: hearingStart(h).toISOString(), label: `Hearing: ${b.bill}, ${h.committee ? `${h.committee}${/committee/i.test(h.committee) ? '' : ' committee'}` : 'committee'}${h.room ? ` (${h.room})` : ''}`, id: b.id, hearing: h, bill: b.bill, day: !h.time }); }));
  upcoming.sort((a, b) => String(a.when).localeCompare(String(b.when)));
  const moved = (TODAY.oid === ORG.id && TODAY.bills || []).flatMap((b) => (b.news || []).map((n) => ({ ...n, id: b.id, bill: b.bill }))).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10);
  loadToday();
  const row = (c) => {
    const s = c.summary || {}, odds = s.odds, wk = (s.trend || []).filter((t) => t.d <= daysAgo(7)).slice(-1)[0];
    const delta = odds !== null && odds !== undefined && wk ? Math.round((odds - wk.p) * 100) : null;
    const cnt = s.counts || [0, 0, 0, 0, 0], have = s.side === 'defeat' ? cnt[3] + cnt[4] : cnt[0] + cnt[1];
    const target = s.side === 'defeat' ? (s.n || 0) - (s.needF || 0) + 1 : s.needF;
    const overdue = (s.dueDates || []).filter((d) => dayDiff(d) < 0).length, next = s.cmteDate || s.floorDate ? soonest(s) : null;
    return `<tr class="prow" data-opencamp="${esc(c.id)}" tabindex="0">
      <td><b>${esc(c.name || 'Untitled campaign')}</b>${c.archived ? ' <span class="status">Archived</span>' : ''}${c.visibility === 'team' ? ' <span class="status">Closed</span>' : ''}<div class="meta">${esc((todayOf(c.id) || {}).now || s.billStatus || '')}</div></td>
      <td>${esc(c.client || '')}</td>
      <td class="num">${odds === null || odds === undefined ? '<span class="note">No roster</span>' : `<b>${pct(odds)}%</b>${delta ? ` <span class="${delta > 0 ? 'good' : 'bad'}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}<div class="meta">${s.side === 'defeat' ? 'to defeat' : 'to pass'}</div>`}</td>
      <td class="num">${s.n ? `${have} / ${target}` : ''}</td>
      <td>${next ? `${esc(next[0])}<div class="meta">${esc(fmtDay(next[1]))}, ${esc(inDays(next[1]))}</div>` : ''}</td>
      <td class="num">${(s.meetings || []).length ? `${s.meetings.length} booked` : ''}${s.requested ? `<div class="meta">${s.requested} requested</div>` : ''}</td>
      <td class="num">${overdue ? `<span class="bad"><b>${overdue} overdue</b></span>` : ''}${s.openTasks ? `<div class="meta">${s.openTasks} open</div>` : ''}</td>
      <td class="meta">${esc(fmtDate(c.updatedAt))}</td></tr>`;
  };
  el.innerHTML = `${fastStart()}${gettingStarted()}
    ${upcoming.length || moved.length ? `<div class="today">
      ${upcoming.length ? `<div class="panel"><span class="label">Coming up</span><ul class="moves">${upcoming.slice(0, 8).map((u) => `<li><span class="when">${esc(u.day ? fmtDay(u.when.slice(0, 10)) : fmtWhen(u.when))}</span> · <button class="linkbtn" data-opencamp="${esc(u.id)}">${esc(u.label)}</button>${u.hearing ? ` <a class="meta" href="${esc(hearingLink(u.hearing, u.bill))}" target="_blank" rel="noopener">Add to calendar</a>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${moved.length ? `<div class="panel"><span class="label">Bills that moved this week</span><ul class="moves">${moved.map((n) => `<li><span class="when">${esc(fmtDay(n.date))}</span> · <button class="linkbtn" data-opencamp="${esc(n.id)}">${esc(n.bill)}</button> ${esc(n.plain)}</li>`).join('')}</ul></div>` : ''}
    </div>` : ''}
    <div class="panel">
      <div class="row"><span class="label">Campaigns in ${esc(ORG.name)}</span>${ORG.role !== 'guest' ? '<button class="btn sm primary" data-act="newCamp">New campaign</button>' : ''}</div>
      <div class="filters">
        <input type="search" id="pf_q" placeholder="Search campaigns" value="${esc(f.q)}" aria-label="Search campaigns">
        <select id="pf_client" aria-label="Client"><option value="">All clients</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}" ${f.client === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select>
        <label class="check note"><input type="checkbox" id="pf_arch" ${f.archived ? 'checked' : ''}> Show archived</label>
      </div>
      <div class="tablewrap" style="max-height:none"><table class="ptable"><thead><tr><th>Campaign</th><th>Client</th><th>Odds</th><th>Count</th><th>Next vote</th><th>Meetings</th><th>Follow-ups</th><th>Updated</th></tr></thead>
      <tbody>${list.length ? list.map(row).join('') : `<tr><td colspan="8" class="note">${ACCOUNT.list.length ? 'No campaigns match.' : 'No campaigns yet. Create one, or open the example and edit it to save it here.'}</td></tr>`}</tbody></table></div>
    </div>`;
}

// ---------- workspace settings ----------
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
const ACTIONS = { 'staff_list.upload': 'uploaded a staff list from', 'staff_list.remove': 'removed the staff list', 'workspace.created': 'created the workspace', 'workspace.renamed': 'renamed the workspace', 'workspace.exported': 'exported all data', 'workspace.owner_changed': 'passed ownership to', 'member.joined': 'joined', 'member.left': 'left the workspace', 'member.removed': 'removed', 'member.role_changed': 'changed the role of', 'invite.created': 'created an invitation for', 'invite.revoked': 'revoked an invitation', 'client.added': 'added client', 'client.updated': 'updated client', 'client.deleted': 'deleted client', 'campaign.created': 'created campaign', 'campaign.deleted': 'deleted campaign', 'campaign.archived': 'archived campaign', 'campaign.restored': 'restored campaign', 'campaign.visibility': 'changed who can see', 'billing.checkout_started': 'started checkout', 'billing.subscription': 'subscription is now', 'billing.canceled': 'subscription canceled', 'billing.seats_changed': 'changed the number of seats', 'billing.payment_failed': 'a payment failed', 'domain.added': 'added the email domain', 'domain.verified': 'verified the email domain', 'domain.join_on': 'let colleagues join from', 'domain.join_off': 'stopped joining from', 'domain.removed': 'removed the email domain', 'report.activity': 'ran the activity report for' };
function quarters() {
  const out = [], d = new Date();
  let y = d.getFullYear(), q = Math.floor(d.getMonth() / 3) + 1;
  for (let i = 0; i < 8; i++) {
    const from = `${y}-${pad((q - 1) * 3 + 1)}-01`, endMonth = q * 3, to = `${y}-${pad(endMonth)}-${pad(new Date(y, endMonth, 0).getDate())}`;
    out.push({ label: `Q${q} ${y}`, from, to });
    q--; if (!q) { q = 4; y--; }
  }
  return out;
}
async function loadWs() {
  if (WS.loading || !ORG) return;
  WS.loading = true;
  try {
    const jobs = [];
    if (ORG.role !== 'guest' && WS.members === null) jobs.push(CLOUD.api('GET', `/api/workspaces/${ORG.id}/members`).then((r) => { WS.members = r.members; }));
    if (isAdmin() && WS.invites === null) jobs.push(CLOUD.api('GET', `/api/workspaces/${ORG.id}/invites`).then((r) => { WS.invites = r.invites; }));
    if (isAdmin() && WS.audit === null && ORG.plan.features.audit) jobs.push(CLOUD.api('GET', `/api/workspaces/${ORG.id}/audit?limit=25`).then((r) => { WS.audit = r.entries; WS.auditMore = r.entries.length === 25; }));
    await Promise.all(jobs);
  } catch (e) { fail(e); } finally { WS.loading = false; }
  if (page === 'workspace') renderWorkspace(true);
}
function planPanel() {
  const p = ORG.plan, u = ORG.usage, b = (CLOUD.config && CLOUD.config.billing) || null, admin = isAdmin();
  const daysLeft = p.trialEnds ? Math.max(0, Math.ceil((p.trialEnds - Date.now()) / 864e5)) : 0;
  const status = p.key === 'trial' ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : p.status === 'past_due' ? 'Payment overdue' : p.key === 'unlimited' ? 'No limits' : p.key === 'free' ? 'Free' : 'Active';
  const rows = [[cfg2().billing ? 'People (paid seats)' : 'People', limitText(u.seats, p.seats)], ['Guests', limitText(u.guests, p.guests)], ['Active campaigns', limitText(u.campaigns, p.campaigns)], ['Briefs drafted this month', limitText(u.drafts, p.drafts)]];
  let actions = '';
  if (b && admin) {
    const sub = ORG.billing.subscription && ['active', 'trialing', 'past_due'].includes(p.status);
    if (sub) actions = `<div class="btnrow"><label class="note">Seats <input type="number" id="bill_seats" min="${u.seats}" max="1000" value="${p.seats}" style="width:80px"></label><button class="btn" data-act="billSeats">Change seats</button><button class="btn" data-act="billPortal">Invoices, card and cancellation</button></div>`;
    else actions = `<div class="btnrow"><label class="note">Seats <input type="number" id="bill_seats" min="${Math.max(1, u.seats)}" max="1000" value="${Math.max(u.seats, 3)}" style="width:80px"></label><button class="btn primary" data-act="billCheckout" data-plan="team">Subscribe to Team${b.team.price ? ` (${esc(b.team.price)})` : ''}</button>${b.firm ? `<button class="btn" data-act="billCheckout" data-plan="firm">Subscribe to Firm${b.firm.price ? ` (${esc(b.firm.price)})` : ''}</button>` : ''}${ORG.billing.customer ? '<button class="btn" data-act="billPortal">Past invoices</button>' : ''}</div>
      <p class="note">Team adds the lobbying activity report, the activity log, joining by email domain, ${p.key === 'free' ? 'unlimited campaigns, ' : ''}guests and more drafted briefs. Checkout and billing are handled by Stripe.${b.salesEmail ? ` For a firm-wide agreement or invoicing, write to ${esc(b.salesEmail)}.` : ''}</p>`;
  }
  return `<div class="panel"><div class="row"><span class="label">Plan</span><span class="status ${p.status === 'past_due' ? 'bad' : p.key === 'free' ? 'wait' : 'ok'}">${esc(p.label)} · ${esc(status)}</span></div>
    <dl class="kv" style="margin-top:10px">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}${p.periodEnd ? `<dt>Renews</dt><dd>${esc(fmtDate(p.periodEnd))}</dd>` : ''}</dl>
    ${actions}${!admin && b && p.key !== 'unlimited' ? '<p class="note">Workspace admins manage the plan.</p>' : ''}</div>`;
}
function peoplePanel() {
  if (ORG.role === 'guest') return '';
  const admin = isAdmin(), owner = ORG.role === 'owner', ms = WS.members;
  const roleSel = (m) => `<select data-orgrole="${esc(m.id)}" aria-label="Role for ${esc(m.name)}">${['owner', 'admin', 'member', 'guest'].filter((r) => owner || (r !== 'owner' && m.role !== 'owner')).map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
  const canManage = (m) => admin && !m.you && (owner || m.role !== 'owner');
  return `<div class="panel"><span class="label">People</span>
    ${ms ? `<ul class="people">${ms.map((m) => `<li><span><b>${esc(m.name || m.email)}</b>${m.you ? ' (you)' : ''}<br><span class="note">${esc(m.email)}</span></span>
      <span class="btnrow">${canManage(m) ? `${roleSel(m)}<button class="btn sm warn" data-act="orgRemove" data-uid="${esc(m.id)}">Remove</button>` : `<span class="status">${ROLE_LABEL[m.role]}</span>`}</span></li>`).join('')}</ul>` : '<p class="note">Loading</p>'}
    ${admin ? `<form id="oiForm" class="form" style="margin-top:12px">
      <label>Their email (optional)<input id="oi_email" name="email" type="email" placeholder="colleague@yourfirm.com"></label>
      <label>Role<select id="oi_role" name="role"><option value="member">Member</option><option value="admin">Admin</option><option value="guest">Guest</option></select></label>
      <div class="wide btnrow"><button class="btn primary">Create invitation</button>${CLOUD.config.email || CLOUD.provider() ? `<label class="check note"><input type="checkbox" id="oi_send" checked> ${CLOUD.config.email ? 'Email the invitation' : `Email it from my ${CLOUD.mailName(CLOUD.provider())}`} when an address is given</label>` : ''}</div>
      </form>
      ${WS.lastInvite ? `<div class="linkbox" style="margin-top:8px"><input id="oi_link" readonly value="${esc(WS.lastInvite)}" aria-label="Invitation link"><button class="btn sm" data-copy="${esc(WS.lastInvite)}">Copy</button></div>` : ''}
      <p class="note">Guests see only the campaigns you add them to. Links work for 14 days.</p>
      ${WS.invites && WS.invites.length ? `<span class="label">Open invitations</span><ul class="people">${WS.invites.map((i) => `<li><span>${esc(i.email || 'Anyone with the link')} · ${ROLE_LABEL[i.role]}<br><span class="note">expires ${esc(fmtDate(i.expiresAt))}${i.email ? '' : `, used ${i.uses} time${i.uses === 1 ? '' : 's'}`}</span></span><span class="btnrow"><button class="btn sm" data-copy="${esc(location.origin + '/invite/' + i.code)}">Copy link</button><button class="btn sm warn" data-act="orgRevoke" data-code="${esc(i.code)}">Revoke</button></span></li>`).join('')}</ul>` : ''}` : ''}
  </div>`;
}
function clientsPanel() {
  if (ORG.role === 'guest') return '';
  return `<div class="panel"><span class="label">Clients</span>
    <ul class="people">${CLIENTS.length ? CLIENTS.map((k) => `<li><span>${esc(k.name)}${k.archived ? ' <span class="status">Archived</span>' : ''}<br><span class="note">${ACCOUNT.list.filter((c) => c.clientId === k.id && !c.archived).length} active campaigns</span></span>
      <span class="btnrow"><button class="btn sm" data-act="clientRename" data-id="${esc(k.id)}">Rename</button><button class="btn sm" data-act="clientArchive" data-id="${esc(k.id)}">${k.archived ? 'Restore' : 'Archive'}</button>${isAdmin() ? `<button class="btn sm warn" data-act="clientDelete" data-id="${esc(k.id)}">Delete</button>` : ''}</span></li>`).join('') : '<li class="note">No clients yet. Add the organizations you represent, then pick one for each campaign.</li>'}</ul>
    <form id="ckForm" class="taskadd"><input id="ck_name" name="name" placeholder="Client name" aria-label="Client name" required><button class="btn">Add client</button></form></div>`;
}
function domainPanel() {
  if (!isAdmin()) return '';
  const d = ORG.domain, on = ORG.plan.features.domain;
  let body;
  if (!on) return upsell('Email domain', 'Team', 'Colleagues with an email address at your firm\'s domain join without an invitation.');
  else if (!d) body = `<p class="note">Let anyone @yourfirm.com join without an invitation, once you prove you own the domain.</p><form id="dmForm" class="taskadd"><input id="dm_name" name="domain" placeholder="yourfirm.com" aria-label="Domain" required><button class="btn">Add domain</button></form>`;
  else if (!d.verified) body = `<p class="note">Ask whoever manages <b>${esc(d.name)}</b> (often your IT person, or the company where you bought the domain, such as GoDaddy or Squarespace) to add this TXT record to it. Then press Verify. It can take up to an hour to show up.</p><div class="linkbox"><input readonly value="headcount-verification=${esc(d.token)}" aria-label="TXT record"><button class="btn sm" data-copy="headcount-verification=${esc(d.token)}">Copy</button></div><div class="btnrow" style="margin-top:8px"><button class="btn primary" data-act="dmVerify">Verify</button><button class="btn" data-act="dmRemove">Remove</button></div>`;
  else body = `<p><span class="status ok">Verified</span> ${esc(d.name)}</p><label class="check"><input type="checkbox" id="dm_join" ${d.join ? 'checked' : ''}> Anyone who signs in with a verified @${esc(d.name)} address can join as a member (each uses a seat)</label><div><button class="btn sm" data-act="dmRemove">Remove domain</button></div>`;
  return `<div class="panel"><span class="label">Email domain</span>${body}</div>`;
}
// Premium features show what they do, which plan has them, and a way to get it.
function upsell(title, plan, what) {
  return `<div class="panel locked"><div class="row"><span class="label">${esc(title)}</span><span class="tier">${esc(plan)}</span></div><p class="note">${esc(what)}</p>${isAdmin() && CLOUD.config.billing ? `<div><button class="btn sm primary" data-act="gotoPlans">Get ${esc(plan)}</button></div>` : `<p class="note">Part of the ${esc(plan)} plan. Ask a workspace admin.</p>`}</div>`;
}
function securityPanel() {
  if (!isAdmin() || !CLOUD.config.accounts) return '';
  if (!ORG.plan.features.require2fa) return upsell('Require two-step sign-in', 'Team', 'Everyone in the workspace signs in with a code from an authenticator app as well as a password.');
  const s = ORG.security || {}, local = Math.max(0, (s.people || 0) - (s.elsewhere || 0));
  return `<div class="panel"><span class="label">Two-step sign-in</span>
    <p class="note">${s.withCode || 0} of ${local} ${local === 1 ? 'person' : 'people'} with a Headcount password ${s.withCode === 1 ? 'uses' : 'use'} two-step sign-in.${s.elsewhere ? ` ${s.elsewhere} sign${s.elsewhere === 1 ? 's' : ''} in with Google, Microsoft or single sign-on, which have their own two-step settings.` : ''}</p>
    <label class="check"><input type="checkbox" id="sec_2fa" ${s.require2fa ? 'checked' : ''}> Require it for everyone in this workspace. People without it are asked to turn it on before they can open the workspace; guests are not affected.</label>
    ${TWOFA.on || !CLOUD.local() ? '' : '<p class="note">Turn it on for your own account first, under Account.</p>'}</div>`;
}
async function setRequire2fa(box) {
  try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/security`, { require2fa: box.checked }); ORG.security.require2fa = box.checked; toast(box.checked ? 'Two-step sign-in is now required' : 'Two-step sign-in is optional'); }
  catch (e) { box.checked = !box.checked; fail(e); }
}
function ssoPanel() {
  if (!isAdmin() || !CLOUD.config.sso) return '';
  const sso = ORG.sso || {}, d = ORG.domain, support = CLOUD.config.supportEmail;
  if (!ORG.plan.features.sso) return upsell('Single sign-on', 'Firm', 'Staff sign in through your firm\'s own login page (Okta, Microsoft Entra ID and others), and you can make it required.');
  return `<div class="panel"><span class="label">Single sign-on</span>
    ${!d || !d.verified ? '<p class="note">Verify your email domain first: people reach your sign-in page by entering their work email.</p>' : ''}
    <form id="ssForm" class="form">
      <label class="wide">Sign-on ID (from Headcount support)<input id="ss_provider" name="provider" value="${esc(sso.provider || '')}" placeholder="saml.yourfirm"></label>
      <label class="wide check"><input type="checkbox" id="ss_required" name="required" ${sso.required ? 'checked' : ''}> Require it for members and admins. Owners can always sign in another way, so they can fix this if something goes wrong.</label>
      <div class="wide"><button class="btn primary">Save</button></div>
    </form>
    <p class="note">Your IT team and Headcount support set this up together: ${support ? `write to ${esc(support)}` : 'contact Headcount support'} and they will ask your IT team for a few details, then give you the sign-on ID to enter here. People then choose "Sign in with single sign-on" and enter their ${d ? '@' + esc(d.name) : 'work'} email; anyone who signs in that way joins this workspace as a member.</p></div>`;
}
function reportPanel() {
  if (!isAdmin()) return '';
  if (!ORG.plan.features.activityReport) return upsell('Lobbying activity report', 'Team', 'Every contact your team logged in a quarter, grouped by client and issue, ready to help prepare disclosure reports such as the LD-2.');
  const qs = quarters(), r = WS.report;
  return `<div class="panel"><span class="label">Lobbying activity report</span>
    <form id="rpForm" class="filters" style="margin-top:10px">
      <select id="rp_q" name="q" aria-label="Quarter">${qs.map((q, i) => `<option value="${i}" ${r && r.from === q.from ? 'selected' : ''}>${q.label}</option>`).join('')}</select>
      <select id="rp_client" name="client" aria-label="Client"><option value="">All clients</option>${CLIENTS.map((k) => `<option value="${esc(k.id)}" ${r && r.client === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select>
      <button class="btn primary">Run report</button>${r ? '<button type="button" class="btn" data-act="rpCsv">Download as a spreadsheet</button>' : ''}
    </form>
    ${r ? `<p class="note">${r.rows.length} contact${r.rows.length === 1 ? '' : 's'} logged from ${esc(fmtDay(r.from))} to ${esc(fmtDay(r.to))}.</p>
      ${r.summary.length ? `<div class="tablewrap" style="max-height:none"><table><thead><tr><th>Client</th><th>Contacts</th><th>Issues</th><th>Chambers</th><th>Lobbyists</th></tr></thead><tbody>${r.summary.map((g) => `<tr><td><b>${esc(g.client)}</b></td><td class="num">${g.contacts}</td><td>${esc(g.issues.join('; '))}</td><td>${esc(g.chambers.join('; '))}</td><td>${esc(g.lobbyists.join(', '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${r.rows.length ? `<details><summary class="note">Every contact</summary><div class="tablewrap"><table><thead><tr><th>Date</th><th>Client</th><th>Member</th><th>With</th><th>Type</th><th>Logged by</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td class="num">${esc(x.date)}</td><td>${esc(x.client)}</td><td>${esc(x.member)} <span class="note">${esc(x.party || '')}-${esc(x.district || '')}</span></td><td>${esc(x.withWhom)}</td><td>${esc(x.type)}</td><td>${esc(x.loggedBy)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}` : ''}
    <p class="note">A worksheet of logged contacts, not a filing. Check it against your records.</p></div>`;
}
function auditPanel() {
  if (!isAdmin()) return '';
  if (!ORG.plan.features.audit) return upsell('Activity log', 'Team', 'Who added, changed, invited or removed what, and when, for the whole workspace.');
  return `<div class="panel"><div class="row"><span class="label">Activity log</span>${WS.audit && WS.audit.length ? '<button class="btn sm" data-act="auditCsv">Download as a spreadsheet</button>' : ''}</div>
    ${WS.audit ? `<ul class="hist">${WS.audit.map((a) => `<li><time>${esc(new Date(a.at).toLocaleString())}</time> · ${esc(a.actor || 'Billing')} ${esc(a.action === 'invite.created' && !a.target ? 'created an invitation link' : ACTIONS[a.action] || a.action)}${a.target ? ` <b>${esc(a.target)}</b>` : ''}${a.detail && a.detail.role ? ` as ${esc(ROLE_LABEL[a.detail.role] || a.detail.role)}` : ''}${a.detail && a.detail.to ? ` to ${esc(ROLE_LABEL[a.detail.to] || a.detail.to)}` : ''}${a.detail && a.detail.seats ? ` (${a.detail.seats} seats)` : ''}</li>`).join('') || '<li class="note">Nothing yet.</li>'}</ul>${WS.auditMore ? '<button class="btn sm" data-act="auditMore">Show older</button>' : ''}` : '<p class="note">Loading</p>'}</div>`;
}
function dataPanel() {
  const owner = ORG.role === 'owner';
  return `<div class="panel"><span class="label">Workspace</span>
    ${isAdmin() ? `<form id="wnForm" class="taskadd"><input id="wn_name" name="name" value="${esc(ORG.name)}" aria-label="Workspace name" required><button class="btn">Rename</button></form>
    <p class="note">The workspace name appears in meeting requests as the organization you are writing from.</p>
    <div class="btnrow"><button class="btn" data-act="orgExport">Download all data</button></div>` : ''}
    <details class="sect"><summary>${owner ? 'Delete workspace' : 'Leave workspace'}</summary>
      <p class="note">${owner ? 'Deletes every campaign, client and invitation in this workspace for everyone. Download the data first if you need it. This cannot be undone.' : 'You lose access to its campaigns until someone invites you again.'}</p>
      <div><button class="btn sm warn" data-act="${owner ? 'orgDelete' : 'orgLeave'}">${owner ? 'Delete this workspace' : 'Leave this workspace'}</button></div></details></div>`;
}
function onboardingHtml() {
  const guess = CLOUD.user && CLOUD.user.email ? CLOUD.user.email.split('@')[1].split('.')[0] : '';
  const domainName = guess && !/^(gmail|outlook|hotmail|yahoo|icloud|live|aol|proton|me)$/i.test(guess) ? guess.charAt(0).toUpperCase() + guess.slice(1) : '';
  return `<div class="panel" style="max-width:640px;margin:0 auto">
    <h2 style="margin:0 0 8px;font:700 22px var(--display)">Set up your workspace</h2>
    ${DOMAIN_MATCHES.map((o) => `<p>Your colleagues at <b>${esc(o.name)}</b> already use Headcount. <button class="btn sm primary" data-act="joinDomain" data-id="${esc(o.id)}">Join ${esc(o.name)}</button></p>`).join('')}
    <p class="note">Your firm's campaigns, clients and team, in one place.${CLOUD.config && CLOUD.config.billing ? ` New workspaces start with a ${CLOUD.config.billing.trialDays}-day Team trial.` : ''}</p>
    <form id="woForm" class="taskadd"><input id="wo_name" name="name" placeholder="Your firm or organization" value="${esc(domainName)}" aria-label="Workspace name" required><button class="btn primary">Create workspace</button></form>
    <p class="note">Invited to someone else's workspace? Open the link from your invitation.</p></div>`;
}
// Redraws a page section without losing what the person was typing.
function keepEdits(el, draw) {
  const dirty = [...el.querySelectorAll('input[id], select[id], textarea[id]')].filter((f) => !f.readOnly && (f.type === 'checkbox' ? f.checked !== f.defaultChecked : f.tagName === 'SELECT' ? [...f.options].some((o) => o.selected !== o.defaultSelected) : f.value !== f.defaultValue))
    .map((f) => [f.id, f.type === 'checkbox' ? f.checked : f.value]);
  const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
  draw();
  for (const [id, v] of dirty) { const f = document.getElementById(id); if (f) { if (f.type === 'checkbox') f.checked = v; else f.value = v; } }
  if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
}
function renderWorkspace(fromLoad) {
  keepEdits($('#workspacePage'), () => drawWorkspace(fromLoad));
}
function drawWorkspace(fromLoad) {
  const el = $('#workspacePage');
  if (!signedIn()) { el.innerHTML = `<div class="panel empty">${CLOUD.canSignIn() ? 'Sign in to set up a workspace for your team. <button class="btn sm primary" data-act="signin">Sign in</button>' : 'Workspaces are part of the full version of Headcount, with accounts. This free version keeps everything in your browser.'}</div>`; return; }
  if (!ORG) { el.innerHTML = onboardingHtml(); return; }
  el.innerHTML = `<div class="wsgrid">${planPanel()}${peoplePanel()}${staffListPanel()}${clientsPanel()}${domainPanel()}${securityPanel()}${ssoPanel()}${reportPanel()}${auditPanel()}${dataPanel()}</div>`;
  if (!fromLoad) loadWs();
}
async function runReport(form) {
  const fd = new FormData(form), q = quarters()[+fd.get('q')];
  try {
    const r = await CLOUD.api('GET', `/api/workspaces/${ORG.id}/activity?from=${q.from}&to=${q.to}&client=${encodeURIComponent(fd.get('client') || '')}`);
    WS.report = { ...r, client: fd.get('client') || '' }; renderWorkspace(true);
  } catch (e) { fail(e); }
}
async function sendOrgInvite(form) {
  const fd = new FormData(form), email = String(fd.get('email') || '').trim(), role = fd.get('role');
  const sendIt = email && $('#oi_send') && $('#oi_send').checked, server = Boolean(CLOUD.config.email);
  const access = sendIt && !server && CLOUD.canConnect() && !CLOUD.connected() ? CLOUD.connect() : null;
  try {
    const r = await CLOUD.api('POST', `/api/workspaces/${ORG.id}/invites`, { role, email: email || undefined, send: Boolean(sendIt && server) });
    WS.lastInvite = `${location.origin}/invite/${r.code}`; WS.invites = null;
    if (sendIt && server) toast(r.emailed ? `Invitation emailed to ${email}` : 'Invitation link created. Copy it and send it to your colleague.');
    else if (sendIt && !CLOUD.canConnect()) { const how = openMail(mailerPref() || 'app', { to: email, subject: `Join ${ORG.name} on Headcount`, body: `${CLOUD.user.name} invited you to join ${ORG.name} on Headcount:\n\n${WS.lastInvite}` }); toast(how === 'web' ? 'Invitation link created and opened in a new tab' : 'Invitation link created. If your email app did not open, copy the link below.'); }
    else if (sendIt) {
      if (access) await access;
      await CLOUD.mail.send({ to: [email], subject: `Join ${ORG.name} on Headcount`, body: `Hi,\n\n${CLOUD.user.name} invited you to join ${ORG.name} on Headcount as ${role === 'guest' ? 'a guest' : role === 'admin' ? 'an admin' : 'a member'}. Headcount is where we track vote counts, meetings and bill briefs.\n\nJoin here (the link works for 14 days and only for ${email}):\n${WS.lastInvite}\n\n${CLOUD.user.name}` });
      toast(`Invitation sent to ${email}`);
    } else toast('Invitation link created. Copy it and send it to your colleague.');
  } catch (e) { fail(e); }
  loadWs(); renderWorkspace(true);
}
function csvDownload(name, rows) { download(name, csv(rows), 'text/csv'); }

// ---------- page ----------
function renderSwitcher() {
  const c = S.campaign, opts = [];
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const os = $('#orgSel');
  os.hidden = !signedIn();
  if (signedIn()) os.innerHTML = (ORG ? '' : '<option value="">No workspace yet</option>') + ORGS.map((o) => opt(o.id, o.name + (o.ssoRequired ? ' (single sign-on)' : o.twoFactorRequired ? ' (two-step sign-in)' : o.role === 'guest' ? ' (guest)' : ''), ORG && o.id === ORG.id)).join('') + '<option value="__new">New workspace…</option>';
  if (signedIn() && ORG) {
    const acct = ACCOUNT.list.filter((e) => !e.archived || (S.cloud && e.id === S.id)); if (S.cloud && !acct.some((e) => e.id === S.id)) acct.unshift({ id: S.id, name: c.bill, role: ROLE, people: 1 });
    const tag = (e) => (e.role === 'viewer' ? ' (view only)' : e.client ? ` · ${e.client}` : '');
    if (acct.length) opts.push(`<optgroup label="${esc(ORG.name)}">${acct.map((e) => opt('cloud:' + e.id, (S.cloud && e.id === S.id ? c.bill || 'Untitled campaign' : e.name || 'Untitled campaign') + tag(e), S.cloud && e.id === S.id)).join('')}</optgroup>`);
    const loc = BOOK.list.filter((e) => e.id !== 'ex' && localIds().includes(e.id));
    if (loc.length) opts.push(`<optgroup label="This browser only">${loc.map((e) => opt('local:' + e.id, e.name, !S.cloud && e.id === S.id)).join('')}</optgroup>`);
    if (!S.cloud && S.example) opts.push(opt('local:ex', `${c.bill} (example)`, true));
  } else {
    const list = BOOK.list.slice(); if (!list.some((e) => e.id === S.id)) list.unshift({ id: S.id, name: c.bill });
    opts.push(list.map((e) => opt('local:' + e.id, (e.id === S.id ? c.bill || 'Untitled campaign' : e.name) + (e.id === 'ex' && S.example ? ' (example)' : ''), e.id === S.id)).join(''));
  }
  $('#campSel').innerHTML = opts.join('');
}
function renderAcct() {
  const el = $('#acct'), cfg = CLOUD.config;
  $('#menuAccount').hidden = !signedIn(); $('#menuServer').hidden = !(signedIn() && OPERATOR);
  if (!cfg || !CLOUD.ready) { el.innerHTML = ''; return; }
  if (signedIn()) el.innerHTML = `<button class="btn" data-act="account" title="${esc(CLOUD.user.email)}">${esc(CLOUD.user.name.split(/\s+/)[0] || 'Account')}</button>`;
  else if (CLOUD.canSignIn()) el.innerHTML = '<button class="btn primary" data-act="signin">Sign in</button>';
  else el.innerHTML = '';
}
function render() {
  autoStaff(); recordDaily();
  { const mr = $('#menuRecord'); if (mr) mr.hidden = !(signedIn() && S.cloud && !S.example && canEditNow()); }
  const c = S.campaign, cfg = CLOUD.config || {}, campaignPage = page === 'count' || page === 'brief', team = signedIn() && ORG && ORG.role !== 'guest';
  if ((page === 'monitor' || page === 'contacts' || page === 'bills' || page === 'people') && !team && signedIn() && ORG) page = 'portfolio';
  renderSwitcher();
  $('.camp').hidden = !campaignPage;
  $('#setupBtn').hidden = !campaignPage;
  ['pgPortfolio', 'pgWorkspace'].forEach((id) => { $('#' + id).hidden = !signedIn(); });
  ['pgMonitor', 'pgContacts', 'pgBills', 'pgPeople'].forEach((id) => { $('#' + id).hidden = !team; });
  PAGES.forEach((k) => { $('#pg' + k[0].toUpperCase() + k.slice(1)).setAttribute('aria-pressed', page === k); });
  if (campaignPage) {
    const nd = needs(S);
    $('#hBill').textContent = c.bill || (SYNC.loading ? 'Loading' : 'Untitled campaign');
    { const rn = $('#hRename'); if (rn) rn.hidden = !canEditNow() || Boolean(SYNC.loading); }
    const camp = S.cloud && ACCOUNT.list.find((e) => e.id === S.id);
    $('#hSub').textContent = `${S.example ? 'Example with invented members · ' : ''}${camp && camp.visibility === 'team' ? 'Closed · ' : ''}${dirOf(S) < 0 ? 'Working to defeat' : 'Working to pass'}${clientOf() ? ` for ${clientOf()}` : ''} · ${c.chamber || 'Chamber not set'} · ${nd.n} members, ${nd.needF} to pass`;
    storyLine(); if (page === 'count') loadStory();
    $('#hDates').textContent = [['Committee vote', c.cmteDate], ['Floor vote', c.floorDate]].filter((x) => x[1]).map((x) => `${x[0]} ${inDays(x[1])} (${fmtDay(x[1])})`).concat((() => { const n = S.tasks.filter((t) => !t.done && t.due && dayDiff(t.due) < 0).length; return n ? [`${n} follow-up${n > 1 ? 's' : ''} overdue`] : []; })()).join(' · ');
  } else {
    { const rn = $('#hRename'); if (rn) rn.hidden = true; }
    $('#hBill').textContent = page === 'portfolio' ? (ORG ? ORG.name : 'Portfolio') : page === 'bills' ? 'Bills you follow' : page === 'people' ? 'Legislators' : page === 'monitor' ? 'Monitor' : page === 'contacts' ? 'Contacts' : ORG ? `${ORG.name} settings` : 'Workspace';
    storyLine();
    $('#hSub').textContent = ORG && (page === 'portfolio' || page === 'workspace') ? `${ORG.plan.label} · ${ROLE_LABEL[ORG.role]}${ORG.role === 'guest' ? ': you see only the campaigns you were added to' : ''}` : '';
    $('#hDates').textContent = '';
  }
  const b = $('#banner'); let banner = '';
  const match = DOMAIN_MATCHES.find((o) => !ORGS.some((x) => x.id === o.id));
  if (JOIN) {
    const role = JOIN.info ? ({ editor: 'an editor', viewer: 'a viewer', admin: 'an admin', member: 'a member', guest: 'a guest' })[JOIN.info.role] : '';
    const what = JOIN.info ? (JOIN.kind === 'org' ? `<b>${esc(JOIN.info.workspace)}</b>` : `<b>${esc(JOIN.info.campaign)}</b> in ${esc(JOIN.info.workspace)}`) : '';
    banner = JOIN.error ? `<span>${esc(JOIN.error)}</span>`
      : JOIN.info ? `<span><b>${esc(JOIN.info.invitedBy)}</b> invited you to ${JOIN.kind === 'org' ? 'join' : 'work on'} ${what} as ${role}.${signedIn() ? '' : ' Sign in to accept.'}</span>${signedIn() ? '<button class="btn sm primary" data-act="joinNow">Accept</button>' : '<button class="btn sm primary" data-act="signin">Sign in to accept</button>'}` : '<span>Checking your invitation</span>';
  } else if (cfg.authError) banner = `<span>${esc(cfg.authError)}</span>`;
  else if (signedIn() && TFA_NEEDED && !SSO_NEEDED) banner = `<span><b>${esc(TFA_NEEDED)}</b> requires two-step sign-in. Turn it on for your account to open its campaigns.</span><button class="btn sm primary" data-act="tfaSetup">Turn it on</button>`;
  else if (signedIn() && SSO_NEEDED) banner = `<span><b>${esc(SSO_NEEDED)}</b> requires single sign-on. Sign in through your firm's own login page to see its campaigns.</span><button class="btn sm primary" data-act="ssoSwitch">Sign in with single sign-on</button>`;
  else if (signedIn() && match) banner = `<span>Your colleagues at <b>${esc(match.name)}</b> use Headcount.</span><button class="btn sm primary" data-act="joinDomain" data-id="${esc(match.id)}">Join ${esc(match.name)}</button>`;
  else if (signedIn() && !ORG && page !== 'workspace') banner = '<span>Set up a workspace to save campaigns to your account and work with your team.</span><button class="btn sm primary" data-page="workspace">Set up a workspace</button>';
  else if (signedIn() && OPERATOR && MAIL_PROBLEM) banner = `<span><b>Emails aren't going out.</b> ${esc(MAIL_PROBLEM.explain)}</span><button class="btn sm primary" data-x="serverSettings" data-open="email">Fix email</button>`;
  else if (signedIn() && OPERATOR && !(page === 'portfolio' && ORG && ORG.setup && !lsGet('headcount.gs.' + ORG.id)) && (!cfg.email || !(cfg.bills && (cfg.bills.federal || cfg.bills.states)))) banner = `<span><b>Finish setup:</b> ${!cfg.email ? 'connect email for invitations, resets and alerts.' : 'add the free bill data keys.'}</span><button class="btn sm primary" data-x="serverSettings">Admin settings</button>`;
  else if (signedIn() && ORG && ORG.role !== 'guest' && localIds().length) banner = `<span>${localIds().length} campaign${localIds().length === 1 ? ' is' : 's are'} saved only in this browser.</span><button class="btn sm" data-act="moveLocal">Move to ${esc(ORG.name)}</button>`;
  else if (ORG && isAdmin() && page === 'portfolio' && (ORG.plan.key === 'trial' || ORG.plan.key === 'free' || ORG.plan.status === 'past_due') && cfg.billing) {
    const d = ORG.plan.trialEnds ? Math.max(0, Math.ceil((ORG.plan.trialEnds - Date.now()) / 864e5)) : 0;
    banner = `<span>${ORG.plan.status === 'past_due' ? 'The last payment failed. Update the card to keep your plan.' : ORG.plan.key === 'trial' ? `Team trial: ${d} day${d === 1 ? '' : 's'} left.` : `Free plan: up to ${ORG.plan.seats} people and ${ORG.plan.campaigns} active campaigns.`}</span><button class="btn sm" data-act="gotoPlans">${ORG.plan.status === 'past_due' ? 'Update payment' : 'See plans'}</button>`;
  } else if (S.example && campaignPage) banner = `<span><b>Example.</b> Invented members, to try things out.</span><button class="btn sm primary" data-act="newCamp">Count a real bill</button>`;
  b.hidden = !banner; b.innerHTML = banner;
  const w = $('#warn'), ro = campaignPage && S.cloud && ROLE === 'viewer'; w.hidden = !(ro || (campaignPage && S.preset && S.preset.stale));
  if (ro) w.textContent = 'You have view-only access to this campaign. Ask its owner to make you an editor to change it.';
  else if (!w.hidden) {
    const fresh = ROSTERS && ROSTERS[presetKey()] && !ROSTERS[presetKey()].stale;
    w.innerHTML = `This ${esc(S.preset.label)} list is from before the November 3, 2026 election, when new Florida legislators took office. ${fresh && canEditNow() ? 'Positions and notes for returning members are kept. <button class="btn sm primary" data-act="updateMembers">Update to the current members</button>' : 'Check each member against the official site before relying on it.'}`;
  }
  PAGES.forEach((k) => { $('#' + k + 'Page').hidden = page !== k; });
  if (LAST_PAGE !== page) { const pg = $('#' + page + 'Page'); if (pg && LAST_PAGE) { pg.classList.remove('pagein'); void pg.offsetWidth; pg.classList.add('pagein'); } LAST_PAGE = page; }
  if (page === 'brief') renderBrief();
  else if (page === 'monitor') { if (typeof renderMonitor === 'function') renderMonitor(); }
  else if (page === 'contacts') { if (typeof renderContacts === 'function') renderContacts(); }
  else if (page === 'bills') renderBills();
  else if (page === 'people') renderPeople();
  else if (page === 'portfolio') renderPortfolio();
  else if (page === 'workspace') renderWorkspace();
  else {
    const nd = needs(S), base = passage(S.members, baseProbs(S), nd);
    $('#vFloor').setAttribute('aria-pressed', view === 'floor'); $('#vCmte').setAttribute('aria-pressed', view === 'cmte');
    renderHemi(nd); renderOdds(nd, base); renderCalls(nd, base); renderMeets(); renderTasks(); renderRows();
  }
  renderAcct(); setSaveState();
}
// ---------- panels ----------
let tab = 'act', schedOpen = false;
function outBox(m) {
  if (outKind !== 'brief') return '';
  return `<span class="label" id="outHead">Meeting brief</span>
    <textarea id="outText" class="out" aria-label="Meeting brief">${esc(briefText(m))}</textarea>
    <div class="btnrow"><button class="btn primary" data-act="copyOut">Copy</button><button class="btn" data-act="hideOut">Hide</button><span class="note">Edit freely before you copy it.</span></div>`;
}
function memberDrawer(id) {
  const m = S.members.find((x) => x.id === id); if (!m) return;
  const keep = openId === id && !$('#drawer').hidden ? $('#drawer').scrollTop : 0;
  if (openId !== id) { staffEdit = null; outKind = null; schedOpen = false; RQ = null; tab = 'act'; }
  if (m.draft) tab = 'details';
  openId = id;
  const ro = !canEditNow();
  const followers = S.members.filter((f) => f.follows === id).map((f) => f.name);
  const tasks = S.tasks.filter((t) => t.mid === id && !t.done), meets = upcoming().filter((x) => x.mid === id);
  const tabs = [['act', 'Contact'], ['staff', `Staff${m.staffers.length ? ' (' + m.staffers.length + ')' : ''}`], ['details', 'Details'], ['history', 'History']];
  if (schedOpen && (!RQ || RQ.mid !== id)) rqStart(m);
  const act = () => `${contactBlock(m)}
  <label class="note" style="display:flex;gap:8px;align-items:center">Position on the bill <span class="dot b${m.pos}"></span><select data-pos="${esc(m.id)}" aria-label="Position of ${esc(m.name)}" ${ro ? 'disabled' : ''}>${[4, 3, 2, 1, 0].map((p) => `<option value="${p}" ${m.pos === p ? 'selected' : ''}>${POS[p]}</option>`).join('')}</select></label>
  <div class="btnrow">${ro ? '' : '<button class="btn primary" data-act="rq">Request a meeting</button>'}<button class="btn" data-act="brief">Meeting brief</button></div>
  ${schedOpen && RQ ? rqHtml(m) : ''}${outBox(m)}
  ${meets.length ? `<span class="label">Meetings</span><ul class="tasks">${meets.map(meetHtml).join('')}</ul>` : ''}
  ${tasks.length ? `<span class="label">Open follow-ups</span><ul class="tasks">${tasks.map(taskHtml).join('')}</ul>` : ''}
  ${ro ? '' : `<span class="label" id="logHead">Log a contact</span>
  <form id="cForm" class="form">
    <label class="wide">With<select id="c_who" name="who"><option value="">${esc(m.name || 'The member')}</option>${m.staffers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.role ? ` (${esc(s.role)})` : ''}</option>`).join('')}</select></label>
    <label>Date<input type="date" id="c_d" name="d" value="${today()}" required></label>
    <label>Type<select id="c_type" name="type"><option>Meeting</option><option>Call</option><option>Email</option><option>Event</option><option>Constituent push</option></select></label>
    <label class="wide">Where the member stands afterwards<select id="c_pos" name="pos">${[4, 3, 2, 1, 0].map((p) => `<option value="${p}" ${m.pos === p ? 'selected' : ''}>${POS[p]}</option>`).join('')}</select></label>
    <label class="wide">What happened<textarea id="c_note" name="note" placeholder="Their ask, their objection, who else was in the room"></textarea></label>
    <label>Follow-up<input id="c_fu" name="fu" placeholder="Send the fiscal note"></label>
    <label>Due<input type="date" id="c_fud" name="fud"></label>
    ${S.cloud ? `<label class="wide">Who does it${assignSelect('c_fufor', 'fufor', '')}</label>` : ''}
    <div class="wide"><button class="btn primary">Log contact</button></div>
  </form>`}`;
  const details = () => `<form id="mForm" class="form">
    <label class="wide">Name<input id="m_name" name="name" required value="${esc(m.name)}"></label>
    <label>Party<select id="m_party" name="party">${['D', 'R', 'I'].map((p) => `<option ${m.party === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>District<input id="m_district" name="district" value="${esc(m.district)}"></label>
    <label>Position on the bill<select id="m_pos" name="pos">${[4, 3, 2, 1, 0].map((p) => `<option value="${p}" ${m.pos === p ? 'selected' : ''}>${POS[p]}</option>`).join('')}</select></label>
    <label>How movable<select id="m_mov" name="mov">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${m.mov === n ? 'selected' : ''}>${n} · ${['Dug in', 'Hard', 'Open', 'Receptive', 'Easy'][n - 1]}</option>`).join('')}</select></label>
    <label class="wide">Takes cues from<select id="m_follows" name="follows"><option value="">Nobody in particular</option>${S.members.filter((x) => x.id !== id && !x.draft).sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<option value="${esc(x.id)}" ${m.follows === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="wide">What they care about<input id="m_interests" name="interests" value="${esc(m.interests)}"></label>
    <label>Direct phone<input id="m_phone" name="phone" value="${esc(m.phone || '')}" placeholder="${esc(((m.ref && DIR[m.ref]) || {}).ph || '')}"></label>
    <label>Email<input id="m_email" name="email" value="${esc(m.email || '')}" placeholder="${esc(((m.ref && DIR[m.ref]) || {}).em || '')}"></label>
    <label class="check"><input type="checkbox" id="m_cmte" name="cmte" ${m.cmte ? 'checked' : ''}> Sits on the committee</label>
    <label>Committee role<input id="m_role" name="role" value="${esc(m.role || '')}" placeholder="Chair, Ranking Member"></label>
    <label class="wide">Notes<textarea id="m_notes" name="notes">${esc(m.notes)}</textarea></label>
    ${ro ? '' : `<div class="wide row"><button class="btn primary">Save member</button>${m.draft ? '' : '<button type="button" class="btn sm warn" data-act="askRemove">Remove from roster</button>'}</div>
    <div class="wide note" id="rmAsk" hidden>Remove ${esc(m.name)} with their staff and contact history? <button type="button" class="btn sm warn" data-act="remove">Yes, remove</button></div>`}
  </form>
  ${followers.length ? `<p class="note">${esc(followers.join(', '))} take${followers.length === 1 ? 's' : ''} cues from this member.</p>` : ''}`;
  const history = () => `<ul class="hist">${m.history.length ? m.history.slice().reverse().map((h) => `<li><time>${esc(h.d)}</time> · ${esc(h.type)}${h.who ? ` with ${esc(h.who)}` : ''} · ${POS[h.from]}${h.from !== h.to ? ' to ' + POS[h.to] : ''}${h.by ? ` · <span class="note" data-by="${esc(h.by)}"></span>` : ''}${h.note ? `<div>${esc(h.note)}</div>` : ''}</li>`).join('') : '<li class="note">Nothing logged yet.</li>'}</ul>`;
  const d = $('#drawer');
  d.innerHTML = `<div class="row"><h2>${esc(m.name || 'New member')}</h2><button class="btn sm" data-act="close">Close</button></div>
  ${m.draft ? '' : `<div class="note">${esc(m.party)}-${esc(m.district)}${m.role ? ` · ${esc(m.role)}` : m.cmte ? ' · committee' : ''} · movable ${m.mov}/5${m.interests ? ` · cares about ${esc(m.interests)}` : ''}</div>
  <div class="seg" role="group" aria-label="Section">${tabs.map(([k, v]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${v}</button>`).join('')}</div>`}
  ${tab === 'staff' ? staffSection(m) : tab === 'details' ? details() : tab === 'history' ? history() : act()}`;
  d.hidden = false; $('#scrim').hidden = false; d.scrollTop = keep; fillNames();
}
function teamSection() {
  if (S.example) return '';
  if (!S.cloud) {
    if (signedIn() && ORG) return `<details class="sect" open><summary>Team</summary><p class="note">This campaign is saved only in this browser. Move it to ${esc(ORG.name)} to keep it safe and work on it with your team.</p><div><button class="btn sm" data-act="moveLocal">Move to ${esc(ORG.name)}</button></div></details>`;
    if (signedIn()) return '<details class="sect" open><summary>Team</summary><p class="note">Create a workspace to save campaigns to your account and work on them with your team.</p><div><button class="btn sm" data-page="workspace">Set up a workspace</button></div></details>';
    return CLOUD.canSignIn() ? `<details class="sect"><summary>Team</summary><p class="note">Sign in with ${CLOUD.config.providers.map(CLOUD.providerName).join(' or ')} to save this campaign to your firm's workspace and work on it together.</p><div><button class="btn sm" data-act="signin">Sign in</button></div></details>` : '';
  }
  return `<details class="sect" open id="teamSect"><summary>Who can see it</summary><div id="teamBody" class="note">Loading</div></details>`;
}
async function loadTeam() {
  if (!$('#teamBody')) return;
  let info;
  try { info = await CLOUD.api('GET', `/api/campaigns/${encodeURIComponent(S.id)}/people`); } catch (e) { return fail(e); }
  if (ORG && ORG.role !== 'guest' && WS.members === null) { try { WS.members = (await CLOUD.api('GET', `/api/workspaces/${ORG.id}/members`)).members; } catch (_) { WS.members = []; } }
  PEOPLE = Object.fromEntries(info.people.map((p) => [p.id, p]));
  const box = $('#teamBody'); if (!box) return;
  const owner = ROLE === 'owner', listed = new Set(info.people.map((p) => p.id));
  const camp = ACCOUNT.list.find((c) => c.id === S.id) || {};
  const addable = (WS.members || []).filter((m) => !listed.has(m.id) && m.role !== 'owner' && m.role !== 'admin');
  box.classList.remove('note');
  box.innerHTML = `${owner ? `<label class="note" style="display:flex;flex-direction:column;gap:4px">Who can see and edit it<select id="camp_vis"><option value="org" ${info.visibility === 'org' ? 'selected' : ''}>Everyone in ${esc(info.workspace)}</option><option value="team" ${info.visibility === 'team' ? 'selected' : ''}>Only the people listed below</option></select></label>`
      : `<p class="note">${info.visibility === 'org' ? `Everyone in ${esc(info.workspace)} can see and edit this campaign.` : 'Only the people listed below can see this campaign.'}</p>`}
    <p class="note">Workspace owners and admins can always open it.</p>
    <ul class="people">${info.people.map((p) => `<li><span><b>${esc(p.name || p.email || 'Someone')}</b>${p.you ? ' (you)' : ''}${p.guest ? ' <span class="status">Guest</span>' : ''}<br><span class="note">${esc(p.email || '')}</span></span>
      <span class="btnrow">${owner && !p.you && p.role !== 'owner' ? `<select data-role="${esc(p.id)}" aria-label="Role for ${esc(p.name)}"><option value="editor" ${p.role === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${p.role === 'viewer' ? 'selected' : ''}>Viewer</option></select><button class="btn sm warn" data-act="rmPerson" data-uid="${esc(p.id)}">Remove</button>` : `<span class="status">${p.role === 'owner' ? 'Owner' : p.role === 'editor' ? 'Editor' : 'Viewer'}</span>`}</span></li>`).join('')}</ul>
    ${owner && addable.length ? `<div class="btnrow" style="margin-top:10px"><select id="add_person" aria-label="Colleague">${addable.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.email)}</option>`).join('')}</select><select id="add_role" aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button class="btn sm" data-act="addPerson">Add</button></div>` : ''}
    ${ROLE !== 'viewer' ? `<div class="btnrow" style="margin-top:10px"><span class="note">Link for someone outside ${esc(info.workspace)}, as</span><select id="inv_role" aria-label="Invite as"><option value="viewer">a viewer</option><option value="editor">an editor</option></select><button class="btn sm" data-act="mkInvite">Create link</button></div>
    <div id="invOut"></div>
    <p class="note">Outsiders join as guests and see only this campaign. Links work for 14 days.</p>
    ${owner ? '<div class="btnrow"><button class="btn sm" data-act="revokeInvites">Turn off all links</button>' + `<button class="btn sm" data-act="campArchive">${camp.archived ? 'Restore this campaign' : 'Archive this campaign'}</button></div>` : ''}` : ''}`;
}
function setupDrawer() {
  const c = S.campaign, ro = !canEditNow();
  showDrawer(`<div class="row"><h2>Edit campaign</h2><button class="btn sm" data-act="close">Close</button></div>
  <details class="sect" open><summary>Campaign</summary>
  <form id="sForm" class="form">
    <label class="wide">Campaign name (the bill or vote)<input id="s_bill" name="bill" value="${esc(c.bill)}"></label>
    <label>Your goal<select id="s_side" name="side"><option value="pass" ${c.side !== 'defeat' ? 'selected' : ''}>Pass it</option><option value="defeat" ${c.side === 'defeat' ? 'selected' : ''}>Defeat it</option></select></label>
    <label>Floor threshold<select id="s_rule" name="rule">${Object.entries(RULES).map(([k, v]) => `<option value="${k}" ${c.rule === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
    <label>Chamber<input id="s_chamber" name="chamber" value="${esc(c.chamber)}"></label>
    <label>Committee<input id="s_committee" name="committee" value="${esc(c.committee)}"></label>
    <label>Committee vote<input type="date" id="s_cd" name="cmteDate" value="${esc(c.cmteDate)}"></label>
    <label>Floor vote<input type="date" id="s_fd" name="floorDate" value="${esc(c.floorDate)}"></label>
    <label class="wide">The ask, in one sentence<input id="s_ask" name="ask" value="${esc(c.ask)}" placeholder="Vote yes on SB 214 without the cap amendment"></label>
    ${S.cloud ? `<label>Client<select id="s_clientId" name="clientId"><option value="">No client</option>${CLIENTS.filter((k) => !k.archived || k.id === c.clientId).map((k) => `<option value="${esc(k.id)}" ${k.id === c.clientId ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}<option value="__new">Add a client…</option></select></label>` : `<label>Client or organization<input id="s_client" name="client" value="${esc(c.client)}"></label>`}
    <label>Your name, as it appears in emails<input id="s_me" name="me" value="${esc(c.me || (CLOUD.user && CLOUD.user.name) || '')}"></label>
    ${ro ? '' : '<div class="wide"><button class="btn primary">Save</button></div>'}
  </form></details>
  ${ro ? '' : `<details class="sect"${S.example || !S.members.length ? ' open' : ''}><summary>Roster</summary>
  ${S.preset ? `<p class="note">Current roster: ${esc(S.preset.label)}, retrieved ${esc(S.preset.asOf)}${S.preset.vacant > 0 ? `, ${S.preset.vacant} seat${S.preset.vacant > 1 ? 's' : ''} not listed` : ''}.</p>` : ''}
  ${(() => {
    const leg = billLegislature(), mine = legChoices(leg), cur = campaignChamber().chamber;
    if (mine.length) return `<p class="note">${esc(billNumberOf() || 'This bill')} is a ${esc(legName(leg))} bill. ${mine.length > 1 ? 'Switch chambers when it crosses over:' : ''}</p>
      <div class="btnrow">${mine.map((c) => `<button class="btn${c.chamber === cur && S.members.length ? ' primary' : ''}" data-act="pickChamber" data-v="${esc(c.value)}" data-label="${esc(c.label)}" ${c.chamber === cur && S.members.length ? 'aria-pressed="true"' : ''}>${esc(c.label)}</button>`).join('')}</div><p class="note" id="s_chMsg" role="status"></p>`;
    return `${ROSTERS ? `<select id="s_preset" aria-label="Preset roster"><option value="">Load a preset chamber</option>${Object.entries(ROSTERS).map(([k, p]) => `<option value="${k}">${esc(p.label)} (${p.members.length})</option>`).join('')}</select><div id="s_presetBox" style="display:flex;flex-direction:column;gap:10px"></div>` : '<p class="note">Preset rosters could not be loaded.</p>'}
  ${typeof rosterLoaderHtml === 'function' ? rosterLoaderHtml() : ''}`;
  })()}
  <div class="btnrow"><span class="note">Set</span><select id="b_party" aria-label="Party"><option value="D">every Democrat</option><option value="R">every Republican</option><option value="I">every independent</option></select><span class="note">to</span><select id="b_pos" aria-label="Position">${[4, 3, 2, 1, 0].map((p) => `<option value="${p}">${POS[p]}</option>`).join('')}</select><button class="btn" data-act="bulk">Apply</button></div>
  <details><summary class="note">Paste your own roster</summary>
  <p class="note">One per line: name, party, district, committee (y/n), position, phone, email. Replaces the current roster.</p>
  <textarea id="s_csv" style="min-height:110px" placeholder="Jordan Avery, D, 12, y, lean yes, 555-0100, javery@example.org" aria-label="Roster to import"></textarea>
  <div class="btnrow"><button class="btn" data-act="import">Replace roster</button></div>
  <div class="note" id="impMsg"></div></details></details>`}
  ${teamSection()}
  ${S.example ? '' : `<details class="sect"><summary>${S.cloud && ROLE !== 'owner' ? 'Leave' : 'Delete'}</summary><div><button class="btn sm warn" data-act="delCamp">${S.cloud && ROLE !== 'owner' ? 'Leave this campaign' : S.cloud ? 'Delete this campaign for everyone' : 'Delete this campaign'}</button></div></details>`}`);
  if (S.cloud) loadTeam();
}
function newCampDrawer() {
  const cloud = signedIn() && ORG && ORG.role !== 'guest';
  showDrawer(`<div class="row"><h2>New campaign</h2><button class="btn sm" data-act="close">Close</button></div>
  <form id="nForm" class="form">
    <label class="wide">Legislature<select id="n_leg" name="leg"><option value="">Choose</option>${legOptions().map(([k, v]) => `<option value="${k}" ${k === lastLeg() ? 'selected' : ''}>${esc(v)}</option>`).join('')}${S.members.length && !S.example ? `<option value="copy">Same members as ${esc(clipWords(S.campaign.bill || 'this campaign', 60))}</option>` : ''}<option value="blank">Something else: I'll add the members</option></select></label>
    <label class="wide">Bill or vote<input id="n_bill" name="bill" required placeholder="HB 1021: Property insurance reform"></label>
    ${signedIn() && (CLOUD.config || {}).bills && CLOUD.config.bills.states ? `<p class="wide note" style="margin-top:-6px"><button type="button" class="linkbtn" data-act="nSearchToggle">Don't know the number? Search by topic</button></p>
    <div class="wide nsearch" id="nSearch" hidden><div class="btnrow"><input id="ns_q" placeholder="A few words, like sales tax or broadband" aria-label="Search bills by topic" autocomplete="off"><button type="button" class="btn" data-act="nSearch">Search</button></div><div id="ns_out" class="ns-out" role="status"></div></div>` : ''}
    <label id="n_chWrap">Chamber<select id="n_from" name="from"></select><span class="note" id="n_hint" style="text-transform:none;font-stretch:100%"></span></label>
    <label>Your goal<select id="n_side" name="side"><option value="pass">Pass it</option><option value="defeat">Defeat it</option></select></label>
    ${cloud ? `<label>Client<select id="n_client" name="clientId"><option value="">No client</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('')}</select></label>
    <label>Who can see it<select id="n_vis" name="vis"><option value="org">Everyone in ${esc(ORG.name)}</option><option value="team">Only people I add</option></select></label>` : ''}
    <p class="wide note">Every current member is loaded with their office, phone and staff. ${cloud ? `It is saved to ${esc(ORG.name)}.` : signedIn() ? 'It is saved in this browser only until you set up a workspace.' : 'It is saved in this browser only. Sign in to save campaigns to your firm\'s workspace and share them.'}</p>
    <p class="wide note" id="nMsg" role="status"></p>
    <div class="wide"><button class="btn primary">Create campaign</button></div>
  </form>`);
  nChamberSync();
}
// Finding a bill by topic, in the chosen legislature.
async function billSearch() {
  const out = $('#ns_out'), q = $('#ns_q').value.trim(), leg = ($('#n_leg') || {}).value || '';
  if (!leg || leg === 'copy' || leg === 'blank') { out.innerHTML = '<p class="note">Choose the legislature below first, then search.</p>'; return; }
  if (q.length < 3) { out.innerHTML = '<p class="note">Type a few words about the bill.</p>'; return; }
  out.innerHTML = `<p class="note">Searching ${esc(legName(leg))}</p>`;
  try {
    const r = await CLOUD.api('GET', `/api/bills/search?${new URLSearchParams({ leg, q })}`);
    out.innerHTML = r.bills.length ? `<ul class="ns-list">${r.bills.map((b) => `<li><div><b>${esc(b.number)}</b> <span class="meta">${esc(b.session)}</span><div>${esc(clipWords(b.title, 160))}</div><div class="meta">${esc(b.status)}${b.statusDate ? `, ${esc(fmtDay(b.statusDate))}` : ''}</div></div><button type="button" class="btn sm" data-act="nPick" data-n="${esc(b.number)}" data-title="${esc(b.title)}" data-leg="${esc(b.leg)}" data-s="${esc(b.session)}">Count this bill</button></li>`).join('')}</ul>` : `<p class="note">Nothing in ${esc(legName(leg))} matches "${esc(q)}". Try other words.</p>`;
  } catch (e) { out.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}
function feedbackDrawer() {
  showDrawer(`<div class="row"><h2>Send feedback</h2><button class="btn sm" data-act="close">Close</button></div>
    <p>What is confusing, missing or broken? What would make Headcount worth paying for? It goes straight to the people who build it.</p>
    <form id="fbForm" class="form"><label class="wide">Your note<textarea name="message" rows="6" required placeholder="I tried to... and expected..."></textarea></label>
    <div class="wide btnrow"><button class="btn primary">Send</button><span class="note" id="fbMsg" role="status"></span></div></form>`);
  const t = $('#fbForm textarea'); if (t) t.focus();
}
// Plain meanings of the words legislatures and whip counts use.
const GLOSSARY = [
  ['Whip count', 'A tally of where every member stands on a bill, to see whether it has the votes. Headcount keeps one per campaign.'],
  ['Yes, lean yes, undecided, lean no, no', 'Where a member stands. "Lean" means they are inclined that way but have not committed.'],
  ['Odds of passage', 'Headcount\'s estimate that the bill would pass if the vote were today, from each member\'s position and how movable they are. It updates as you mark members.'],
  ['Movable', 'How likely a member is to change position, from 1 (settled) to 5 (very persuadable). It shapes "Who to see next".'],
  ['Floor threshold', 'How many votes it takes to pass: usually a majority of the members, sometimes two-thirds or three-fifths.'],
  ['Committee', 'A small group of members who review bills on one subject before the full chamber votes. Most bills never get out of committee.'],
  ['Referred', 'Sent to a committee for review.'],
  ['Agenda, hearing', 'A committee meeting where the bill is scheduled to be discussed and often voted on. Meet the committee\'s members before it.'],
  ['Committee substitute (CS)', 'A rewritten version of the bill that a committee adopts. In Florida, "CS by Commerce" means the Commerce committee approved it with changes.'],
  ['Reported', 'Sent on by a committee to the full chamber, usually after approving it.'],
  ['First, second and third reading', 'Formal stages on the floor. Amendments usually come at second reading; the final vote follows third reading.'],
  ['Floor vote', 'A vote of the full House, Assembly or Senate.'],
  ['Tabled', 'Set aside. A tabled bill can be taken up again later, but often is not.'],
  ['Crossed over', 'Passed one chamber and went to the other, which repeats the committee and floor steps.'],
  ['Concur', 'One chamber agrees to the other chamber\'s changes, so both have passed the same text.'],
  ['Conference committee', 'Members of both chambers who work out the differences between their versions of a bill.'],
  ['Enrolled', 'The final version passed by both chambers, prepared for the governor or the President.'],
  ['Veto and override', 'The governor or the President rejects the bill. Lawmakers can override the veto, usually with two-thirds of each chamber.'],
  ['Cloture', 'In the U.S. Senate, a vote to end debate so the Senate can vote. It takes 60 votes, which is why many bills need more than a majority there.'],
  ['Motion to proceed', 'In the U.S. Senate, the motion to start working on a bill. It can itself need cloture.'],
  ['Rules Committee', 'In the U.S. House, the committee that sets how long a bill is debated and which amendments are allowed.'],
  ['Sponsor, cosponsor', 'The member who files the bill, and the members who sign on to support it.'],
  ['Session', 'The period a legislature meets. Bills that have not passed by the end usually die and have to be filed again.'],
  ['Chapter, Act number, Public Law', 'The number a bill gets when it becomes law.'],
  ['Scheduler', 'The staffer who runs a legislator\'s calendar and answers meeting requests.'],
  ['House, Assembly, House of Delegates', 'Different states\' names for the larger chamber. Headcount uses each state\'s own name.'],
];
function glossaryDrawer(term) {
  showDrawer(`<div class="row"><h2>What the words mean</h2><button class="btn sm" data-act="close">Close</button></div>
    <input id="gl_q" placeholder="Find a word" aria-label="Find a word" value="${esc(term)}">
    <dl class="glossary" id="gl_list">${GLOSSARY.map(([w, d]) => `<div data-w="${esc(`${w} ${d}`.toLowerCase())}"><dt>${esc(w)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>
    <p class="note">Missing a word? The <a href="${GUIDE}" target="_blank" rel="noopener">step-by-step guide</a> explains each part of Headcount.</p>`);
  glossaryFilter();
}
function glossaryFilter() { const q = (($('#gl_q') || {}).value || '').trim().toLowerCase(); document.querySelectorAll('#gl_list > div').forEach((d) => { d.hidden = Boolean(q) && !d.dataset.w.includes(q); }); }
// The legislatures a campaign can be for: Congress and the states whose members load here.
function legOptions() {
  const cfg = CLOUD.config || {}, states = Object.assign({}, cfg.rosters && signedIn() ? cfg.states || {} : {});
  if (legChoices('FL').length) states.FL = 'Florida';
  return [...(legChoices('US').length ? [['US', 'U.S. Congress']] : []), ...Object.entries(states).filter(([k]) => legChoices(k).length).sort((x, y) => x[1].localeCompare(y[1]))];
}
const lastLeg = () => { try { return localStorage.getItem('headcount.leg') || ''; } catch (_) { return ''; } };
// A bill the Monitor found says which legislature it is from.
function monitorLeg(bill) {
  const key = (n) => String(n || '').toUpperCase().replace(/[\s.]/g, ''), want = key(billNumberOf({ campaign: { bill } }));
  if (!want || typeof MON === 'undefined' || !MON.items) return '';
  const found = [...new Set(MON.items.filter((i) => key(i.number) === want).map((i) => i.juris))];
  return found.length === 1 ? found[0] : '';
}
// Shows only the chosen legislature's chambers and picks the one the bill
// number points to (HB: the House, SB: the Senate). Nothing to ask for a
// one-chamber legislature, or when the members are copied or typed in.
function nChamberSync(legChanged) {
  const legSel = $('#n_leg'), from = $('#n_from'), wrap = $('#n_chWrap'), hint = $('#n_hint'); if (!legSel || !from) return;
  const bill = $('#n_bill').value;
  if (!legChanged) { const hit = monitorLeg(bill); if (hit && [...legSel.options].some((o) => o.value === hit)) legSel.value = hit; }
  const leg = legSel.value;
  if (!leg || leg === 'copy' || leg === 'blank') { from.innerHTML = `<option value="${leg}"></option>`; from.value = leg; wrap.hidden = true; return; }
  const list = legChoices(leg), want = billChamber(billNumberOf({ campaign: { bill } }), leg);
  const keep = from.dataset.user === '1' && list.some((c) => c.value === from.value) ? from.value : '';
  const pick = keep || (list.find((c) => c.chamber === want) || {}).value || '';
  from.innerHTML = (pick ? '' : '<option value="">Choose the chamber</option>') + list.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');
  from.value = pick; wrap.hidden = list.length < 2;
  hint.textContent = pick && !keep && want ? `From the bill number. ${list.length > 1 ? 'Change it if you are counting the other chamber.' : ''}` : '';
}
let LOC = { mode: 'signin', reset: null, ticket: null, codes: null }, TWOFA = { on: false, left: null };
function localSignInDrawer(mode) {
  const cfg = CLOUD.config, first = cfg.accounts && cfg.accounts.setup, inviteOnly = cfg.accounts && cfg.accounts.signups === 'invite';
  LOC.mode = first ? 'signup' : mode || 'signin';
  const m = LOC.mode, title = first ? 'Set up Headcount' : { signin: 'Sign in', signup: 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password', code: 'Two-step sign-in' }[m];
  const field = (id, label, type, ac, extra = '') => `<label class="wide">${label}<input id="${id}" type="${type}" autocomplete="${ac}" required ${extra}></label>`;
  showDrawer(`<div class="row"><h2>${title}</h2><button class="btn sm" data-act="close">Close</button></div>
  ${m === 'code' ? '<p class="note">Enter the six-digit code from your authenticator app, or a recovery code.</p>' : ''}
  ${first ? '<p class="note">You are the first person here, so you will also manage Headcount\'s settings.</p>' : ''}
  ${m === 'signup' && inviteOnly && !JOIN && !first ? '<p class="note">New accounts need an invitation. Open the link you were sent.</p>' : ''}
  ${(m === 'signin' || m === 'signup') && CLOUD.googleClientId() ? `<div class="gsiwrap"><div id="gsiBtn"></div><p class="note" id="gsiMsg" role="status"></p></div><p class="orline"><span>or with your email</span></p>` : ''}
  <form id="locForm" class="form" data-mode="${m}">
    ${m === 'signup' ? field('loc_name', 'Your name', 'text', 'name') : ''}
    ${m === 'signup' && !JOIN ? field('loc_org', 'Firm or team name', 'text', 'organization', 'maxlength="80" placeholder="For example, Capitol Strategies"') : ''}
    ${m === 'code' ? field('loc_code', 'Code', 'text', 'one-time-code', 'inputmode="numeric" maxlength="12" autofocus') : ''}
    ${m !== 'reset' && m !== 'code' ? field('loc_email', m === 'signup' ? 'Work email' : 'Email', 'email', 'email') : ''}
    ${m === 'signin' || m === 'signup' || m === 'reset' ? field('loc_pw', m === 'signin' ? 'Password' : 'New password (at least 10 characters)', 'password', m === 'signin' ? 'current-password' : 'new-password', 'minlength="10"') : ''}
    <div class="wide"><button class="btn primary">${{ signin: 'Sign in', signup: first ? 'Create account and continue' : 'Create account', forgot: 'Email me a reset link', reset: 'Save and sign in', code: 'Verify and sign in' }[m]}</button></div>
    ${m === 'signup' ? '<p class="note wide">By creating an account you agree to the <a href="/terms" target="_blank" rel="noopener">terms</a> and the <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>.</p>' : ''}
    <p class="note wide" id="locMsg" role="status"></p>
  </form>
  ${first || m === 'reset' ? '' : m === 'code' ? '<p class="note"><button class="linkbtn" data-act="locMode" data-m="signin">Start over</button></p>' : `<p class="note">${m === 'signin' ? `New here? <button class="linkbtn" data-act="locMode" data-m="signup">Create an account</button> · <button class="linkbtn" data-act="locMode" data-m="forgot">Forgot your password?</button>` : `Already have an account? <button class="linkbtn" data-act="locMode" data-m="signin">Sign in</button>`}</p>`}`);
  drawGoogleButton();
}
// Continue with Google: signs in, or makes the account the first time.
function drawGoogleButton() {
  const el = $('#gsiBtn'); if (!el) return;
  CLOUD.googleButton(el, async (credential) => {
    const msg = $('#gsiMsg'); if (msg) msg.textContent = 'Signing in';
    try {
      const r = await CLOUD.signInGoogle(credential, { invite: JOIN ? JOIN.code : undefined, workspace: $('#loc_org') ? $('#loc_org').value : undefined });
      if (r && r.twoFactor) { LOC.ticket = r.ticket; return localSignInDrawer('code'); }
      if (CLOUD.config.accounts) CLOUD.config.accounts.setup = false;
      closeDrawer(); if (r && r.created) toast('Welcome to Headcount');
    } catch (e) { if (msg) msg.textContent = e.message; }
  }).then((ok) => { if (!ok) el.closest('.gsiwrap')?.remove(); });
}
async function submitLocal(form) {
  const m = form.dataset.mode, msg = $('#locMsg'), btn = $('button.primary', form), v = (id) => ($('#' + id) ? $('#' + id).value : '');
  btn.disabled = true; msg.textContent = '';
  let r = null;
  try {
    if (m === 'code') { r = await CLOUD.signInCode(LOC.ticket, v('loc_code')); LOC.ticket = null; if (r.recoveryLeft !== undefined) toast(`Signed in with a recovery code. ${r.recoveryLeft} left; make new ones under Account.`); }
    else if (m === 'signin') r = await CLOUD.signInLocal(v('loc_email'), v('loc_pw'));
    else if (m === 'signup') await CLOUD.signUpLocal({ name: v('loc_name'), email: v('loc_email'), password: v('loc_pw'), workspace: JOIN ? undefined : v('loc_org'), invite: JOIN ? JOIN.code : undefined });
    else if (m === 'forgot') { const r = await CLOUD.resetRequest(v('loc_email')); msg.textContent = r.email ? 'If that address has an account, a reset link is on its way. It works for one hour.' : 'Headcount cannot send email yet, so ask whoever runs your Headcount to reset your password.'; btn.disabled = false; return; }
    else if (m === 'reset') { r = await CLOUD.resetPassword(LOC.reset, v('loc_pw')); LOC.reset = null; history.replaceState(null, '', '/app'); toast(r.twoFactor ? 'Password changed. Now enter your code.' : 'Password changed. You are signed in.'); }
    if (r && r.twoFactor) { LOC.ticket = r.ticket; return localSignInDrawer('code'); }
    if (CLOUD.config.accounts) CLOUD.config.accounts.setup = false;
    closeDrawer();
  } catch (e) { msg.textContent = e.message; btn.disabled = false; }
}
function signInDrawer(mode) {
  const cfg = CLOUD.config;
  if (cfg.auth === 'local') return localSignInDrawer(mode === 'sso' ? 'signin' : mode);
  showDrawer(`<div class="row"><h2>Sign in</h2><button class="btn sm" data-act="close">Close</button></div>
  <div class="signin">
    ${cfg.auth === 'dev' ? '<p class="note"><b>Local test mode.</b> No real account is used.</p><label class="note">Name<input id="dev_name" value="Test User"></label><label class="note">Email<input id="dev_email" value="tester@example.org"></label>' : ''}
    ${cfg.providers.map((p) => `<button class="btn" data-act="signinWith" data-p="${p}">Continue with ${CLOUD.providerName(p)}</button>`).join('')}
    ${cfg.sso ? `<details class="sect" ${mode === 'sso' ? 'open' : ''}><summary>Sign in with single sign-on</summary>
      <form id="ssoForm" class="taskadd"><input id="sso_email" name="email" type="email" required placeholder="you@yourfirm.com" aria-label="Work email" value="${esc((SSO_STEP && SSO_STEP.email) || '')}"><button class="btn">Continue</button></form>
      <div id="ssoNext" class="note">${SSO_STEP && SSO_STEP.provider ? `<button class="btn primary" data-act="ssoGo">Continue to ${esc(SSO_STEP.workspace)} sign-in</button>` : 'For firms with their own login page, such as Okta or Microsoft Entra ID.'}</div></details>` : ''}
    <p class="note">Save your campaigns to your firm's workspace and share them. Calendar and email access is asked for only when you first send a meeting request. <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p>
  </div>`);
}
// ---------- calendar feed ----------
async function loadCalendar(renew) {
  const box = $('#calBody'); if (!box) return;
  try {
    const r = await CLOUD.api(renew ? 'POST' : 'GET', '/api/me/calendar');
    box.innerHTML = `<label class="note" style="display:flex;flex-direction:column;gap:4px">Your private link<input id="calUrl" readonly value="${esc(r.url)}"></label>
      <div class="btnrow"><button class="btn sm primary" data-act="calCopy">Copy link</button><a class="btn sm" href="${esc(r.url.replace(/^https?:/, 'webcal:'))}">Open in my calendar app</a><button class="btn sm" data-act="calRenew">Make a new link</button></div>
      <p class="note">Add it in Outlook or Google Calendar as a calendar from a web address. Keep the link private.</p>`;
    if (renew) toast('New calendar link. The old one no longer works.');
  } catch (err) { box.innerHTML = `<p class="bad">${esc(err.message)}</p>`; }
}
document.addEventListener('toggle', (e) => { if (e.target.id === 'calSect' && e.target.open) loadCalendar(); }, true);

// ---------- two-step sign-in ----------
function twoFactorSect() {
  if (TWOFA.on) return `<details class="sect" id="tfSect"><summary>Two-step sign-in <span class="status ok">On</span></summary>
    <p class="note">Signing in on a new device asks for a code from your authenticator app. ${TWOFA.left == null ? '' : `You have ${TWOFA.left} recovery code${TWOFA.left === 1 ? '' : 's'} left.`}</p>
    <div id="tfBody"><form id="tfRecForm" class="form"><label class="wide">Code from your app<input id="tf_rcode" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required></label><div class="wide"><button class="btn sm">Make new recovery codes</button></div><p class="note wide" id="tfRecMsg" role="status"></p></form>
    <form id="tfOffForm" class="form"><label class="wide">Password<input id="tf_pw" type="password" autocomplete="current-password" required></label><label class="wide">Code from your app, or a recovery code<input id="tf_ocode" autocomplete="one-time-code" maxlength="12" required></label><div class="wide"><button class="btn sm warn">Turn off two-step sign-in</button></div><p class="note wide" id="tfOffMsg" role="status"></p></form></div></details>`;
  return `<details class="sect" id="tfSect"><summary>Two-step sign-in <span class="status">Off</span></summary>
    <p class="note">Ask for a code from an authenticator app when you sign in on a new device.</p>
    <div id="tfBody"><button class="btn sm" data-act="tfStart">Turn on</button></div></details>`;
}
function showRecovery(codes, lead) {
  LOC.codes = codes;
  $('#tfBody').innerHTML = `<p class="note"><b>${lead}</b> Save these recovery codes somewhere safe, such as your password manager. Each works once if you lose your phone.</p>
    <ol class="codes">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ol>
    <div class="btnrow"><button class="btn sm" data-act="tfCopy">Copy</button><button class="btn sm" data-act="tfDownload">Download</button><button class="btn sm primary" data-act="tfDone">I saved them</button></div>`;
}
async function twoFactorAct(a) {
  if (a === 'tfStart') {
    try {
      const r = await CLOUD.api('POST', '/api/auth/2fa/start');
      $('#tfBody').innerHTML = `<ol class="steps"><li>Scan this with your authenticator app.<div class="qrbox">${r.qr}</div><span class="note">Cannot scan it? Add an account by key: <code class="key">${esc(r.secret)}</code></span></li>
        <li><form id="tfOnForm" class="form"><label class="wide">Enter the six-digit code it shows<input id="tf_code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label><div class="wide"><button class="btn sm primary">Turn on</button></div><p class="note wide" id="tfOnMsg" role="status"></p></form></li></ol>`;
      $('#tf_code').focus();
    } catch (err) { fail(err); }
  }
  if (a === 'tfCopy') { try { await navigator.clipboard.writeText(LOC.codes.join('\n')); toast('Copied'); } catch (_) { toast('Select the codes and copy them'); } }
  if (a === 'tfDownload') download('headcount-recovery-codes.txt', `Headcount recovery codes for ${CLOUD.user.email}\nEach works once.\n\n${LOC.codes.join('\n')}\n`, 'text/plain');
  if (a === 'tfDone') {
    LOC.codes = null;
    if (TFA_NEEDED) { TFA_NEEDED = null; closeDrawer(); return onSignedIn(); } // the workspace that asked for it opens now
    accountDrawer(); $('#tfSect').open = true;
  }
}
async function twoFactorForm(id) {
  if (id === 'tfOnForm') {
    try { const r = await CLOUD.api('POST', '/api/auth/2fa/enable', { code: $('#tf_code').value }); TWOFA = { on: true, left: r.recovery.length }; $('#tfSect summary').innerHTML = 'Two-step sign-in <span class="status ok">On</span>'; $('#tfSect > p.note').remove(); showRecovery(r.recovery, 'Two-step sign-in is on. Other devices are signed out.'); }
    catch (err) { $('#tfOnMsg').textContent = err.message; }
  }
  if (id === 'tfRecForm') {
    try { const r = await CLOUD.api('POST', '/api/auth/2fa/recovery', { code: $('#tf_rcode').value }); TWOFA.left = r.recovery.length; showRecovery(r.recovery, 'New recovery codes. The old ones no longer work.'); }
    catch (err) { $('#tfRecMsg').textContent = err.message; }
  }
  if (id === 'tfOffForm') {
    try { await CLOUD.api('POST', '/api/auth/2fa/disable', { password: $('#tf_pw').value, code: $('#tf_ocode').value }); TWOFA = { on: false, left: null }; toast('Two-step sign-in is off'); accountDrawer(); }
    catch (err) { $('#tfOffMsg').textContent = err.message; }
  }
}
function accountDrawer(scrollToEmail) {
  const u = CLOUD.user, p = CLOUD.provider(), cfg = CLOUD.config || {}, pr = PREFS || { digest: 'weekly', digestHour: 8, notifyAssigned: true, notifyAdded: true };
  const how = CLOUD.local() ? 'Email and password' : CLOUD.isSSO() ? 'Single sign-on' : CLOUD.providerName(u.provider);
  const choices = p ? [p] : CLOUD.connectable();
  showDrawer(`<div class="row"><h2>Account</h2><button class="btn sm" data-act="close">Close</button></div>
  <dl class="kv"><dt>Name</dt><dd><span id="myName">${esc(u.name)}</span> <button class="linkbtn" data-act="editMyName">Change</button></dd><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Signed in with</dt><dd>${esc(how)}</dd>
  ${CLOUD.local() ? `<dt>Email confirmed</dt><dd>${u.emailVerified ? '<span class="status ok">Yes</span>' : `<span class="status wait">Not yet</span> <button class="btn sm" data-act="resendVerify">Send the link again</button>`}</dd>` : ''}
  ${CLOUD.canConnect() ? `<dt>Calendar and email</dt><dd>${CLOUD.connected() ? `<span class="status ok">${esc(CLOUD.mailName(p))} connected in this tab</span>` : '<span class="status">Not connected</span>'}</dd>` : ''}</dl>
  ${CLOUD.local() ? `<details class="sect"><summary>Change password</summary><form id="pwForm" class="form"><label class="wide">Current password<input id="pw_cur" type="password" autocomplete="current-password" required></label><label class="wide">New password (at least 10 characters)<input id="pw_new" type="password" autocomplete="new-password" minlength="10" required></label><div class="wide"><button class="btn">Change password</button></div><p class="note wide" id="pwMsg" role="status"></p></form></details>${twoFactorSect()}` : ''}
  ${CLOUD.connected() || !CLOUD.canConnect() ? '' : `<p class="note">Connect ${choices.map((x) => `${CLOUD.mailName(x)} and ${CLOUD.calName(x)}`).join(', or ')} to send meeting requests and invitations from your own account. Headcount reads your calendar only to find open times, never reads your email, and keeps the connection in this browser tab.</p>
  <div class="btnrow">${choices.map((x) => `<button class="btn" data-act="connect" data-mp="${x}">Connect ${CLOUD.mailName(x)}</button>`).join('')}</div>`}
  ${cfg.email ? `<details class="sect" id="emailSect" open><summary>Email from Headcount</summary>
    <label class="note" style="display:flex;flex-direction:column;gap:4px">Digest<select id="pf_digest"><option value="daily" ${pr.digest === 'daily' ? 'selected' : ''}>Every morning</option><option value="weekly" ${pr.digest === 'weekly' ? 'selected' : ''}>Monday mornings</option><option value="off" ${pr.digest === 'off' ? 'selected' : ''}>No digest</option></select></label>
    <label class="note" style="display:flex;flex-direction:column;gap:4px">Send it at<select id="pf_hour">${[6, 7, 8, 9, 10, 11, 12].map((h) => `<option value="${h}" ${pr.digestHour === h ? 'selected' : ''}>${h <= 12 ? h : h - 12}${h < 12 ? ' a.m.' : ' p.m.'}</option>`).join('')}</select></label>
    <p class="note">Moves, contacts, what's coming up and overdue follow-ups, in your time zone${pr.tz ? ` (${esc(pr.tz)})` : ''}.</p>
    <label class="note" style="display:flex;flex-direction:column;gap:4px">Monitor alerts<select id="pf_monitor"><option value="instant" ${pr.monitor === 'instant' ? 'selected' : ''}>Email me as soon as something relevant appears</option><option value="digest" ${pr.monitor !== 'instant' && pr.monitor !== 'off' ? 'selected' : ''}>Include them in my digest</option><option value="off" ${pr.monitor === 'off' ? 'selected' : ''}>Only show them in the app</option></select></label>
    <label class="check"><input type="checkbox" id="pf_assigned" ${pr.notifyAssigned ? 'checked' : ''}> Email me when someone assigns me a follow-up</label>
    <label class="check"><input type="checkbox" id="pf_added" ${pr.notifyAdded ? 'checked' : ''}> Email me when someone adds me to a campaign</label>
  </details>` : ''}
  <details class="sect" id="calSect"><summary>Calendar feed</summary>
    <p class="note">Votes, meetings and follow-ups in your own calendar, kept up to date.</p>
    <div id="calBody"><p class="note">Loading</p></div></details>
  ${OPERATOR ? '<div class="btnrow"><button class="btn" data-x="serverSettings">Admin settings</button></div>' : ''}
  <div class="btnrow"><button class="btn" data-act="signout">Sign out</button>${CLOUD.local() ? '<button class="btn" data-act="signoutAll">Sign out on every device</button>' : ''}</div>
  <details class="sect"><summary>Delete my account</summary><p class="note">Removes you from every workspace and deletes your account. A workspace you own passes to its next admin.</p><div><button class="btn sm warn" data-act="delAccount">Delete my account</button></div></details>`);
  if (scrollToEmail && $('#emailSect')) $('#emailSect').scrollIntoView({ block: 'start' });
}
async function reloadClients() { CLIENTS = (await CLOUD.api('GET', `/api/workspaces/${ORG.id}/clients`)).clients; }
function newOrgDrawer() {
  showDrawer(`<div class="row"><h2>New workspace</h2><button class="btn sm" data-act="close">Close</button></div>
  <form id="noForm" class="form"><label class="wide">Name<input id="no_name" name="name" required placeholder="Your firm or organization"></label>
  <p class="wide note">A separate workspace has its own campaigns, clients, people and plan.</p>
  <div class="wide"><button class="btn primary">Create workspace</button></div></form>`);
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-open],[data-act],[data-view],[data-copy],[data-rep],[data-tab],[data-page],[data-rqmode],[data-opencamp],#scrim');
  for (const menu of [$('#moreMenu'), $('#helpMenu')]) if (menu && menu.open && !(e.target.closest('summary') && menu.contains(e.target))) menu.open = false;
  if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; staffEdit = null; return memberDrawer(openId); }
  if (t.id === 'scrim') return closeDrawer();
  if (t.dataset.copy) return copyText(t.dataset.copy);
  if (t.dataset.view) { view = t.dataset.view; return render(); }
  if (t.dataset.page) { closeDrawer(); page = t.dataset.page; briefEdit = false; briefPanel = ''; window.scrollTo(0, 0); return render(); }
  if (t.dataset.opencamp) { page = 'count'; window.scrollTo(0, 0); return cloudOpen(t.dataset.opencamp); }
  if (t.dataset.rep) { repKind = t.dataset.rep; return reportsDrawer(); }
  if (t.dataset.rqmode) { rqRead(); RQ.mode = t.dataset.rqmode; RQ.msg = ''; return memberDrawer(openId); }
  if (t.dataset.open) return memberDrawer(t.dataset.open);
  const a = t.dataset.act, m = S.members.find((x) => x.id === openId);
  const sure = (label) => { if (t.dataset.sure === '1') return true; t.dataset.sure = '1'; t.textContent = label; t.classList.add('warn'); return false; };
  // Calendar and email access needs a pop-up, so ask before any await.
  const needsMail = ['rqSend', 'rqInvite', 'rqFind', 'checkReplies', 'connect'].includes(a) || (a === 'cancelMeet' && (() => { const mt = S.meetings.find((x) => x.id === t.dataset.id); return mt && mt.eventId && mine(mt) && !ended(mt) && t.dataset.sure === '1'; })());
  const access = needsMail && signedIn() && CLOUD.canConnect() && (!CLOUD.connected() || (t.dataset.mp && CLOUD.provider() !== t.dataset.mp)) ? CLOUD.connect(t.dataset.mp) : null;
  const ready = async () => { if (access) { try { await access; } catch (err) { if (RQ && $('#rqMsg')) rqMsg(err.message); else fail(err); return false; } } return true; };
  switch (a) {
    case 'close': return closeDrawer();
    case 'gotoPlans': closeDrawer(); page = 'workspace'; render(); window.scrollTo(0, 0); return;
    case 'joinDomain': {
      try {
        const r = await CLOUD.api('POST', `/api/workspaces/${t.dataset.id}/join`);
        ORGS = (await CLOUD.api('GET', '/api/workspaces')).workspaces; DOMAIN_MATCHES = DOMAIN_MATCHES.filter((o) => o.id !== t.dataset.id);
        await loadOrg(r.orgId); page = 'portfolio'; render(); toast(`Welcome to ${ORG.name}`);
      } catch (err) { fail(err); }
      return;
    }
    case 'billCheckout': case 'billPortal': {
      t.disabled = true;
      try {
        const r = a === 'billPortal' ? await CLOUD.api('POST', `/api/workspaces/${ORG.id}/billing/portal`) : await CLOUD.api('POST', `/api/workspaces/${ORG.id}/billing/checkout`, { seats: +$('#bill_seats').value, plan: t.dataset.plan });
        location.href = r.url;
      } catch (err) { t.disabled = false; fail(err); }
      return;
    }
    case 'billSeats': {
      try { const r = await CLOUD.api('POST', `/api/workspaces/${ORG.id}/billing/seats`, { seats: +$('#bill_seats').value }); await loadOrg(ORG.id); render(); toast(`The workspace now has ${r.seats} seats. Stripe adjusts the next invoice.`); } catch (err) { fail(err); }
      return;
    }
    case 'orgRemove': if (sure('Confirm remove')) { try { await CLOUD.api('DELETE', `/api/workspaces/${ORG.id}/members/${encodeURIComponent(t.dataset.uid)}`); WS.members = null; await loadOrg(ORG.id, { quiet: true }); render(); toast('Removed from the workspace'); } catch (err) { fail(err); } } return;
    case 'orgRevoke': try { await CLOUD.api('DELETE', `/api/workspaces/${ORG.id}/invites/${encodeURIComponent(t.dataset.code)}`); WS.invites = null; loadWs(); toast('Invitation revoked'); } catch (err) { fail(err); } return;
    case 'clientRename': {
      const k = CLIENTS.find((x) => x.id === t.dataset.id), name = k && window.prompt('Client name', k.name);
      if (!name) return;
      try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/clients/${k.id}`, { name }); await reloadClients(); render(); } catch (err) { fail(err); }
      return;
    }
    case 'clientArchive': { const k = CLIENTS.find((x) => x.id === t.dataset.id); try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/clients/${k.id}`, { archived: !k.archived }); await reloadClients(); render(); } catch (err) { fail(err); } return; }
    case 'clientDelete': if (sure('Delete client')) { try { await CLOUD.api('DELETE', `/api/workspaces/${ORG.id}/clients/${t.dataset.id}`); await reloadClients(); await refreshAccount(); render(); toast('Client deleted. Its campaigns are kept, without a client.'); } catch (err) { fail(err); } } return;
    case 'dmVerify': try { await CLOUD.api('POST', `/api/workspaces/${ORG.id}/domain/verify`); await loadOrg(ORG.id); render(); toast('Domain verified'); } catch (err) { fail(err); } return;
    case 'dmRemove': if (sure('Remove the domain')) { try { await CLOUD.api('DELETE', `/api/workspaces/${ORG.id}/domain`); await loadOrg(ORG.id); render(); } catch (err) { fail(err); } } return;
    case 'rpCsv': {
      const r = WS.report;
      return csvDownload(`lobbying-activity-${r.from}-to-${r.to}.csv`, [['Date', 'Client', 'Issue', 'Chamber', 'Member', 'Party', 'District', 'Spoke with', 'Type', 'Logged by', 'Notes']].concat(r.rows.map((x) => [x.date, x.client, x.issue, x.chamber, x.member, x.party, x.district, x.withWhom, x.type, x.loggedBy, x.note])));
    }
    case 'auditCsv': return csvDownload(`activity-log-${today()}.csv`, [['When', 'Who', 'Action', 'Target']].concat(WS.audit.map((x) => [new Date(x.at).toISOString(), x.actor, ACTIONS[x.action] || x.action, x.target])));
    case 'auditMore': {
      try { const last = WS.audit[WS.audit.length - 1], r = await CLOUD.api('GET', `/api/workspaces/${ORG.id}/audit?limit=50&before=${last.id}`); WS.audit = WS.audit.concat(r.entries); WS.auditMore = r.entries.length === 50; renderWorkspace(true); } catch (err) { fail(err); }
      return;
    }
    case 'orgExport': try { const r = await CLOUD.api('GET', `/api/workspaces/${ORG.id}/export`); download(`${ORG.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-export-${today()}.json`, JSON.stringify(r, null, 2), 'application/json'); } catch (err) { fail(err); } return;
    case 'orgDelete': case 'orgLeave': {
      if (!sure(a === 'orgDelete' ? `Delete ${ORG.name} for everyone` : `Leave ${ORG.name}`)) return;
      try {
        await CLOUD.api('DELETE', a === 'orgDelete' ? `/api/workspaces/${ORG.id}` : `/api/workspaces/${ORG.id}/members/${encodeURIComponent(ME)}`);
        const gone = ORG.name; ORGS = (await CLOUD.api('GET', '/api/workspaces')).workspaces; ORG = null; ACCOUNT.list = []; lsDel(LASTORG); lsDel(LAST);
        if (S.cloud) { stopPoll(); SYNC = newSync(null); if (!loadLocal()) goExample(); }
        if (ORGS.length) await loadOrg(ORGS[0].id, { quiet: true });
        page = ORG ? 'portfolio' : 'workspace'; render(); toast(a === 'orgDelete' ? `${gone} was deleted` : `You left ${gone}`);
      } catch (err) { fail(err); }
      return;
    }
    case 'addPerson': try { await CLOUD.api('POST', `/api/campaigns/${encodeURIComponent(S.id)}/people`, { userId: $('#add_person').value, role: $('#add_role').value }); loadTeam(); toast('Added to the campaign'); } catch (err) { fail(err); } return;
    case 'campArchive': {
      const camp = ACCOUNT.list.find((x) => x.id === S.id) || {};
      try { await CLOUD.api('PATCH', `/api/campaigns/${encodeURIComponent(S.id)}`, { archived: !camp.archived }); await refreshAccount(); closeDrawer(); toast(camp.archived ? 'Campaign restored' : 'Campaign archived. It stays readable and no longer counts toward your plan.'); render(); } catch (err) { fail(err); }
      return;
    }
    case 'setup': return setupDrawer();
    case 'addDirStaff': { const m = S.members.find((x) => x.id === openId), key = presetKey(); if (!m) return; await staffFor(key); const add = dirStaff(key, m.ref); m.staffers.push(...add); commit(`${add.length} staff added`); return memberDrawer(m.id); }
    case 'addDirStaffAll': { const key = presetKey(); await staffFor(key); let n = 0; S.members.forEach((m) => { if (m.ref && !m.staffers.some((s) => s.src === 'directory')) { const add = dirStaff(key, m.ref); n += add.length; m.staffers.push(...add); } }); closeDrawer(); return commit(n ? `${n} staff added from the official directory` : 'No more staff to add'); }
    case 'updateMembers': return updateMembers();
    case 'quickChamber': return quickChamber(t);
    case 'reports': return reportsDrawer();
    case 'staffDir': return staffDirDrawer();
    case 'newCamp': return newCampDrawer();
    case 'signin': return signInDrawer();
    case 'locMode': return localSignInDrawer(t.dataset.m);
    case 'hideGetting': lsSet('headcount.gs.' + ORG.id, 1); return renderPortfolio();
    case 'tfStart': case 'tfCopy': case 'tfDownload': case 'tfDone': return twoFactorAct(a);
    case 'calCopy': try { await navigator.clipboard.writeText($('#calUrl').value); toast('Calendar link copied'); } catch (_) { $('#calUrl').select(); toast('Select the link and copy it'); } return;
    case 'calRenew': return loadCalendar(true);
    case 'tfaSetup': accountDrawer(); $('#tfSect').open = true; return TWOFA.on ? null : twoFactorAct('tfStart');
    case 'signoutAll': await flushNow(); await CLOUD.signOutEverywhere(); return toast('Signed out on every device');
    case 'resendVerify': try { const r = await CLOUD.api('POST', '/api/auth/verify-email'); toast(r.sent ? 'Confirmation email sent' : 'Headcount cannot send email yet'); } catch (err) { fail(err); } return;
    case 'ssoSwitch': await flushNow(); await CLOUD.signOut(); SSO_NEEDED = null; return signInDrawer('sso');
    case 'ssoGo': try { await CLOUD.signInSSO(SSO_STEP.provider, SSO_STEP.email); SSO_STEP = null; closeDrawer(); } catch (err) { fail(err); } return;
    case 'account': return accountDrawer();
    case 'signinWith': {
      const dev = CLOUD.config.auth === 'dev' ? { name: $('#dev_name').value, email: $('#dev_email').value, id: $('#dev_email').value.split('@')[0] } : null;
      try { await CLOUD.signIn(t.dataset.p, dev); closeDrawer(); } catch (err) { fail(err); }
      return;
    }
    case 'signout': await flushNow(); await CLOUD.signOut(); return toast('Signed out');
    case 'connect': if (await ready()) { toast(`${CLOUD.mailName(CLOUD.provider())} and ${CLOUD.calName(CLOUD.provider())} connected`); accountDrawer(); } return;
    case 'delAccount': if (sure('Delete my account for good')) { try { await CLOUD.api('DELETE', '/api/me'); await CLOUD.signOut(); lsDel(LAST); toast('Your account was deleted'); } catch (err) { fail(err); } } return;
    case 'joinNow': return acceptJoin();
    case 'moveLocal': closeDrawer(); return moveLocalToAccount();
    case 'delCamp': if (sure(S.cloud && ROLE !== 'owner' ? 'Leave this campaign' : 'Delete this campaign, its roster and its history')) { closeDrawer(); await deleteCampaign(); toast(S.cloud && ROLE !== 'owner' ? 'You left the campaign' : 'Campaign deleted'); } return;
    case 'mkInvite': {
      try {
        const r = await CLOUD.api('POST', `/api/campaigns/${encodeURIComponent(S.id)}/invites`, { role: $('#inv_role').value });
        const link = `${location.origin}/join/${r.code}`;
        $('#invOut').innerHTML = `<p class="note" id="inv_for">Link for ${r.role === 'editor' ? 'an editor' : 'a viewer'}, valid for 14 days:</p><div class="linkbox"><input id="inv_link" readonly value="${esc(link)}" aria-label="Invite link"><button class="btn sm" data-copy="${esc(link)}">Copy</button></div>`;
      } catch (err) { fail(err); }
      return;
    }
    case 'revokeInvites': if (sure('Turn off every link')) { try { await CLOUD.api('DELETE', `/api/campaigns/${encodeURIComponent(S.id)}/invites`); toast('Invite links turned off'); } catch (err) { fail(err); } } return;
    case 'rmPerson': if (sure('Confirm remove')) { try { await CLOUD.api('DELETE', `/api/campaigns/${encodeURIComponent(S.id)}/people/${encodeURIComponent(t.dataset.uid)}`); toast('Removed from the campaign'); loadTeam(); } catch (err) { fail(err); } } return;
    case 'addMember': { if (!canEditNow()) return toast('You have view-only access to this campaign.'); const n = { id: uid(), name: '', party: 'D', district: '', cmte: false, pos: 2, mov: 3, follows: '', interests: '', notes: '', history: [], staffers: [], draft: true }; S.members.push(n); memberDrawer(n.id); const f = $('#m_name'); if (f) f.focus(); return; }
    case 'askRemove': $('#rmAsk').hidden = false; return;
    case 'remove': { const id = openId; S.members = S.members.filter((x) => x.id !== id); S.members.forEach((x) => { if (x.follows === id) x.follows = ''; }); S.tasks = S.tasks.filter((x) => x.mid !== id); S.meetings = S.meetings.filter((x) => x.mid !== id); closeDrawer(); return commit('Member removed'); }
    case 'brief': tab = 'act'; schedOpen = false; outKind = 'brief'; return memberDrawer(openId);
    case 'hideOut': outKind = null; return memberDrawer(openId);
    case 'copyOut': return copyText($('#outText').value, $('#outText'));
    case 'rq': tab = 'act'; outKind = null; schedOpen = true; if (m) rqStart(m, { sid: t.dataset.sid }); return memberDrawer(openId);
    case 'rqClose': schedOpen = false; RQ = null; return memberDrawer(openId);
    case 'rqCopy': rqRead(); return copyText(`Subject: ${RQ.subject}\n\n${RQ.body}`, $('#rq_body'));
    case 'rqFind': rqRead(); if (await ready()) await findTimes(m); return;
    case 'rqMailto': {
      rqRead(); if (!rqCheckTo()) return;
      const how = openMail(t.dataset.mailer || 'app', { to: RQ.to, subject: RQ.subject, body: RQ.body });
      RQ.sentVia = 'email app';
      rqMsg(''); $('#rqMsg').innerHTML = `${mailOpenedNote(how)}Once you have sent it: <button type="button" class="btn sm primary" data-act="rqLogged">Log the request</button>`;
      return;
    }
    case 'rqLogged': rqRead(); return recordRequest(m, 'email app');
    case 'rqSend': {
      rqRead(); if (!rqCheckTo()) return;
      if (!RQ.subject.trim() || !RQ.body.trim()) return rqMsg('Add a subject and a message.');
      if (!(await ready())) return;
      t.disabled = true; rqMsg('Sending');
      try { await CLOUD.mail.send({ to: [RQ.to], subject: RQ.subject, body: RQ.body }); } catch (err) { t.disabled = false; return rqMsg(err.message); }
      return recordRequest(m, CLOUD.mailName(CLOUD.provider()));
    }
    case 'rqCalLink': {
      rqRead(); if (!rqCheckTo()) return;
      const start = new Date(RQ.start), end = new Date(start.getTime() + RQ.mins * 60000);
      if (Number.isNaN(start.getTime())) return rqMsg('Pick a date and time.');
      if (start.getTime() < Date.now()) return rqMsg('Pick a time in the future.');
      const st = rqStaffer(m), cal = t.dataset.cal === 'outlook' ? 'outlook' : 'google';
      window.open(CLOUD.calendarLink(cal, { title: meetingTitle(m, st), description: inviteText(m), start, end, location: RQ.where, attendees: [RQ.to] }), '_blank', 'noopener');
      return recordInvite(m, null, cal === 'outlook' ? 'outlook-web' : 'gcal-web');
    }
    case 'rqInvite': case 'rqIcs': {
      rqRead(); if (!rqCheckTo()) return;
      const start = new Date(RQ.start), end = new Date(start.getTime() + RQ.mins * 60000);
      if (Number.isNaN(start.getTime())) return rqMsg('Pick a date and time.');
      if (start.getTime() < Date.now()) return rqMsg('Pick a time in the future.');
      const st = rqStaffer(m), details = { title: meetingTitle(m, st), description: inviteText(m), start, end, location: RQ.where, attendees: [RQ.to] };
      if (a === 'rqIcs') { download(`meeting-${today()}.ics`, CLOUD.ics({ uid: uid(), ...details, organizer: CLOUD.user && CLOUD.user.email }), 'text/calendar'); return recordInvite(m, null, 'ics'); }
      if (!(await ready())) return;
      t.disabled = true; rqMsg('Sending the invitation');
      let ev;
      try { ev = await CLOUD.calendar.create({ ...details, video: RQ.video }); } catch (err) { t.disabled = false; return rqMsg(err.message); }
      return recordInvite(m, ev, CLOUD.provider());
    }
    case 'bookTime': {
      const mt = S.meetings.find((x) => x.id === t.dataset.id), mm = mt && S.members.find((x) => x.id === mt.mid); if (!mm) return;
      openId = null; memberDrawer(mm.id); schedOpen = true; outKind = null;
      rqStart(mm, { mode: 'invite', to: mt.to[0], mins: mt.mins, start: (mt.proposed || []).find((x) => new Date(x) > new Date()) || '', meetingId: mt.id });
      return memberDrawer(mm.id);
    }
    case 'checkReplies': if (await ready()) await checkReplies(); return;
    case 'logMeet': {
      const mt = S.meetings.find((x) => x.id === t.dataset.id); if (!mt) return;
      mt.status = 'held'; save(); render(); openId = null; memberDrawer(mt.mid); tab = 'act'; memberDrawer(mt.mid);
      const st = (S.members.find((x) => x.id === mt.mid) || { staffers: [] }).staffers.find((s) => s.name === mt.who);
      if ($('#c_d')) { $('#c_d').value = iso(new Date(mt.start)); $('#c_type').value = 'Meeting'; if (st) $('#c_who').value = st.id; $('#logHead').scrollIntoView({ block: 'start' }); $('#c_note').focus(); }
      return;
    }
    case 'cancelMeet': {
      const mt = S.meetings.find((x) => x.id === t.dataset.id); if (!mt) return;
      const onCal = mt.status === 'invited' && mt.eventId && mine(mt) && !ended(mt);
      if (onCal && !sure(`Cancel it and tell ${mt.who || mt.to[0]}`)) return;
      if (onCal) { if (!signedIn()) return toast('Sign in to cancel the calendar event.'); if (!(await ready())) return; try { await CLOUD.calendar.cancel(mt.eventId); } catch (err) { return fail(err); } }
      mt.status = mt.status === 'requested' ? 'withdrawn' : ended(mt) ? 'held' : 'cancelled';
      save(); render(); if (openId && !$('#drawer').hidden) memberDrawer(openId);
      return toast(onCal ? 'Meeting cancelled and the invitation withdrawn' : mt.status === 'withdrawn' ? 'Request withdrawn' : 'Removed from the agenda');
    }
    case 'addStaff': tab = 'staff'; staffEdit = 'new'; memberDrawer(openId); { const f = $('#st_name'); if (f) f.focus(); } return;
    case 'editStaff': staffEdit = t.dataset.sid; memberDrawer(openId); { const f = $('#st_name'); if (f) f.focus(); } return;
    case 'cancelStaff': staffEdit = null; return memberDrawer(openId);
    case 'logStaff': tab = 'act'; schedOpen = false; outKind = null; memberDrawer(openId); if ($('#c_who')) { $('#c_who').value = t.dataset.sid; $('#logHead').scrollIntoView({ block: 'start' }); $('#c_note').focus(); } return;
    case 'fromRecord': $('#moreMenu').open = false; await fillFromRecord(); return;
    case 'slRemove': if (sure('Click again to remove')) { try { await CLOUD.api('DELETE', wsPath('/staff-list')); ORG_STAFF.list = null; renderWorkspace(true); toast('Staff list removed'); } catch (e) { fail(e); } } return;
    case 'rmStaff': if (m && sure('Confirm remove')) { const gone = m.staffers.find((s) => s.id === t.dataset.sid); if (gone && gone.src === 'directory') m.dirGone = [...(m.dirGone || []), nameKey(gone.name)].slice(-40); m.staffers = m.staffers.filter((s) => s.id !== t.dataset.sid); save(); toast('Staff member removed'); memberDrawer(openId); renderRows(); } return;
    case 'saveRep': return download(`headcount-${repKind}-${today()}.${REPORTS[repKind][1]}`, reportText(), repKind === 'client' ? 'text/plain' : 'text/csv');
    case 'briefEdit': briefEdit = true; briefPanel = ''; return renderBrief();
    case 'briefCancel': briefEdit = false; return renderBrief();
    case 'briefLookup': briefPanel = 'lookup'; renderBrief(); { const f = $('#lk_n'); if (f) f.focus(); } return;
    case 'briefDraft': briefPanel = 'draft'; renderBrief(); { const f = $('#df_text'); if (f) f.focus(); } return;
    case 'briefPanelOff': briefPanel = ''; return renderBrief();
    case 'briefCopy': return copyText(briefPlain(S.brief));
    case 'briefPrint': return window.print();
    case 'storyAgain': STORY.err = ''; loadStory(true); return;
    case 'editMyName': { const dd = $('#myName').parentElement; dd.innerHTML = `<form id="myNameForm" class="taskadd"><input name="name" value="${esc(CLOUD.user.name || '')}" aria-label="Your name" required maxlength="80"><button class="btn sm primary">Save</button></form>`; dd.querySelector('input').focus(); return; }
    case 'renameCamp': { setupDrawer(); const f = $('#s_bill'); if (f) { f.focus(); f.select(); } return; }
    case 'renamePerson': { const h = $('#personName'); if (!h) return; h.outerHTML = `<form id="personNameForm" class="taskadd" data-key="${esc(t.dataset.key)}"><input name="name" value="${esc(t.dataset.name)}" aria-label="Legislator's name" required maxlength="80"><button class="btn sm primary">Save everywhere</button></form>`; $('#personNameForm input').focus(); return; }
    case 'fsPick': return fastCreate(`${t.dataset.n}: ${clipWords(t.dataset.title, 100)}`, t.dataset.leg, t.dataset.s);
    case 'feedback': { const m = $('#helpMenu'); if (m) m.open = false; return feedbackDrawer(); }
    case 'simSearch': return similarSearch();
    case 'simFollow': try { const r = await CLOUD.api('POST', wsPath('/bills'), { juris: t.dataset.leg, number: t.dataset.n, session: t.dataset.s, title: t.dataset.title, position: 'watch' }); t.textContent = 'Following'; t.disabled = true; BILLS.at = 0; toast(`Following ${r.number} on the Bills page`); } catch (err) { fail(err); } return;
    case 'tbAdd': BILLS.adding = true; renderBills(); { const n = $('#tb_num'); if (n) n.focus(); } return;
    case 'tbCancel': BILLS.adding = false; return renderBills();
    case 'tbSearchToggle': { const box = $('#tbSearch'); box.hidden = !box.hidden; if (!box.hidden) $('#tbs_q').focus(); return; }
    case 'tbSearch': return billListSearch();
    case 'tbPick': $('#tb_num').value = t.dataset.n; $('#tb_title').value = t.dataset.title || ''; $('#tb_session').value = t.dataset.s || ''; $('#tbSearch').hidden = true; $('#tbMsg').textContent = `${t.dataset.n} chosen.`; return;
    case 'tbShare': BILLS.sharing = true; renderBills(); { const sp = document.querySelector('.shares'); if (sp) sp.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return;
    case 'tbShareMake': try { const r = await CLOUD.api('POST', wsPath('/bill-shares'), { clientId: ($('#sh_client') || {}).value || '' }); BILLS.shares = [r, ...BILLS.shares]; renderBills(); copyText(r.url); toast('Link created and copied'); } catch (err) { fail(err); } return;
    case 'tbShareOff': if (sure('Turn off this link')) { try { await CLOUD.api('DELETE', wsPath(`/bill-shares/${t.dataset.token}`)); BILLS.shares = BILLS.shares.filter((x) => x.token !== t.dataset.token); renderBills(); toast('The link no longer works'); } catch (err) { fail(err); } } return;
    case 'tbCopy': copyText(t.dataset.v); toast('Copied'); return;
    case 'tbRemove': if (sure('Stop following this bill')) { try { await CLOUD.api('DELETE', wsPath(`/bills/${t.dataset.id}`)); BILLS.bills = BILLS.bills.filter((x) => x.id !== t.dataset.id); closeDrawer(); renderBills(); toast('No longer following it'); } catch (err) { fail(err); } } return;
    case 'tbCount': { const b = (BILLS.bills || []).find((x) => x.id === t.dataset.id); if (!b) return; closeDrawer(); await campaignFromItem({ id: '', number: b.number, juris: b.juris, session: b.session, title: b.title, clientId: b.clientId }); loadBills(true); return; }
    case 'nSearchToggle': { const box = $('#nSearch'); box.hidden = !box.hidden; if (!box.hidden) $('#ns_q').focus(); return; }
    case 'nSearch': return billSearch();
    case 'nPick': {
      $('#n_bill').value = `${t.dataset.n}: ${clipWords(t.dataset.title, 100)}`; const leg = $('#n_leg'); if (leg && [...leg.options].some((o) => o.value === t.dataset.leg)) leg.value = t.dataset.leg;
      const f = $('#nForm'); f.dataset.session = t.dataset.s || ''; const ch = $('#n_from'); if (ch) delete ch.dataset.user;
      nChamberSync(true); $('#nSearch').hidden = true; $('#nMsg').textContent = `${t.dataset.n} chosen. Check the chamber, then create the campaign.`; return;
    }
    case 'glossary': { const m = $('#helpMenu'); if (m) m.open = false; return glossaryDrawer(t.dataset.term || ''); }
    case 'pickChamber': {
      const v = t.dataset.v, label = t.dataset.label || t.textContent.trim(); if (!v) return;
      if (S.members.length && !S.example && !sure(`Replace the current roster with the ${label}`)) return;
      t.disabled = true; const msg = $('#q_msg') || $('#s_chMsg'); if (msg) msg.textContent = `Loading the ${label}`;
      try { const label = await fillChamber(v); closeDrawer(); commit(`${label} loaded`); if (recordReady()) fillFromRecord({ auto: true }); }
      catch (e) { t.disabled = false; if (msg) msg.textContent = e.message; else fail(e); }
      return;
    }
    case 'preset': {
      const key = $('#s_preset').value, ci = $('#s_cmte') ? +$('#s_cmte').value : -1, backed = $('#s_backed').value;
      if (S.members.length && !S.example && !sure(`Replace the current roster with ${ROSTERS[key].label}`)) return;
      await staffFor(key);
      loadPreset(key, ci, backed); closeDrawer(); return commit(`${ROSTERS[key].label} loaded`);
    }
    case 'bulk': {
      const party = $('#b_party').value, to = +$('#b_pos').value; let n = 0;
      S.members.forEach((x) => { if (x.party === party && x.pos !== to) { x.pos = to; delete x.posFrom; n++; } });
      closeDrawer(); return commit(`${n} member${n === 1 ? '' : 's'} set to ${POS[to]}`);
    }
    case 'import': {
      const rows = parseRoster($('#s_csv').value);
      if (!rows.length) { $('#impMsg').textContent = 'Nothing to import. Paste at least one line with a name.'; return; }
      if (!sure(`Replace with these ${rows.length} members`)) return;
      S.members = rows; S.plan = []; S.trend = []; S.tasks = S.tasks.filter((x) => !x.mid); S.meetings = []; delete S.preset; closeDrawer(); return commit(`${rows.length} members loaded`);
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('seat')) { e.preventDefault(); memberDrawer(e.target.dataset.open); }
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.opencamp && e.target.tagName === 'TR') { page = 'count'; cloudOpen(e.target.dataset.opencamp); }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'campSel') return switchTo(t.value);
  if (t.id === 'sec_2fa') return setRequire2fa(t);
  if (t.id === 'orgSel') { if (t.value === '__new') { t.value = ORG ? ORG.id : ''; return newOrgDrawer(); } return switchOrg(t.value); }
  if (t.dataset.orgrole) { try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/members/${encodeURIComponent(t.dataset.orgrole)}`, { role: t.value }); toast('Role changed'); } catch (err) { fail(err); } WS.members = null; await loadOrg(ORG.id, { quiet: true }); return render(); }
  if (t.id === 'pf_client') { WS.filter.client = t.value; return renderPortfolio(); }
  if (['pf_digest', 'pf_hour', 'pf_assigned', 'pf_added', 'pf_monitor'].includes(t.id)) {
    const patch = { pf_digest: { digest: t.value }, pf_monitor: { monitor: t.value }, pf_hour: { digestHour: +t.value }, pf_assigned: { notifyAssigned: t.checked }, pf_added: { notifyAdded: t.checked } }[t.id];
    try { PREFS = await CLOUD.api('PATCH', '/api/me/prefs', patch); toast('Email settings saved'); } catch (err) { fail(err); }
    return;
  }
  if (t.id === 'pf_arch') { WS.filter.archived = t.checked; return renderPortfolio(); }
  if (t.id === 'dm_join') { try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/domain`, { join: t.checked }); await loadOrg(ORG.id); toast(t.checked ? 'Colleagues can now join from their work email' : 'Joining by email domain is off'); } catch (err) { fail(err); } return render(); }
  if (t.id === 'camp_vis') { try { await CLOUD.api('PATCH', `/api/campaigns/${encodeURIComponent(S.id)}`, { visibility: t.value }); await refreshAccount(); toast(t.value === 'team' ? 'Only the people listed can see it now' : `Everyone in ${ORG.name} can see it now`); render(); } catch (err) { fail(err); } return; }
  if (t.id === 's_clientId' && t.value === '__new') {
    const name = window.prompt('Client name');
    if (!name) { t.value = S.campaign.clientId || ''; return; }
    try { const k = await CLOUD.api('POST', `/api/workspaces/${ORG.id}/clients`, { name }); await reloadClients(); t.insertAdjacentHTML('afterbegin', ''); const o = document.createElement('option'); o.value = k.id; o.textContent = k.name; t.insertBefore(o, t.lastElementChild); t.value = k.id; } catch (err) { t.value = S.campaign.clientId || ''; fail(err); }
    return;
  }
  if (t.dataset.role) { try { await CLOUD.api('PATCH', `/api/campaigns/${encodeURIComponent(S.id)}/people/${encodeURIComponent(t.dataset.role)}`, { role: t.value }); toast('Role changed'); } catch (err) { fail(err); loadTeam(); } return; }
  if (t.id && t.id.startsWith('rq_') && RQ) {
    const m = S.members.find((x) => x.id === openId);
    if (t.id === 'rq_to') { rqRead(); rqRefreshText(m); return memberDrawer(openId); }
    rqRead(); if (['rq_other', 'rq_mins', 'rq_t0', 'rq_t1', 'rq_t2'].includes(t.id)) { rqRefreshText(m); rqTextOut(); }
    return;
  }
  if (t.dataset.pos) {
    const m = S.members.find((x) => x.id === t.dataset.pos), to = +t.value;
    if (m && m.pos !== to) { m.history.push(stamp({ d: today(), type: 'Count update', from: m.pos, to, note: '' })); m.pos = to; delete m.posFrom; commit(`${m.name}: ${POS[to]}`); if (openId === m.id && !$('#drawer').hidden) memberDrawer(m.id); }
  } else if (t.dataset.plan) {
    S.plan = t.checked ? S.plan.concat(t.dataset.plan) : S.plan.filter((x) => x !== t.dataset.plan);
    const nd = needs(S); renderCalls(nd, passage(S.members, baseProbs(S), nd));
  } else if (t.dataset.task) {
    const k = S.tasks.find((x) => x.id === t.dataset.task); if (!k) return;
    k.done = t.checked; save(); render(); toast(k.done ? 'Marked done' : 'Reopened');
    if (openId && !$('#drawer').hidden && S.members.some((x) => x.id === openId)) memberDrawer(openId);
  } else if (t.id === 'fGroup') renderRows();
  else if (t.id === 's_preset') presetNote();
  else if (t.id === 'rep_from') $('#outText').value = reportText();
});
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'q') renderRows();
  else if (id === 'pf_q') { WS.filter.q = e.target.value; renderPortfolio(); const el = $('#pf_q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  else if (id === 'sd_q') staffDirList();
  else if ((id === 'rq_body' || id === 'rq_subject') && RQ) { RQ.edited = true; rqRead(); }
  else if (id === 'n_bill') nChamberSync();
  else if (id === 'gl_q') glossaryFilter();
  else if (id === 'pp_q') { PEOPLE_PAGE.f.q = e.target.value; renderPeople(); const el = $('#pp_q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  else if (id === 'bl_q') { BILLS.f.q = e.target.value; renderBills(); const el = $('#bl_q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.id === 'ns_q') { e.preventDefault(); billSearch(); }
  if (e.key === 'Enter' && e.target && e.target.id === 'tbs_q') { e.preventDefault(); billListSearch(); }
  if (e.key === 'Enter' && e.target && e.target.id === 'sim_q') { e.preventDefault(); similarSearch(); }
  if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('tr[data-bill]')) billDrawer(e.target.dataset.bill);
  if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('tr[data-person]')) personDrawer(e.target.dataset.person);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest || e.target.closest('a,button,select,input')) return;
  const r = e.target.closest('tr[data-bill]'); if (r) return billDrawer(r.dataset.bill);
  const pr = e.target.closest('tr[data-person]'); if (pr) personDrawer(pr.dataset.person);
});
document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'n_leg') { const f = $('#n_from'); if (f) delete f.dataset.user; nChamberSync(true); }
  else if (id === 'pp_show' || id === 'pp_sort') { PEOPLE_PAGE.f[id === 'pp_show' ? 'show' : 'sort'] = e.target.value; renderPeople(); }
  else if (['bl_pos', 'bl_leg', 'bl_client', 'bl_sort'].includes(id)) { BILLS.f[{ bl_pos: 'pos', bl_leg: 'leg', bl_client: 'client', bl_sort: 'sort' }[id]] = e.target.value; renderBills(); }
  else if (id === 'n_from') e.target.dataset.user = '1';
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target), id = e.target.id, cut = (k, n) => String(fd.get(k) || '').trim().slice(0, n);
  const m = S.members.find((x) => x.id === openId);
  if (id === 'oiForm') return sendOrgInvite(e.target);
  if (id === 'locForm') return submitLocal(e.target);
  if (/^tf(On|Off|Rec)Form$/.test(id)) return twoFactorForm(id);
  if (id === 'pwForm') {
    try { await CLOUD.changePassword($('#pw_cur').value, $('#pw_new').value); toast('Password changed. Other devices are signed out.'); accountDrawer(); } catch (err) { $('#pwMsg').textContent = err.message; }
    return;
  }
  if (id === 'ssoForm') {
    const email = cut('email', 160);
    try { const r = await CLOUD.publicGet(`/api/sso/lookup?email=${encodeURIComponent(email)}`); SSO_STEP = { email, provider: r.provider, workspace: r.workspace }; signInDrawer('sso'); }
    catch (err) { SSO_STEP = null; $('#ssoNext').textContent = err.message; }
    return;
  }
  if (id === 'ssForm') {
    try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/sso`, { provider: cut('provider', 70), required: fd.has('required') }); await loadOrg(ORG.id); render(); toast('Single sign-on saved'); } catch (err) { fail(err); }
    return;
  }
  if (id === 'woForm' || id === 'noForm') { closeDrawer(); return createOrg(cut('name', 80)); }
  if (id === 'rpForm') return runReport(e.target);
  if (id === 'ckForm') { try { await CLOUD.api('POST', `/api/workspaces/${ORG.id}/clients`, { name: cut('name', 120) }); await reloadClients(); renderWorkspace(true); toast('Client added'); } catch (err) { fail(err); } return; }
  if (id === 'dmForm') { try { await CLOUD.api('POST', `/api/workspaces/${ORG.id}/domain`, { domain: cut('domain', 253) }); await loadOrg(ORG.id); renderWorkspace(true); } catch (err) { fail(err); } return; }
  if (id === 'wnForm') { try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}`, { name: cut('name', 80) }); ORGS = (await CLOUD.api('GET', '/api/workspaces')).workspaces; await loadOrg(ORG.id); render(); toast('Workspace renamed'); } catch (err) { fail(err); } return; }
  if (id === 'lkForm') return lookupBill(e.target);
  if (id === 'dfForm') return draftAnalysis(e.target);
  if (id === 'bfForm') return saveBriefForm(e.target);
  if (id === 'tForm') {
    S.tasks.push(stamp({ id: uid(), text: cut('text', 200), due: fd.get('due') || '', mid: '', done: false, assignee: S.cloud ? String(fd.get('for') || '') : '' }));
    if (S.tasks.length > 300) S.tasks = S.tasks.slice(-300);
    e.target.reset(); save(); render(); return toast('Follow-up added');
  }
  if (id === 'fsForm') {
    const q = $('#fs_bill').value.trim(), leg = $('#fs_leg').value;
    try { localStorage.setItem('headcount.leg', leg); } catch (_) { /* fine */ }
    if (!q) return;
    if (looksLikeNumber(q)) return fastCreate(q, leg);
    const cfg = CLOUD.config || {};
    if (cfg.bills && cfg.bills.states) return fastSearch(q, leg);
    return fastCreate(q, leg);
  }
  if (id === 'myNameForm') {
    const name = String(fd.get('name') || '').trim().slice(0, 80);
    try { await CLOUD.api('PATCH', '/api/me', { name }); CLOUD.user.name = name; accountDrawer(); render(); toast('Name changed'); } catch (err) { fail(err); }
    return;
  }
  if (id === 'personNameForm') {
    const name = String(fd.get('name') || '').trim(), key = e.target.dataset.key;
    try { const r = await CLOUD.api('PATCH', wsPath(`/legislators/${encodeURIComponent(key)}`), { name }); toast(`Renamed in ${r.changed} place${r.changed === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} campaign${r.skipped === 1 ? '' : 's'} you can only view were left as they were` : ''}`); PEOPLE_PAGE.at = 0; await loadPeople2(true); personDrawer(key); if (S.cloud) cloudOpen(S.id); }
    catch (err) { fail(err); }
    return;
  }
  if (id === 'fbForm') {
    try { await CLOUD.api('POST', '/api/feedback', { message: fd.get('message'), page }); showDrawer('<div class="row"><h2>Thank you</h2><button class="btn sm" data-act="close">Close</button></div><p>Your note went straight to the people who build Headcount. If you left a question, the answer comes by email.</p>'); }
    catch (err) { $('#fbMsg').textContent = err.message; }
    return;
  }
  if (id === 'tbForm') {
    const msg = $('#tbMsg'), body = Object.fromEntries(fd.entries());
    try { localStorage.setItem('headcount.leg', body.juris); } catch (_) { /* fine */ }
    msg.textContent = 'Adding it';
    try { const r = await CLOUD.api('POST', wsPath('/bills'), body); BILLS.bills = [r, ...BILLS.bills.filter((x) => x.id !== r.id)]; BILLS.adding = false; renderBills(); toast(`Following ${r.number}`); setTimeout(() => loadBills(true), 4000); }
    catch (err) { msg.textContent = err.message; }
    return;
  }
  if (id === 'tbEdit') {
    try { const r = await CLOUD.api('PATCH', wsPath(`/bills/${e.target.dataset.id}`), Object.fromEntries(fd.entries())); BILLS.bills = BILLS.bills.map((x) => (x.id === r.id ? r : x)); closeDrawer(); renderBills(); toast('Saved'); }
    catch (err) { fail(err); }
    return;
  }
  if (id === 'nForm') {
    const st = blankState(clipWords(fd.get('bill'), 140)); st.campaign.side = fd.get('side');
    if (fd.get('clientId')) { st.campaign.clientId = fd.get('clientId'); st.campaign.client = (CLIENTS.find((k) => k.id === st.campaign.clientId) || {}).name || ''; }
    if (fd.get('vis')) st.visibility = fd.get('vis');
    const leg = String(fd.get('leg') || ''), from = String(fd.get('from') || '');
    if (!leg) { $('#nMsg').textContent = 'Choose the legislature, or "Something else" to add the members yourself.'; return; }
    if (!from) { $('#nMsg').textContent = 'Choose the chamber you are counting.'; return; }
    if (e.target.dataset.session) st.brief.session = e.target.dataset.session.slice(0, 40);
    if (!['copy', 'blank'].includes(leg)) { st.campaign.leg = leg; try { localStorage.setItem('headcount.leg', leg); } catch (_) { /* fine */ } }
    let pick = from;
    if (/^[ps]:/.test(from)) {
      const btn = e.target.querySelector('button.primary'); btn.disabled = true; $('#nMsg').textContent = 'Loading the members';
      // A bill that has crossed to the other chamber is counted there, unless the person picked the chamber themselves.
      const choose = $('#n_from'), number = billNumberOf(st), cfg = CLOUD.config || {};
      if (choose && choose.dataset.user !== '1' && number && signedIn() && cfg.bills && (leg === 'US' ? cfg.bills.federal : cfg.bills.states)) {
        try {
          const r = await Promise.race([CLOUD.api('GET', `/api/bills/story?${new URLSearchParams({ jurisdiction: leg, number })}`), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 6000))]);
          const now = r && r.stage && ['filed', 'committee-wait', 'committee', 'floor', 'crossed'].includes(r.stage.where) && r.stage.chamber, c = now && legChoices(leg).find((x) => x.chamber === now);
          if (c) pick = c.value;
        } catch (_) { /* the bill number decides */ }
      }
      try { await fillChamber(pick, st); } catch (err) { btn.disabled = false; $('#nMsg').textContent = err.message; return; }
    }
    if (from === 'copy') {
      Object.assign(st.campaign, { chamber: S.campaign.chamber, rule: S.campaign.rule, me: S.campaign.me }, st.campaign.clientId ? {} : { client: S.campaign.client, clientId: S.campaign.clientId || '' });
      if (S.preset) st.preset = plain(S.preset);
      st.members = plain(S.members).filter((x) => !x.draft).map((x) => Object.assign(x, { pos: 2, cmte: false, role: '', history: [] }));
    }
    closeDrawer(); page = 'count'; await addCampaign(st);
    toast(st.members.length ? `Campaign created with ${st.members.length} members` : 'Campaign created. Add members with Edit campaign.');
    if (st.members.length && recordReady()) { RECORD_CHECK = S.id; fillFromRecord({ auto: true }).finally(() => { RECORD_CHECK = ''; }); }
    return;
  }
  if (id === 'sForm') {
    const was = S.campaign.side;
    Object.assign(S.campaign, { bill: cut('bill', 140), chamber: cut('chamber', 80), committee: cut('committee', 80), rule: fd.get('rule'), side: fd.get('side'), ask: cut('ask', 240), me: cut('me', 80), cmteDate: fd.get('cmteDate') || '', floorDate: fd.get('floorDate') || '' });
    if (S.cloud) { const k = fd.get('clientId'); S.campaign.clientId = k && k !== '__new' ? k : ''; S.campaign.client = clientOf(); } else S.campaign.client = cut('client', 80);
    if (was !== S.campaign.side) { S.trend.forEach((x) => { x.p = 1 - x.p; }); S.plan = []; }
    closeDrawer(); return commit('Setup saved');
  }
  if (!m) return;
  if (id === 'stForm') {
    const sid = e.target.dataset.sid;
    const rec = { id: sid || uid(), name: cut('name', 80), role: cut('role', 60), phone: cut('phone', 40), email: cut('email', 120), notes: cut('notes', 300) };
    const i = m.staffers.findIndex((s) => s.id === sid);
    if (i >= 0) m.staffers[i] = rec; else m.staffers.push(rec);
    staffEdit = null; save(); toast('Staff member saved'); renderRows(); return memberDrawer(openId);
  }
  if (id === 'mForm') {
    const to = +fd.get('pos');
    if (!m.draft && to !== m.pos) m.history.push(stamp({ d: today(), type: 'Count update', from: m.pos, to, note: '' }));
    Object.assign(m, { name: cut('name', 80), party: fd.get('party'), district: cut('district', 12), pos: to, mov: +fd.get('mov'), follows: fd.get('follows'), interests: cut('interests', 120), cmte: fd.has('cmte'), role: fd.has('cmte') ? cut('role', 40) : '', phone: cut('phone', 40), email: cut('email', 120), notes: cut('notes', 2000) });
    delete m.draft; closeDrawer(); return commit('Member saved');
  }
  if (id === 'cForm') {
    track('contact_logged');
    const to = +fd.get('pos'), st = m.staffers.find((s) => s.id === fd.get('who'));
    m.history.push(stamp({ d: fd.get('d') || today(), type: fd.get('type'), who: st ? st.name : '', from: m.pos, to, note: cut('note', 1000) }));
    if (m.history.length > 60) m.history = m.history.slice(-60);
    if (cut('fu', 200)) S.tasks.push(stamp({ id: uid(), text: cut('fu', 200), due: fd.get('fud') || '', mid: m.id, done: false, assignee: S.cloud ? String(fd.get('fufor') || '') : '' }));
    m.pos = to; delete m.posFrom; commit('Contact logged'); tab = 'history'; return memberDrawer(m.id);
  }
});

// ---------- start ----------
(async function boot() {
  if (!loadLocal()) goExample();
  const jm = /^\/(join|invite)\/([A-Za-z0-9_-]{8,64})$/.exec(location.pathname); if (jm) JOIN = { code: jm[2], kind: jm[1] === 'invite' ? 'org' : 'campaign' };
  const billing = new URLSearchParams(location.search).get('billing');
  render(); loadRosters();
  await CLOUD.init(); CLOUD.onChange(onAuthChange);
  if (JOIN) { try { JOIN.info = await CLOUD.publicGet(JOIN.kind === 'org' ? `/api/workspace-invites/${JOIN.code}` : `/api/invites/${JOIN.code}`); } catch (e) { JOIN.error = e.message; } }
  if (CLOUD.user) await onSignedIn(); else render();
  const rm = /^#reset=([A-Za-z0-9_-]{20,80})$/.exec(location.hash);
  if (rm && CLOUD.config.auth === 'local') { LOC.reset = rm[1]; localSignInDrawer('reset'); }
  else if (!CLOUD.user && CLOUD.config.auth === 'local' && CLOUD.config.accounts && CLOUD.config.accounts.setup) localSignInDrawer('signup');
  if (billing) {
    history.replaceState(null, '', '/app');
    if (billing === 'done') { toast('Thank you. Your plan will update in a few seconds.'); page = 'workspace'; render(); setTimeout(() => { if (ORG) loadOrg(ORG.id, { quiet: true }).then(render); }, 4000); }
    else if (billing === 'back' && ORG) { page = 'workspace'; await loadOrg(ORG.id, { quiet: true }); render(); }
  }
})();

document.addEventListener('change', (e) => { if (e.target && e.target.id === 'sl_file') { uploadStaffList(e.target.files[0]); e.target.value = ''; } });
