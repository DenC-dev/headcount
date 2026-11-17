'use strict';
// Headcount: whip counts, meeting requests and bill briefs. Plain browser JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POS = ['No', 'Lean no', 'Undecided', 'Lean yes', 'Yes'];
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
  const r = (m.ref && DIR[m.ref]) || {};
  return { phone: m.phone || r.ph || '', email: m.email || r.em || '', office: r.of || '', dphone: r.dph || '', doffice: r.dof || '', url: r.url || '', form: r.cf || '' };
}
function loadPreset(key, cmteIdx, backed) {
  const p = ROSTERS[key], cm = p.committees[cmteIdx], on = new Set(cm ? cm.m : []), titles = (cm && cm.t) || {};
  const start = (party) => (!backed ? 2 : party === backed ? 3 : party === 'I' ? 2 : 1);
  S.members = p.members.map((m) => ({ id: 'p' + m.k, ref: m.k, name: m.n, party: m.p, district: m.d, cmte: on.has(m.k), role: titles[m.k] || '', pos: start(m.p), mov: 3, follows: '', interests: '', notes: '', history: [], staffers: [] }));
  Object.assign(S.campaign, { chamber: p.chamber, committee: cm ? cm.name : '', rule: 'majority' });
  if (S.example) S.campaign.bill = 'Your bill';
  S.preset = { label: p.label, asOf: p.asOf, stale: !!p.stale, vacant: p.seats - p.members.length };
  S.plan = []; S.trend = []; S.tasks = S.tasks.filter((t) => !t.mid); S.meetings = []; S.brief = blankBrief();
}

// ---------- workspace: campaigns in this browser, or in your account ----------
let S = exampleState();
let view = 'floor', page = 'count', openId = null, renderTimer = null;
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
    ME = null; ACCOUNT.list = []; ACCOUNT.loaded = false; PEOPLE = {}; ORGS = []; ORG = null; CLIENTS = []; DOMAIN_MATCHES = []; PREFS = null;
    WS.members = WS.invites = WS.audit = WS.report = WS.lastInvite = null;
    if (S.cloud) { stopPoll(); SYNC = newSync(null); if (!loadLocal()) goExample(); }
    if (page === 'portfolio' || page === 'workspace') page = 'count';
    closeDrawer(); render();
  }
}
async function onSignedIn() {
  try { const r = await CLOUD.api('GET', '/api/me'); ME = r.user.id; ORGS = r.workspaces; DOMAIN_MATCHES = r.domainMatches || []; PREFS = r.prefs; }
  catch (e) { fail(e); return render(); }
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })();
  if (tz && PREFS && PREFS.tz !== tz) CLOUD.api('PATCH', '/api/me/prefs', { tz }).then((x) => { PREFS = x; }).catch(() => {});
  if (location.hash === '#email') setTimeout(() => accountDrawer(true), 0);
  if (JOIN && JOIN.info) return acceptJoin();
  const blocked = ORGS.filter((o) => o.ssoRequired), open = ORGS.filter((o) => !o.ssoRequired);
  SSO_NEEDED = blocked.length ? blocked.map((o) => o.name).join(' and ') : null;
  const want = lsGet(LASTORG), oid = open.some((o) => o.id === want) ? want : open[0] && open[0].id;
  if (oid) await loadOrg(oid, { quiet: true });
  if (!ORG) { page = SSO_NEEDED ? 'count' : 'workspace'; return render(); }
  if (!S.cloud) {
    const last = lsGet(LAST);
    if (last && ACCOUNT.list.some((e) => e.id === last)) return cloudOpen(last);
    if (S.example && ACCOUNT.list.length) page = 'portfolio';
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
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
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
function renderHemi(nd) {
  if (!S.members.length) { $('#hemi').innerHTML = `<p class="note" style="margin:24px 0">${SYNC.loading ? 'Loading the campaign.' : 'No members yet. Open Setup to load a preset chamber, or add members one at a time.'}</p>`; $('#tally').innerHTML = ''; $('#path').textContent = ''; return; }
  const order = S.members.slice().sort((a, b) => b.pos - a.pos || (PARTY_ORDER[a.party] ?? 1) - (PARTY_ORDER[b.party] ?? 1));
  const { seats, size } = seatLayout(order.length);
  const inView = (m) => view === 'floor' || m.cmte;
  const grp = S.members.filter(inView), cnt = (p) => grp.filter((m) => m.pos === p).length;
  const need = view === 'floor' ? nd.needF : nd.needC, defeat = dirOf(S) < 0;
  const have = defeat ? cnt(0) + cnt(1) : cnt(4) + cnt(3), target = defeat ? grp.length - need + 1 : need, where = view === 'floor' ? 'on the floor' : 'in committee';
  $('#hemi').innerHTML = `<svg viewBox="0 0 600 322" style="--sw:${Math.min(2, size / 4).toFixed(2)}px" role="group" aria-label="Seating chart coloured by position">
    ${order.map((m, i) => `<circle class="seat p${m.pos}${m.cmte ? ' cmte' : ''}${inView(m) ? '' : ' dim'}" cx="${seats[i].x.toFixed(1)}" cy="${seats[i].y.toFixed(1)}" r="${size.toFixed(1)}" tabindex="0" role="button" data-open="${esc(m.id)}" aria-label="${esc(m.name)}, ${POS[m.pos]}"><title>${esc(m.name)} (${esc(m.party)}-${esc(m.district)}): ${POS[m.pos]}</title></circle>`).join('')}
    <text class="hub" x="300" y="268" text-anchor="middle" font-size="46" font-weight="800">${grp.length ? have : 0}<tspan font-size="22" font-weight="500"> / ${grp.length ? target : 0}</tspan></text>
    <text class="hub small" x="300" y="292" text-anchor="middle" font-size="13">${defeat ? 'no and lean no / needed to block' : 'yes and lean yes / needed'}${view === 'cmte' ? ' in committee' : ''}</text>
  </svg>`;
  if (!grp.length) { $('#tally').innerHTML = '<p class="note" style="margin-top:10px">No committee members are marked. Open a member and tick "Sits on the committee", or pick a committee when loading a preset.</p>'; $('#path').textContent = ''; return; }
  const total = grp.length, left = (need / total) * 100;
  $('#tally').innerHTML = `<div class="tallywrap"><div class="tally" style="margin-top:0">${[4, 3, 2, 1, 0].map((p) => `<i class="b${p}" style="width:${(cnt(p) / total) * 100}%"></i>`).join('')}</div>
    <div class="need${left > 70 ? ' flip' : ''}" style="left:${left}%"><span>${need} to pass</span></div></div>
    <div class="legend">${[4, 3, 2, 1, 0].map((p) => `<span><span class="dot b${p}"></span>${POS[p]} <b>${cnt(p)}</b></span>`).join('')}${nd.c ? `<span>Outlined seats sit on ${esc(S.campaign.committee || 'the committee')}</span>` : ''}</div>`;
  const short = target - have, soft = defeat ? cnt(1) : cnt(3), play = cnt(2) + (defeat ? cnt(3) : cnt(1));
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
  $('#odds').innerHTML = S.members.length ? `${pct(goal(S, base.both))}<small>%</small>` : '<small>No roster yet</small>';
  $('#stages').innerHTML = defeat
    ? `<div class="stage"><b>${nd.c ? pct(1 - base.cm) + '%' : 'n/a'}</b><span>Stopped in committee (${nd.c - nd.needC + 1} of ${nd.c} to block)</span></div><div class="stage"><b>${pct(1 - base.fl)}%</b><span>Fails on the floor (${nd.n - nd.needF + 1} of ${nd.n} to block)</span></div>`
    : `<div class="stage"><b>${nd.c ? pct(base.cm) + '%' : 'n/a'}</b><span>Clears committee (${nd.needC} of ${nd.c})</span></div><div class="stage"><b>${pct(base.fl)}%</b><span>Wins the floor (${nd.needF} of ${nd.n})</span></div>`;
  const now = goal(S, base.both);
  const pts = S.trend.slice(-30).concat(S.trend.length && S.trend[S.trend.length - 1].d === today() ? [] : [{ d: today(), p: now }]);
  if (pts.length < 2 || !S.members.length) $('#spark').innerHTML = '<p class="note">The trend line appears once positions change on more than one day.</p>';
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
  }).join('') : `<li style="display:block" class="note">${S.members.length ? 'No single conversation changes the odds right now. Either the count is locked or the remaining members are out of reach.' : 'The call sheet fills in once the campaign has a roster.'}</li>`;
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
  $('#tasks').innerHTML = (open.length ? open.map(taskHtml).join('') : upcoming().length ? '' : '<li style="display:block" class="note">Nothing scheduled or outstanding. Schedule a meeting from any member, or add a follow-up below.</li>')
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
    <td><button class="who" data-open="${esc(m.id)}">${esc(m.name)}</button><div class="meta">${esc(m.party)}-${esc(m.district)}${m.role ? ` · ${esc(m.role)}` : m.cmte ? ' · committee' : ''}${contact(m).phone ? ` · <span class="tel">${esc(contact(m).phone)}</span>` : ''}${m.staffers.length ? ` · ${m.staffers.length} staff` : ''}</div></td>
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
  const t = String(text || '').replace(/\s+/g, ' ').trim(); if (!t) return '';
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
    ${b.draftedAt ? `<p class="draftnote noprint">The analysis below was drafted with Claude on ${esc(fmtDay(b.draftedAt.slice(0, 10)))} from the bill material. Check every point against the bill before you rely on it.</p>` : ''}
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
      <p class="wide note">${!signedIn() ? 'Sign in to look up bills.' : !ok ? 'Bill lookup is not set up on this server yet, so fill in the brief by hand.' : `Federal bills come from Congress.gov${cfg.bills.states ? ' and state bills from Open States' : ''}. This fills in the bill's details and official summary and keeps your analysis.`}</p>
    </form></div>`;
  }
  if (briefPanel === 'draft') {
    return `<div class="panel noprint" style="max-width:860px;margin:0 auto 14px"><form id="dfForm" class="form">
      <p class="wide note">Claude drafts the summary, what the bill does, talking points and likely objections, working only from the official summary and anything you paste here. It argues for your position: ${S.campaign.side === 'defeat' ? 'defeat' : 'pass'} the bill${S.campaign.ask ? `, with the ask "${esc(S.campaign.ask)}"` : ''}. Check every point before you use it.</p>
      <label class="wide">Bill text, analysis or notes <span class="note">optional</span><textarea id="df_text" name="material" style="min-height:150px" placeholder="Paste the bill text or a committee analysis for a better draft"></textarea></label>
      <div class="wide btnrow"><button class="btn primary" id="dfGo">${hasBrief(S.brief) && (S.brief.plainSummary || lines(S.brief.talkingPoints).length) ? 'Draft and replace my analysis' : 'Draft it'}</button><button type="button" class="btn" data-act="briefPanelOff">Cancel</button><span class="note" id="dfMsg"></span></div>
    </form></div>`;
  }
  return '';
}
function renderBrief() {
  const b = S.brief, ro = !canEditNow(), cfg = CLOUD.config || {};
  const tools = `<div class="brieftools noprint">${ro ? '' : `<button class="btn" data-act="briefEdit">${hasBrief(b) ? 'Edit' : 'Write it by hand'}</button><button class="btn" data-act="briefLookup">Look up the bill</button>${cfg.ai ? '<button class="btn" data-act="briefDraft">Draft analysis with Claude</button>' : ''}`}${hasBrief(b) ? '<button class="btn" data-act="briefCopy">Copy as text</button><button class="btn" data-act="briefPrint">Print or save as PDF</button>' : ''}</div>`;
  const empty = `<div class="brief" style="text-align:center"><h2 style="font-size:22px">No brief for this bill yet</h2><p class="note" style="margin:0 auto">Look up the bill to fill in its sponsors, status and official summary, then add your summary, talking points and likely objections. Every meeting brief and meeting request for this campaign uses it.</p></div>`;
  $('#briefPage').innerHTML = briefEdit ? briefFormHtml(b) : tools + briefPanelHtml() + (hasBrief(b) ? briefDoc(b) : empty);
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
    const b = S.brief;
    if (other) { const blank = blankBrief(); ['plainSummary', 'keyProvisions', 'whoItAffects', 'fiscalImpact', 'supporters', 'opponents', 'talkingPoints', 'objections', 'needsChecking', 'draftedAt'].forEach((k) => { b[k] = blank[k]; }); }
    Object.assign(b, { number: r.number, title: r.title, jurisdiction: r.jurisdiction, session: r.session,
      sponsors: r.sponsors.map((s) => `${s.name}${!/\[/.test(s.name) && (s.party || s.district) ? ` (${[s.party, s.district].filter(Boolean).join('-')})` : ''}`).join('; ') + (r.cosponsors ? `; ${r.cosponsors} cosponsor${r.cosponsors === 1 ? '' : 's'}` : ''),
      status: r.latestAction ? `${r.latestAction.text}${r.latestAction.date ? ` (${r.latestAction.date})` : ''}` : '', committees: r.committees.join('; '), introduced: r.introduced,
      url: r.url, officialSummary: r.officialSummary, officialSummaryLabel: r.officialSummaryLabel, source: r.source, fetchedAt: r.fetchedAt });
    if (!S.campaign.bill || /^(your bill|new campaign|untitled)/i.test(S.campaign.bill)) S.campaign.bill = `${r.number}: ${r.title}`.slice(0, 140);
    briefPanel = ''; save(); render(); toast(`${r.number} filled in from ${r.source}`);
  } catch (e) { btn.disabled = false; btn.textContent = 'Look it up'; btn.dataset.sure = ''; if (msgEl) msgEl.textContent = e.message; else fail(e); }
}
async function draftAnalysis(form) {
  const go = $('#dfGo'), msg = $('#dfMsg');
  if (go.dataset.sure !== '1' && /replace/i.test(go.textContent)) { go.dataset.sure = '1'; msg.textContent = 'This replaces your summary, talking points and objections. Press again to go ahead.'; return; }
  if (!signedIn()) return toast('Sign in to draft with Claude.');
  const b = S.brief, c = S.campaign, material = $('#df_text').value;
  go.disabled = true; msg.textContent = 'Claude is drafting. This can take up to a minute.';
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
const honorific = () => (/senate/i.test(S.campaign.chamber) ? 'Senator' : /house|assembly/i.test(S.campaign.chamber) ? 'Representative' : '');
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
  const out = m.staffers.filter((s) => isEmail(s.email || '')).map((s) => ({ email: s.email, label: `${s.name}${s.role ? `, ${s.role}` : ''}`, sid: s.id }));
  const ce = contact(m).email; if (isEmail(ce)) out.push({ email: ce, label: `${m.name}'s office` });
  return out;
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
  const list = recipients(m), signed = signedIn(), prov = CLOUD.provider(), canSign = CLOUD.canSignIn();
  const toSel = `<select id="rq_to" aria-label="Send to">${list.map((r) => `<option value="${esc(r.email)}" ${!RQ.other && r.email === RQ.to ? 'selected' : ''}>${esc(r.label)}: ${esc(r.email)}</option>`).join('')}<option value="__other" ${RQ.other ? 'selected' : ''}>Someone else</option></select>`;
  const tabs = `<div class="seg wide" role="group" aria-label="How"><button type="button" data-rqmode="email" aria-pressed="${RQ.mode === 'email'}">Ask for a meeting by email</button><button type="button" data-rqmode="invite" aria-pressed="${RQ.mode === 'invite'}">Send a calendar invitation</button></div>`;
  const common = `<label class="wide">To ${toSel}</label>
    <label class="wide" ${RQ.other ? '' : 'hidden'}>Email address<input id="rq_other" type="email" value="${RQ.other ? esc(RQ.to) : ''}" placeholder="scheduler@senate.example.gov"></label>
    <label>Length<select id="rq_mins">${[15, 30, 45, 60].map((n) => `<option value="${n}" ${RQ.mins === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></label>
    ${signed && prov ? `<div style="align-self:end"><button type="button" class="btn" data-act="rqFind">${RQ.mode === 'email' ? 'Offer open times from my calendar' : 'Use my next open time'}</button></div>` : '<div></div>'}`;
  const sendAs = prov ? [prov] : ['google', 'microsoft'];
  const signNote = !signed && canSign ? `<p class="wide note">Sign in with ${CLOUD.config.providers.map(CLOUD.providerName).join(' or ')} to send this from your own email and calendar. <button type="button" class="btn sm" data-act="signin">Sign in</button></p>` : '';
  let body;
  if (RQ.mode === 'email') {
    body = `<div class="wide times"><span class="note">Times to offer (${esc(tzName())})</span>${[0, 1, 2].map((i) => `<input type="datetime-local" id="rq_t${i}" value="${RQ.times[i] ? toInput(new Date(RQ.times[i])) : ''}" aria-label="Time option ${i + 1}">`).join('')}</div>
      <label class="wide">Subject<input id="rq_subject" value="${esc(RQ.subject)}"></label>
      <label class="wide">Message<textarea id="rq_body" class="out" style="min-height:260px">${esc(RQ.body)}</textarea></label>
      ${signNote}
      <div class="wide btnrow">${signed ? sendAs.map((x, i) => `<button type="button" class="btn${i ? '' : ' primary'}" data-act="rqSend" data-mp="${x}">Send from ${CLOUD.mailName(x)}</button>`).join('') : ''}<button type="button" class="btn${signed ? '' : ' primary'}" data-act="rqMailto">Open in my email app</button><button type="button" class="btn" data-act="rqCopy">Copy message</button><button type="button" class="btn" data-act="rqClose">Close</button></div>`;
  } else {
    body = `<label>Date and time<input type="datetime-local" id="rq_start" value="${RQ.start ? toInput(new Date(RQ.start)) : ''}"></label>
      <label>Where<input id="rq_where" value="${esc(RQ.where)}" placeholder="Office, phone or video"></label>
      ${signed ? `<label class="wide check"><input type="checkbox" id="rq_video" ${RQ.video ? 'checked' : ''}> Add a ${prov ? CLOUD.videoName(prov) : 'video meeting'} link</label>` : ''}
      <label class="wide">Note in the invitation <span class="note">optional</span><textarea id="rq_note">${esc(RQ.note)}</textarea></label>
      ${signNote}
      <div class="wide btnrow">${signed ? sendAs.map((x, i) => `<button type="button" class="btn${i ? '' : ' primary'}" data-act="rqInvite" data-mp="${x}">Send invitation from ${CLOUD.calName(x)}</button>`).join('') : ''}<button type="button" class="btn${signed ? '' : ' primary'}" data-act="rqIcs">Download invitation (.ics)</button><button type="button" class="btn" data-act="rqClose">Close</button></div>`;
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
  commit(ev ? `Invitation sent to ${to} from your ${CLOUD.calName(CLOUD.provider())}` : 'Invitation downloaded. Open it to add the meeting to your calendar, or attach it to an email.');
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
function showDrawer(html) { const d = $('#drawer'); d.innerHTML = html; d.hidden = false; $('#scrim').hidden = false; d.scrollTop = 0; const f = $('button, input', d); if (f) f.focus(); }
function closeDrawer() {
  openId = null; RQ = null; schedOpen = false; staffEdit = null; outKind = null; $('#drawer').hidden = true; $('#scrim').hidden = true;
  const n = S.members.length; S.members = S.members.filter((m) => !m.draft); if (S.members.length !== n) render();
}
function contactBlock(m) {
  const c = contact(m), safe = (u) => /^https?:\/\//.test(u);
  const rows = [
    c.phone && ['Phone', `<span class="tel">${esc(c.phone)}</span> ${copyBtn(c.phone)}`],
    c.email && ['Email', `${esc(c.email)} ${copyBtn(c.email)}`],
    c.office && ['Capitol office', esc(c.office)],
    (c.dphone || c.doffice) && ['District office', `${esc(c.doffice)}${c.dphone ? ` <span class="tel">${esc(c.dphone)}</span> ${copyBtn(c.dphone)}` : ''}`],
    (safe(c.url) || safe(c.form)) && ['Online', [safe(c.url) && `<a href="${esc(c.url)}" target="_blank" rel="noopener">Official page</a>`, safe(c.form) && `<a href="${esc(c.form)}" target="_blank" rel="noopener">Contact form</a>`].filter(Boolean).join(' · ')],
  ].filter(Boolean);
  return rows.length ? `<span class="label">Contact</span><dl class="kv">${rows.map((r) => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('')}</dl>` : '';
}
function staffLines(s) {
  return `${s.phone ? `<div><span class="tel">${esc(s.phone)}</span> ${copyBtn(s.phone)}</div>` : ''}${s.email ? `<div>${esc(s.email)} ${copyBtn(s.email)}${isEmail(s.email) ? ` <a href="mailto:${esc(s.email)}">Open in mail</a>` : ''}</div>` : ''}`;
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
  return `<span class="label">Staff</span>
  <ul class="hist">${m.staffers.length ? m.staffers.map(item).join('') : '<li class="note">No staff added yet. Add the scheduler, the chief of staff or the aide who handles your issue.</li>'}</ul>
  ${staffEdit === 'new' ? staffForm({}) : m.staffers.length < 12 ? '<div><button class="btn sm" data-act="addStaff">Add staff member</button></div>' : ''}`;
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
  box.innerHTML = `${p.committees.length ? `<label class="note" style="display:flex;flex-direction:column;gap:4px">Committee stage<select id="s_cmte"><option value="-1">No committee marked</option>${p.committees.map((c, i) => `<option value="${i}">${esc(c.name)} (${c.m.length})</option>`).join('')}</select></label>` : '<p class="note">No committee lists are included for this chamber. Mark committee members yourself after loading.</p>'}
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
let ORGS = [], ORG = null, CLIENTS = [], DOMAIN_MATCHES = [], PREFS = null, SSO_NEEDED = null, SSO_STEP = null;
const WS = { members: null, invites: null, audit: null, auditMore: true, report: null, lastInvite: null, loading: false, filter: { client: '', q: '', archived: false } };
const LASTORG = 'headcount.lastOrg';
const isAdmin = () => ORG && (ORG.role === 'owner' || ORG.role === 'admin');
const clientOf = (st = S) => (st.cloud && st.campaign.clientId ? (CLIENTS.find((k) => k.id === st.campaign.clientId) || {}).name || '' : st.campaign.client || '');
const firmOf = (st = S) => (st.cloud && ORG ? ORG.name : '');
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const limitText = (used, max) => (max === null || max === undefined ? `${used}` : `${used} of ${max}`);
function fail(e) { if (e && e.sso) { SSO_NEEDED = e.workspace || 'This workspace'; render(); return toast(e.message); } if (e && e.upgrade) notify(e.message, isAdmin() ? 'See plans' : '', 'gotoPlans'); else toast(e && e.message ? e.message : String(e)); }
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
    cmteDate: c.cmteDate || '', floorDate: c.floorDate || '', bill: st.brief.number || '', billStatus: st.brief.status || '',
    requested: ups.filter((x) => x.status === 'requested').length, meetings: ups.filter((x) => x.status === 'invited').slice(0, 3).map((x) => ({ start: x.start, title: x.title })),
    openTasks: st.tasks.filter((t) => !t.done).length, dueDates: st.tasks.filter((t) => !t.done && t.due).map((t) => t.due).sort().slice(0, 20),
  };
}

// ---------- portfolio ----------
function renderPortfolio() {
  const el = $('#portfolioPage');
  if (!signedIn()) { el.innerHTML = `<div class="panel empty">${CLOUD.canSignIn() ? 'Sign in to see every campaign in your workspace in one place. <button class="btn sm primary" data-act="signin">Sign in</button>' : 'The portfolio needs accounts, which are not set up on this server.'}</div>`; return; }
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
  upcoming.sort((a, b) => String(a.when).localeCompare(String(b.when)));
  const row = (c) => {
    const s = c.summary || {}, odds = s.odds, wk = (s.trend || []).filter((t) => t.d <= daysAgo(7)).slice(-1)[0];
    const delta = odds !== null && odds !== undefined && wk ? Math.round((odds - wk.p) * 100) : null;
    const cnt = s.counts || [0, 0, 0, 0, 0], have = s.side === 'defeat' ? cnt[3] + cnt[4] : cnt[0] + cnt[1];
    const target = s.side === 'defeat' ? (s.n || 0) - (s.needF || 0) + 1 : s.needF;
    const overdue = (s.dueDates || []).filter((d) => dayDiff(d) < 0).length, next = s.cmteDate || s.floorDate ? soonest(s) : null;
    return `<tr class="prow" data-opencamp="${esc(c.id)}" tabindex="0">
      <td><b>${esc(c.name || 'Untitled campaign')}</b>${c.archived ? ' <span class="status">Archived</span>' : ''}${c.visibility === 'team' ? ' <span class="status">Closed</span>' : ''}<div class="meta">${esc(s.billStatus || '')}</div></td>
      <td>${esc(c.client || '')}</td>
      <td class="num">${odds === null || odds === undefined ? '<span class="note">No roster</span>' : `<b>${pct(odds)}%</b>${delta ? ` <span class="${delta > 0 ? 'good' : 'bad'}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}<div class="meta">${s.side === 'defeat' ? 'to defeat' : 'to pass'}</div>`}</td>
      <td class="num">${s.n ? `${have} / ${target}` : ''}</td>
      <td>${next ? `${esc(next[0])}<div class="meta">${esc(fmtDay(next[1]))}, ${esc(inDays(next[1]))}</div>` : ''}</td>
      <td class="num">${(s.meetings || []).length ? `${s.meetings.length} booked` : ''}${s.requested ? `<div class="meta">${s.requested} requested</div>` : ''}</td>
      <td class="num">${overdue ? `<span class="bad"><b>${overdue} overdue</b></span>` : ''}${s.openTasks ? `<div class="meta">${s.openTasks} open</div>` : ''}</td>
      <td class="meta">${esc(fmtDate(c.updatedAt))}</td></tr>`;
  };
  el.innerHTML = `
    ${upcoming.length ? `<div class="panel"><span class="label">Coming up</span><ul class="moves">${upcoming.slice(0, 8).map((u) => `<li><span class="when">${esc(u.day ? fmtDay(u.when.slice(0, 10)) : fmtWhen(u.when))}</span> · <button class="linkbtn" data-opencamp="${esc(u.id)}">${esc(u.label)}</button></li>`).join('')}</ul></div>` : ''}
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
const ACTIONS = { 'workspace.created': 'created the workspace', 'workspace.renamed': 'renamed the workspace', 'workspace.exported': 'exported all data', 'workspace.owner_changed': 'passed ownership to', 'member.joined': 'joined', 'member.left': 'left the workspace', 'member.removed': 'removed', 'member.role_changed': 'changed the role of', 'invite.created': 'created an invitation for', 'invite.revoked': 'revoked an invitation', 'client.added': 'added client', 'client.updated': 'updated client', 'client.deleted': 'deleted client', 'campaign.created': 'created campaign', 'campaign.deleted': 'deleted campaign', 'campaign.archived': 'archived campaign', 'campaign.restored': 'restored campaign', 'campaign.visibility': 'changed who can see', 'billing.checkout_started': 'started checkout', 'billing.subscription': 'subscription is now', 'billing.canceled': 'subscription canceled', 'billing.seats_changed': 'changed the number of seats', 'billing.payment_failed': 'a payment failed', 'domain.added': 'added the email domain', 'domain.verified': 'verified the email domain', 'domain.join_on': 'let colleagues join from', 'domain.join_off': 'stopped joining from', 'domain.removed': 'removed the email domain', 'report.activity': 'ran the activity report for' };
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
  const status = p.key === 'trial' ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : p.status === 'past_due' ? 'Payment overdue' : p.key === 'unlimited' ? 'No limits on this server' : p.key === 'free' ? 'Free' : 'Active';
  const rows = [['People using seats', limitText(u.seats, p.seats)], ['Guests', limitText(u.guests, p.guests)], ['Active campaigns', limitText(u.campaigns, p.campaigns)], ['Briefs drafted this month', limitText(u.drafts, p.drafts)]];
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
      <label>Email <span class="note">optional</span><input id="oi_email" name="email" type="email" placeholder="colleague@yourfirm.com"></label>
      <label>Role<select id="oi_role" name="role"><option value="member">Member</option><option value="admin">Admin</option><option value="guest">Guest</option></select></label>
      <div class="wide btnrow"><button class="btn primary">Create invitation</button>${CLOUD.config.email || CLOUD.provider() ? `<label class="check note"><input type="checkbox" id="oi_send" checked> ${CLOUD.config.email ? 'Email the invitation' : `Email it from my ${CLOUD.mailName(CLOUD.provider())}`} when an address is given</label>` : ''}</div>
      </form>
      ${WS.lastInvite ? `<div class="linkbox" style="margin-top:8px"><input id="oi_link" readonly value="${esc(WS.lastInvite)}" aria-label="Invitation link"><button class="btn sm" data-copy="${esc(WS.lastInvite)}">Copy</button></div>` : ''}
      <p class="note">Members and admins use a seat; admins also manage people, billing and settings. Guests (clients, coalition partners) see only the campaigns they are added to and do not use a seat. An invitation with an email address works once, for that person; without one, anyone with the link can join for 14 days.</p>
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
  if (!on) body = '<p class="note">On the Team plan, colleagues with an email address at your firm\'s domain can join without an invitation.</p>';
  else if (!d) body = `<p class="note">Let colleagues with an email address at your firm's domain join this workspace as members, without an invitation. You prove you own the domain with a DNS record.</p><form id="dmForm" class="taskadd"><input id="dm_name" name="domain" placeholder="yourfirm.com" aria-label="Domain" required><button class="btn">Add domain</button></form>`;
  else if (!d.verified) body = `<p class="note">Add this TXT record to <b>${esc(d.name)}</b> at your DNS provider, then press Verify. Changes can take up to an hour to appear.</p><div class="linkbox"><input readonly value="headcount-verification=${esc(d.token)}" aria-label="TXT record"><button class="btn sm" data-copy="headcount-verification=${esc(d.token)}">Copy</button></div><div class="btnrow" style="margin-top:8px"><button class="btn primary" data-act="dmVerify">Verify</button><button class="btn" data-act="dmRemove">Remove</button></div>`;
  else body = `<p><span class="status ok">Verified</span> ${esc(d.name)}</p><label class="check"><input type="checkbox" id="dm_join" ${d.join ? 'checked' : ''}> Anyone who signs in with a verified @${esc(d.name)} address can join as a member (each uses a seat)</label><div><button class="btn sm" data-act="dmRemove">Remove domain</button></div>`;
  return `<div class="panel"><span class="label">Email domain</span>${body}</div>`;
}
function ssoPanel() {
  if (!isAdmin()) return '';
  const sso = ORG.sso || {}, d = ORG.domain, support = CLOUD.config.supportEmail;
  if (!ORG.plan.features.sso) return '<div class="panel"><span class="label">Single sign-on</span><p class="note">On the Firm plan, staff sign in through your identity provider (Okta, Microsoft Entra ID, or any SAML or OIDC provider), and you can require it.</p></div>';
  return `<div class="panel"><span class="label">Single sign-on</span>
    ${!d || !d.verified ? '<p class="note">Verify your email domain first: people reach your sign-in page by entering their work email.</p>' : ''}
    <form id="ssForm" class="form">
      <label class="wide">Provider ID from Identity Platform<input id="ss_provider" name="provider" value="${esc(sso.provider || '')}" placeholder="saml.yourfirm"></label>
      <label class="wide check"><input type="checkbox" id="ss_required" name="required" ${sso.required ? 'checked' : ''}> Require single sign-on for members and admins. Owners can always sign in, so they can fix these settings.</label>
      <div class="wide"><button class="btn primary">Save</button></div>
    </form>
    <p class="note">To connect your identity provider, ${support ? `write to ${esc(support)}` : 'contact Headcount support'}. They set it up in Identity Platform with your provider's details and give you the provider ID to enter here. People then choose "Sign in with single sign-on" and enter their ${d ? '@' + esc(d.name) : 'work'} email; anyone who signs in that way joins this workspace as a member.</p></div>`;
}
function reportPanel() {
  if (!isAdmin()) return '';
  if (!ORG.plan.features.activityReport) return '<div class="panel"><span class="label">Lobbying activity report</span><p class="note">On the Team plan: every contact your team logged in a quarter, grouped by client and issue, ready to help prepare disclosure reports such as the LD-2. <button class="btn sm" data-act="gotoPlans">See plans</button></p></div>';
  const qs = quarters(), r = WS.report;
  return `<div class="panel"><span class="label">Lobbying activity report</span>
    <form id="rpForm" class="filters" style="margin-top:10px">
      <select id="rp_q" name="q" aria-label="Quarter">${qs.map((q, i) => `<option value="${i}" ${r && r.from === q.from ? 'selected' : ''}>${q.label}</option>`).join('')}</select>
      <select id="rp_client" name="client" aria-label="Client"><option value="">All clients</option>${CLIENTS.map((k) => `<option value="${esc(k.id)}" ${r && r.client === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select>
      <button class="btn primary">Run report</button>${r ? '<button type="button" class="btn" data-act="rpCsv">Download CSV</button>' : ''}
    </form>
    ${r ? `<p class="note">${r.rows.length} contact${r.rows.length === 1 ? '' : 's'} logged from ${esc(fmtDay(r.from))} to ${esc(fmtDay(r.to))}.</p>
      ${r.summary.length ? `<div class="tablewrap" style="max-height:none"><table><thead><tr><th>Client</th><th>Contacts</th><th>Issues</th><th>Chambers</th><th>Lobbyists</th></tr></thead><tbody>${r.summary.map((g) => `<tr><td><b>${esc(g.client)}</b></td><td class="num">${g.contacts}</td><td>${esc(g.issues.join('; '))}</td><td>${esc(g.chambers.join('; '))}</td><td>${esc(g.lobbyists.join(', '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${r.rows.length ? `<details><summary class="note">Every contact</summary><div class="tablewrap"><table><thead><tr><th>Date</th><th>Client</th><th>Member</th><th>With</th><th>Type</th><th>Logged by</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td class="num">${esc(x.date)}</td><td>${esc(x.client)}</td><td>${esc(x.member)} <span class="note">${esc(x.party || '')}-${esc(x.district || '')}</span></td><td>${esc(x.withWhom)}</td><td>${esc(x.type)}</td><td>${esc(x.loggedBy)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}` : ''}
    <p class="note">This lists contacts logged in Headcount. It is a worksheet, not a filing: disclosure laws define lobbying contacts and activities in their own terms, and some work happens outside the app. Check it against your records and with counsel.</p></div>`;
}
function auditPanel() {
  if (!isAdmin() || !ORG.plan.features.audit) return '';
  return `<div class="panel"><div class="row"><span class="label">Activity log</span>${WS.audit && WS.audit.length ? '<button class="btn sm" data-act="auditCsv">Download CSV</button>' : ''}</div>
    ${WS.audit ? `<ul class="hist">${WS.audit.map((a) => `<li><time>${esc(new Date(a.at).toLocaleString())}</time> · ${esc(a.actor || 'Billing')} ${esc(a.action === 'invite.created' && !a.target ? 'created an invitation link' : ACTIONS[a.action] || a.action)}${a.target ? ` <b>${esc(a.target)}</b>` : ''}${a.detail && a.detail.role ? ` as ${esc(ROLE_LABEL[a.detail.role] || a.detail.role)}` : ''}${a.detail && a.detail.to ? ` to ${esc(ROLE_LABEL[a.detail.to] || a.detail.to)}` : ''}${a.detail && a.detail.seats ? ` (${a.detail.seats} seats)` : ''}</li>`).join('') || '<li class="note">Nothing yet.</li>'}</ul>${WS.auditMore ? '<button class="btn sm" data-act="auditMore">Show older</button>' : ''}` : '<p class="note">Loading</p>'}</div>`;
}
function dataPanel() {
  const owner = ORG.role === 'owner';
  return `<div class="panel"><span class="label">Workspace</span>
    ${isAdmin() ? `<form id="wnForm" class="taskadd"><input id="wn_name" name="name" value="${esc(ORG.name)}" aria-label="Workspace name" required><button class="btn">Rename</button></form>
    <p class="note">The workspace name appears in meeting requests as the organization you are writing from.</p>
    <div class="btnrow"><button class="btn" data-act="orgExport">Download all data (JSON)</button></div>` : ''}
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
    <p class="note">A workspace holds your firm's campaigns, clients and team. You can invite colleagues once it exists.${CLOUD.config && CLOUD.config.billing ? ` New workspaces start with a ${CLOUD.config.billing.trialDays}-day Team trial.` : ''}</p>
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
  if (!signedIn()) { el.innerHTML = `<div class="panel empty">${CLOUD.canSignIn() ? 'Sign in to set up a workspace for your team. <button class="btn sm primary" data-act="signin">Sign in</button>' : 'Workspaces need accounts, which are not set up on this server.'}</div>`; return; }
  if (!ORG) { el.innerHTML = onboardingHtml(); return; }
  el.innerHTML = `<div class="wsgrid">${planPanel()}${peoplePanel()}${clientsPanel()}${domainPanel()}${ssoPanel()}${reportPanel()}${auditPanel()}${dataPanel()}</div>`;
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
  const access = sendIt && !server && !CLOUD.connected() ? CLOUD.connect() : null;
  try {
    const r = await CLOUD.api('POST', `/api/workspaces/${ORG.id}/invites`, { role, email: email || undefined, send: Boolean(sendIt && server) });
    WS.lastInvite = `${location.origin}/invite/${r.code}`; WS.invites = null;
    if (sendIt && server) toast(r.emailed ? `Invitation emailed to ${email}` : 'Invitation link created. Copy it and send it to your colleague.');
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
  if (signedIn()) os.innerHTML = (ORG ? '' : '<option value="">No workspace yet</option>') + ORGS.map((o) => opt(o.id, o.name + (o.ssoRequired ? ' (single sign-on)' : o.role === 'guest' ? ' (guest)' : ''), ORG && o.id === ORG.id)).join('') + '<option value="__new">New workspace…</option>';
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
  $('#menuAccount').hidden = !signedIn();
  if (!cfg || !CLOUD.ready) { el.innerHTML = ''; return; }
  if (signedIn()) el.innerHTML = `<button class="btn" data-act="account" title="${esc(CLOUD.user.email)}">${esc(CLOUD.user.name.split(/\s+/)[0] || 'Account')}</button>`;
  else if (CLOUD.canSignIn()) el.innerHTML = '<button class="btn primary" data-act="signin">Sign in</button>';
  else el.innerHTML = '';
}
function render() {
  const c = S.campaign, cfg = CLOUD.config || {}, campaignPage = page === 'count' || page === 'brief';
  renderSwitcher();
  $('.camp').hidden = !campaignPage;
  ['pgPortfolio', 'pgWorkspace'].forEach((id) => { $('#' + id).hidden = !signedIn(); });
  ['portfolio', 'count', 'brief', 'workspace'].forEach((k) => { $('#pg' + k[0].toUpperCase() + k.slice(1)).setAttribute('aria-pressed', page === k); });
  if (campaignPage) {
    const nd = needs(S);
    $('#hBill').textContent = c.bill || (SYNC.loading ? 'Loading' : 'Untitled campaign');
    const camp = S.cloud && ACCOUNT.list.find((e) => e.id === S.id);
    $('#hSub').textContent = `${camp && camp.visibility === 'team' ? 'Closed · ' : ''}${dirOf(S) < 0 ? 'Working to defeat' : 'Working to pass'}${clientOf() ? ` for ${clientOf()}` : ''} · ${c.chamber || 'Chamber not set'} · ${nd.n} members, ${nd.needF} to pass`;
    $('#hDates').textContent = [['Committee vote', c.cmteDate], ['Floor vote', c.floorDate]].filter((x) => x[1]).map((x) => `${x[0]} ${inDays(x[1])} (${fmtDay(x[1])})`).concat((() => { const n = S.tasks.filter((t) => !t.done && t.due && dayDiff(t.due) < 0).length; return n ? [`${n} follow-up${n > 1 ? 's' : ''} overdue`] : []; })()).join(' · ');
  } else {
    $('#hBill').textContent = page === 'portfolio' ? (ORG ? ORG.name : 'Portfolio') : ORG ? `${ORG.name} settings` : 'Workspace';
    $('#hSub').textContent = ORG ? `${ORG.plan.label} · ${ROLE_LABEL[ORG.role]}${ORG.role === 'guest' ? ': you see only the campaigns you were added to' : ''}` : '';
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
  else if (signedIn() && SSO_NEEDED) banner = `<span><b>${esc(SSO_NEEDED)}</b> requires single sign-on. Sign in through your firm's identity provider to see its campaigns.</span><button class="btn sm primary" data-act="ssoSwitch">Sign in with single sign-on</button>`;
  else if (signedIn() && match) banner = `<span>Your colleagues at <b>${esc(match.name)}</b> use Headcount.</span><button class="btn sm primary" data-act="joinDomain" data-id="${esc(match.id)}">Join ${esc(match.name)}</button>`;
  else if (signedIn() && !ORG && page !== 'workspace') banner = '<span>Set up a workspace to save campaigns to your account and work with your team.</span><button class="btn sm primary" data-page="workspace">Set up a workspace</button>';
  else if (signedIn() && ORG && ORG.role !== 'guest' && localIds().length) banner = `<span>${localIds().length} campaign${localIds().length === 1 ? ' is' : 's are'} saved only in this browser.</span><button class="btn sm" data-act="moveLocal">Move to ${esc(ORG.name)}</button>`;
  else if (ORG && isAdmin() && page === 'portfolio' && (ORG.plan.key === 'trial' || ORG.plan.key === 'free' || ORG.plan.status === 'past_due') && cfg.billing) {
    const d = ORG.plan.trialEnds ? Math.max(0, Math.ceil((ORG.plan.trialEnds - Date.now()) / 864e5)) : 0;
    banner = `<span>${ORG.plan.status === 'past_due' ? 'The last payment failed. Update the card to keep your plan.' : ORG.plan.key === 'trial' ? `Team trial: ${d} day${d === 1 ? '' : 's'} left.` : `Free plan: up to ${ORG.plan.seats} people and ${ORG.plan.campaigns} active campaigns.`}</span><button class="btn sm" data-act="gotoPlans">${ORG.plan.status === 'past_due' ? 'Update payment' : 'See plans'}</button>`;
  } else if (S.example && campaignPage) banner = `<span><b>Example campaign.</b> The chamber, bill and members are invented. Edit anything to make it yours${signedIn() ? '' : ', or load a real roster'}.</span><button class="btn sm" data-act="setup">Load a roster</button>`;
  b.hidden = !banner; b.innerHTML = banner;
  const w = $('#warn'), ro = campaignPage && S.cloud && ROLE === 'viewer'; w.hidden = !(ro || (campaignPage && S.preset && S.preset.stale));
  if (ro) w.textContent = 'You have view-only access to this campaign. Ask its owner to make you an editor to change it.';
  else if (!w.hidden) w.textContent = `This ${S.preset.label} roster predates the November 3, 2026 election. Florida legislators take office on election day, so check each member against the official site before relying on it.`;
  ['portfolio', 'count', 'brief', 'workspace'].forEach((k) => { $('#' + k + 'Page').hidden = page !== k; });
  if (page === 'brief') renderBrief();
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
    <p class="note">People outside the workspace, such as clients or coalition partners, join as guests and see only the campaigns they are added to. Links work for 14 days.</p>
    ${owner ? '<div class="btnrow"><button class="btn sm" data-act="revokeInvites">Turn off all links</button>' + `<button class="btn sm" data-act="campArchive">${camp.archived ? 'Restore this campaign' : 'Archive this campaign'}</button></div>` : ''}` : ''}`;
}
function setupDrawer() {
  const c = S.campaign, ro = !canEditNow();
  showDrawer(`<div class="row"><h2>Setup</h2><button class="btn sm" data-act="close">Close</button></div>
  <details class="sect" open><summary>Campaign</summary>
  <form id="sForm" class="form">
    <label class="wide">Bill or vote<input id="s_bill" name="bill" value="${esc(c.bill)}"></label>
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
  ${ROSTERS ? `<select id="s_preset" aria-label="Preset roster"><option value="">Load a preset chamber</option>${Object.entries(ROSTERS).map(([k, p]) => `<option value="${k}">${esc(p.label)} (${p.members.length})</option>`).join('')}</select><div id="s_presetBox" style="display:flex;flex-direction:column;gap:10px"></div>` : '<p class="note">Preset rosters could not be loaded.</p>'}
  <div class="btnrow"><span class="note">Set</span><select id="b_party" aria-label="Party"><option value="D">every Democrat</option><option value="R">every Republican</option><option value="I">every independent</option></select><span class="note">to</span><select id="b_pos" aria-label="Position">${[4, 3, 2, 1, 0].map((p) => `<option value="${p}">${POS[p]}</option>`).join('')}</select><button class="btn" data-act="bulk">Apply</button></div>
  <details><summary class="note">Paste your own roster</summary>
  <p class="note">One member per line: name, party (D/R/I), district, committee (y/n), position, phone, email. Only the name is required. This replaces every current member and their history.</p>
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
    <label class="wide">Bill or vote<input id="n_bill" name="bill" required placeholder="HB 1021: Property insurance reform"></label>
    <label>Your goal<select id="n_side" name="side"><option value="pass">Pass it</option><option value="defeat">Defeat it</option></select></label>
    <label>Start from<select id="n_from" name="from">${S.members.length && !S.example ? '<option value="copy">The same roster and staff as this campaign</option>' : ''}<option value="blank">An empty roster</option></select></label>
    ${cloud ? `<label>Client<select id="n_client" name="clientId"><option value="">No client</option>${CLIENTS.filter((k) => !k.archived).map((k) => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('')}</select></label>
    <label>Who can see it<select id="n_vis" name="vis"><option value="org">Everyone in ${esc(ORG.name)}</option><option value="team">Only people I add</option></select></label>` : ''}
    <p class="wide note">${cloud ? `It is saved to ${esc(ORG.name)}.` : signedIn() ? 'It is saved in this browser only until you set up a workspace.' : 'It is saved in this browser only. Sign in to save campaigns to your firm\'s workspace and share them.'} Copying keeps every member, their contact details, staff, interests and notes, and resets positions, committee seats and history.</p>
    <div class="wide"><button class="btn primary">Create campaign</button></div>
  </form>`);
}
function signInDrawer(mode) {
  const cfg = CLOUD.config;
  showDrawer(`<div class="row"><h2>Sign in</h2><button class="btn sm" data-act="close">Close</button></div>
  <div class="signin">
    ${cfg.auth === 'dev' ? '<p class="note"><b>Local test mode.</b> No real account is used.</p><label class="note">Name<input id="dev_name" value="Test User"></label><label class="note">Email<input id="dev_email" value="tester@example.org"></label>' : ''}
    ${cfg.providers.map((p) => `<button class="btn" data-act="signinWith" data-p="${p}">Continue with ${CLOUD.providerName(p)}</button>`).join('')}
    ${cfg.sso ? `<details class="sect" ${mode === 'sso' ? 'open' : ''}><summary>Sign in with single sign-on</summary>
      <form id="ssoForm" class="taskadd"><input id="sso_email" name="email" type="email" required placeholder="you@yourfirm.com" aria-label="Work email" value="${esc((SSO_STEP && SSO_STEP.email) || '')}"><button class="btn">Continue</button></form>
      <div id="ssoNext" class="note">${SSO_STEP && SSO_STEP.provider ? `<button class="btn primary" data-act="ssoGo">Continue to ${esc(SSO_STEP.workspace)} sign-in</button>` : 'For firms that sign in through Okta, Microsoft Entra ID or another identity provider.'}</div></details>` : ''}
    <p class="note">Signing in saves your campaigns to your firm's workspace so you can use them on any device and share them with colleagues. Headcount asks for access to your calendar and email only when you first send a meeting request, and uses it only to send what you ask it to. <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p>
  </div>`);
}
function accountDrawer(scrollToEmail) {
  const u = CLOUD.user, p = CLOUD.provider(), cfg = CLOUD.config || {}, pr = PREFS || { digest: 'weekly', digestHour: 8, notifyAssigned: true, notifyAdded: true };
  const how = CLOUD.isSSO() ? 'Single sign-on' : CLOUD.providerName(u.provider);
  const choices = p ? [p] : ['google', 'microsoft'];
  showDrawer(`<div class="row"><h2>Account</h2><button class="btn sm" data-act="close">Close</button></div>
  <dl class="kv"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Signed in with</dt><dd>${esc(how)}</dd>
  <dt>Calendar and email</dt><dd>${CLOUD.connected() ? `<span class="status ok">${esc(CLOUD.mailName(p))} connected in this tab</span>` : '<span class="status">Not connected</span>'}</dd></dl>
  ${CLOUD.connected() ? '' : `<p class="note">Connect ${choices.map((x) => `${CLOUD.mailName(x)} and ${CLOUD.calName(x)}`).join(', or ')} to send meeting requests and invitations from your own account. Headcount reads your calendar only to find open times, never reads your email, and keeps the connection in this browser tab.</p>
  <div class="btnrow">${choices.map((x) => `<button class="btn" data-act="connect" data-mp="${x}">Connect ${CLOUD.mailName(x)}</button>`).join('')}</div>`}
  ${cfg.email ? `<details class="sect" id="emailSect" open><summary>Email from Headcount</summary>
    <label class="note" style="display:flex;flex-direction:column;gap:4px">Digest<select id="pf_digest"><option value="daily" ${pr.digest === 'daily' ? 'selected' : ''}>Every morning</option><option value="weekly" ${pr.digest === 'weekly' ? 'selected' : ''}>Monday mornings</option><option value="off" ${pr.digest === 'off' ? 'selected' : ''}>No digest</option></select></label>
    <label class="note" style="display:flex;flex-direction:column;gap:4px">Send it at<select id="pf_hour">${[6, 7, 8, 9, 10, 11, 12].map((h) => `<option value="${h}" ${pr.digestHour === h ? 'selected' : ''}>${h <= 12 ? h : h - 12}${h < 12 ? ' a.m.' : ' p.m.'}</option>`).join('')}</select></label>
    <p class="note">The digest covers position changes, contacts logged, votes and meetings coming up, and your overdue follow-ups, in your time zone${pr.tz ? ` (${esc(pr.tz)})` : ''}.</p>
    <label class="check"><input type="checkbox" id="pf_assigned" ${pr.notifyAssigned ? 'checked' : ''}> Email me when someone assigns me a follow-up</label>
    <label class="check"><input type="checkbox" id="pf_added" ${pr.notifyAdded ? 'checked' : ''}> Email me when someone adds me to a campaign</label>
  </details>` : ''}
  <div class="btnrow"><button class="btn" data-act="signout">Sign out</button></div>
  <details class="sect"><summary>Delete my account</summary><p class="note">This removes you from every workspace. A workspace you alone own passes to its longest-standing admin or member, or is deleted if nobody else is in it. It cannot be undone.</p><div><button class="btn sm warn" data-act="delAccount">Delete my account</button></div></details>`);
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
  const menu = $('#moreMenu'); if (menu.open && !(e.target.closest('summary') && menu.contains(e.target))) menu.open = false;
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
  const access = needsMail && signedIn() && (!CLOUD.connected() || (t.dataset.mp && CLOUD.provider() !== t.dataset.mp)) ? CLOUD.connect(t.dataset.mp) : null;
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
    case 'reports': return reportsDrawer();
    case 'staffDir': return staffDirDrawer();
    case 'newCamp': return newCampDrawer();
    case 'signin': return signInDrawer();
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
      const link = document.createElement('a'); link.href = `mailto:${encodeURIComponent(RQ.to)}?subject=${encodeURIComponent(RQ.subject)}&body=${encodeURIComponent(RQ.body)}`; link.click();
      RQ.sentVia = 'email app';
      rqMsg(''); $('#rqMsg').innerHTML = 'Your email app should open with the message. Once you have sent it: <button type="button" class="btn sm primary" data-act="rqLogged">Log the request</button>';
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
    case 'rmStaff': if (m && sure('Confirm remove')) { m.staffers = m.staffers.filter((s) => s.id !== t.dataset.sid); save(); toast('Staff member removed'); memberDrawer(openId); renderRows(); } return;
    case 'saveRep': return download(`headcount-${repKind}-${today()}.${REPORTS[repKind][1]}`, reportText(), repKind === 'client' ? 'text/plain' : 'text/csv');
    case 'briefEdit': briefEdit = true; briefPanel = ''; return renderBrief();
    case 'briefCancel': briefEdit = false; return renderBrief();
    case 'briefLookup': briefPanel = 'lookup'; renderBrief(); { const f = $('#lk_n'); if (f) f.focus(); } return;
    case 'briefDraft': briefPanel = 'draft'; renderBrief(); { const f = $('#df_text'); if (f) f.focus(); } return;
    case 'briefPanelOff': briefPanel = ''; return renderBrief();
    case 'briefCopy': return copyText(briefPlain(S.brief));
    case 'briefPrint': return window.print();
    case 'preset': {
      const key = $('#s_preset').value, ci = $('#s_cmte') ? +$('#s_cmte').value : -1, backed = $('#s_backed').value;
      if (!sure(`Replace the current roster with ${ROSTERS[key].label}`)) return;
      loadPreset(key, ci, backed); closeDrawer(); return commit(`${ROSTERS[key].label} loaded`);
    }
    case 'bulk': {
      const party = $('#b_party').value, to = +$('#b_pos').value; let n = 0;
      S.members.forEach((x) => { if (x.party === party && x.pos !== to) { x.pos = to; n++; } });
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
  if (t.id === 'orgSel') { if (t.value === '__new') { t.value = ORG ? ORG.id : ''; return newOrgDrawer(); } return switchOrg(t.value); }
  if (t.dataset.orgrole) { try { await CLOUD.api('PATCH', `/api/workspaces/${ORG.id}/members/${encodeURIComponent(t.dataset.orgrole)}`, { role: t.value }); toast('Role changed'); } catch (err) { fail(err); } WS.members = null; await loadOrg(ORG.id, { quiet: true }); return render(); }
  if (t.id === 'pf_client') { WS.filter.client = t.value; return renderPortfolio(); }
  if (['pf_digest', 'pf_hour', 'pf_assigned', 'pf_added'].includes(t.id)) {
    const patch = { pf_digest: { digest: t.value }, pf_hour: { digestHour: +t.value }, pf_assigned: { notifyAssigned: t.checked }, pf_added: { notifyAdded: t.checked } }[t.id];
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
    if (m && m.pos !== to) { m.history.push(stamp({ d: today(), type: 'Count update', from: m.pos, to, note: '' })); m.pos = to; commit(`${m.name}: ${POS[to]}`); if (openId === m.id && !$('#drawer').hidden) memberDrawer(m.id); }
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
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target), id = e.target.id, cut = (k, n) => String(fd.get(k) || '').trim().slice(0, n);
  const m = S.members.find((x) => x.id === openId);
  if (id === 'oiForm') return sendOrgInvite(e.target);
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
  if (id === 'nForm') {
    const st = blankState(cut('bill', 140)); st.campaign.side = fd.get('side');
    if (fd.get('clientId')) { st.campaign.clientId = fd.get('clientId'); st.campaign.client = (CLIENTS.find((k) => k.id === st.campaign.clientId) || {}).name || ''; }
    if (fd.get('vis')) st.visibility = fd.get('vis');
    if (fd.get('from') === 'copy') {
      Object.assign(st.campaign, { chamber: S.campaign.chamber, rule: S.campaign.rule, me: S.campaign.me }, st.campaign.clientId ? {} : { client: S.campaign.client, clientId: S.campaign.clientId || '' });
      if (S.preset) st.preset = plain(S.preset);
      st.members = plain(S.members).filter((x) => !x.draft).map((x) => Object.assign(x, { pos: 2, cmte: false, role: '', history: [] }));
    }
    closeDrawer(); page = 'count'; await addCampaign(st); toast('Campaign created');
    if (!st.members.length) setupDrawer();
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
    const to = +fd.get('pos'), st = m.staffers.find((s) => s.id === fd.get('who'));
    m.history.push(stamp({ d: fd.get('d') || today(), type: fd.get('type'), who: st ? st.name : '', from: m.pos, to, note: cut('note', 1000) }));
    if (m.history.length > 60) m.history = m.history.slice(-60);
    if (cut('fu', 200)) S.tasks.push(stamp({ id: uid(), text: cut('fu', 200), due: fd.get('fud') || '', mid: m.id, done: false, assignee: S.cloud ? String(fd.get('fufor') || '') : '' }));
    m.pos = to; commit('Contact logged'); tab = 'history'; return memberDrawer(m.id);
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
  if (billing) {
    history.replaceState(null, '', '/app');
    if (billing === 'done') { toast('Thank you. Your plan will update in a few seconds.'); page = 'workspace'; render(); setTimeout(() => { if (ORG) loadOrg(ORG.id, { quiet: true }).then(render); }, 4000); }
    else if (billing === 'back' && ORG) { page = 'workspace'; await loadOrg(ORG.id, { quiet: true }); render(); }
  }
})();
