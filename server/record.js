import { HttpError } from './db.js';
import { parseFederal, parseState, currentCongress, STATES, chamberOf as namedChamber } from './bills.js';
import { billStory } from './story.js';

// A bill's public record, for filling in a whip count: who sponsored and
// cosponsored it, which committee has it and who sits there, and how each
// member voted on it. Congress.gov, the House Clerk and the Senate for
// Congress (committee rosters from the congress-legislators project); Open
// States for state legislatures.

const T = 15000;
async function get(url, headers = {}, kind = 'json') {
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'Headcount (vote count lookup)', ...(kind === 'json' ? { Accept: 'application/json' } : {}), ...headers }, signal: AbortSignal.timeout(T) }); }
  catch (_) { throw new HttpError(502, 'The bill database could not be reached. Try again shortly.'); }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The bill service did not accept the key. An admin can check it under Admin settings.');
  if (res.status === 429) throw new HttpError(429, 'The bill service is busy right now. Try again in a minute.');
  if (!res.ok) throw new HttpError(502, `The bill database returned an error (${res.status}).`);
  return kind === 'json' ? res.json() : res.text();
}
const memo = new Map();
async function cached(key, ms, fn) {
  const hit = memo.get(key); if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn(); memo.set(key, { at: Date.now(), value });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return value;
}

// Is a "yes" on this question a vote for the bill? Only questions about the
// bill itself count; procedural ones (recommit, table, cloture, rules,
// amendments) are left out rather than guessed.
export function stance(question) {
  const q = String(question || '').toLowerCase();
  if (/recommit|table|postpone|reconsider|previous question|cloture|motion to proceed|waive|point of order|providing for consideration|instruct|adjourn/.test(q)) return '';
  if (/amendment/.test(q) && !/(concur|agree to the (senate|house) amendment|as amended|with an amendment|with amendment)/.test(q)) return '';
  if (/passage|pass\b|third reading|concur|agree to the (senate|house) amendment|favorabl|do pass|adopt(ed)? the (conference )?report|conference report|final|override|ought to pass|report(ed)? (it )?favorably|agree(d)? to the (resolution|bill)/.test(q)) return 'for';
  return '';
}
const choice = (v) => { const s = String(v || '').toLowerCase(); return /^(yea|aye|yes|y)$/.test(s) ? 'yes' : /^(nay|no|n)$/.test(s) ? 'no' : 'other'; };
const xml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const tag = (t, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(t); return m ? xml(m[1]) : ''; };

export function parseHouseRoll(t) {
  const votes = [];
  for (const m of t.matchAll(/<recorded-vote>\s*<legislator([^>]*)>([^<]*)<\/legislator>\s*<vote>([^<]*)<\/vote>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    votes.push({ id: a['name-id'] || '', last: xml(a['unaccented-name'] || m[2]), state: a.state || '', v: choice(m[3]) });
  }
  const d = Date.parse(tag(t, 'action-date').replace(/-/g, ' '));
  return { chamber: 'lower', motion: tag(t, 'vote-question'), result: tag(t, 'vote-result'), date: Number.isNaN(d) ? '' : new Date(d).toISOString().slice(0, 10), votes };
}
export function parseSenateRoll(t) {
  const votes = [];
  for (const m of t.matchAll(/<member>([\s\S]*?)<\/member>/g)) votes.push({ id: '', last: tag(m[1], 'last_name'), first: tag(m[1], 'first_name'), state: tag(m[1], 'state'), v: choice(tag(m[1], 'vote_cast')) });
  const d = Date.parse(tag(t, 'vote_date').replace(/,\s*\d{1,2}:\d{2}\s*[AP]M$/i, ''));
  return { chamber: 'upper', motion: tag(t, 'vote_question_text') || tag(t, 'question'), result: tag(t, 'vote_result_text') || tag(t, 'vote_result'), date: Number.isNaN(d) ? '' : new Date(d).toISOString().slice(0, 10), votes };
}

async function federal(cfg, number, congress) {
  if (!cfg.congressKey) throw new HttpError(501, 'Looking up bills in Congress is not turned on yet. An admin adds a free Congress.gov key under Admin settings.');
  const p = parseFederal(number);
  if (!p) throw new HttpError(400, 'Enter a federal bill number such as H.R. 1234 or S. 56.');
  const c = Number(congress) || currentCongress();
  const base = `${cfg.congressBase}/bill/${c}/${p.type}/${p.number}`, h = { 'X-Api-Key': cfg.congressKey };
  const main = await get(`${base}?format=json`, h);
  if (!main || !main.bill) throw new HttpError(404, `${p.label} was not found in Congress ${c}.`);
  const page = async (path, key, max) => {
    const out = [];
    for (let off = 0; off < max; off += 250) {
      const r = await get(`${base}/${path}?format=json&limit=250&offset=${off}`, h).catch(() => null);
      const got = (r && r[key]) || []; out.push(...got);
      if (got.length < 250) break;
    }
    return out;
  };
  const [cos, actions, cm] = await Promise.all([page('cosponsors', 'cosponsors', 1000), page('actions', 'actions', 750), get(`${base}/committees?format=json`, h).catch(() => null)]);
  const person = (s) => ({ id: s.bioguideId || '', name: s.fullName || [s.firstName, s.lastName].join(' '), last: s.lastName || '', state: s.state || '', district: s.district != null ? String(s.district) : '' });
  // Committees: the one that has it now is the first not yet reported out.
  const membership = await cached('us-committees', 12 * 3600e3, () => get('https://unitedstates.github.io/congress-legislators/committee-membership-current.json').catch(() => null));
  const committees = [];
  for (const x of (cm && cm.committees) || []) {
    const acts = (x.activities || []).map((a) => String(a.name || '').toLowerCase());
    const code = String(x.systemCode || '').toUpperCase().replace(/00$/, '');
    const members = ((membership && membership[code]) || []).map((m) => ({ id: m.bioguide || '', name: m.name || '', role: m.title || '' }));
    committees.push({ name: x.name, chamber: /senate/i.test(x.chamber) ? 'upper' : 'lower', reported: acts.some((a) => /reported|discharged/.test(a)), members });
  }
  const seen = new Set(), rolls = [];
  for (const a of actions.slice().sort((x, y) => String(y.actionDate).localeCompare(String(x.actionDate)))) {
    for (const rv of a.recordedVotes || []) if (rv.url && !seen.has(rv.url)) { seen.add(rv.url); rolls.push(rv); }
  }
  const votes = [];
  for (const rv of rolls.slice(0, 10)) {
    const t = await cached(rv.url, 7 * 864e5, () => get(rv.url, {}, 'text')).catch(() => null);
    if (!t) continue;
    const v = /senate\.gov/.test(rv.url) ? parseSenateRoll(t) : parseHouseRoll(t);
    if (!v.votes.length) continue;
    votes.push({ ...v, url: rv.url, stance: stance(v.motion) });
  }
  // Where it started, from the bill type, and where it is now: the chamber of
  // the latest action taken in the House or the Senate.
  const origin = /^h/.test(p.type) ? 'lower' : 'upper';
  const lastChamber = actions.slice().sort((x, y) => String(y.actionDate).localeCompare(String(x.actionDate)))
    .map((a) => String((a.sourceSystem && a.sourceSystem.name) || '')).map((n) => (/house/i.test(n) ? 'lower' : /senate/i.test(n) ? 'upper' : '')).find(Boolean) || '';
  const actChamber = (a) => { const n = String((a.sourceSystem && a.sourceSystem.name) || ''); return /house/i.test(n) ? 'lower' : /senate/i.test(n) ? 'upper' : /\bHouse\b/.test(a.text || '') ? 'lower' : /\bSenate\b/.test(a.text || '') ? 'upper' : ''; };
  const story = billStory(actions.slice().reverse().map((a) => ({ date: a.actionDate, text: a.text, chamber: actChamber(a), kinds: [] })), votes, { lower: 'House', upper: 'Senate' }, { origin, executive: 'President' });
  return {
    bill: p.label, title: main.bill.title || '', source: 'Congress.gov', origin, now: lastChamber || origin, story,
    sponsors: (main.bill.sponsors || []).map(person),
    cosponsors: cos.filter((s) => !s.sponsorshipWithdrawnDate).map(person),
    committees, votes,
  };
}

const jurisdictionOf = (code) => (code === 'DC' ? 'ocd-jurisdiction/country:us/district:dc/government' : code === 'PR' ? 'ocd-jurisdiction/country:us/territory:pr/government' : `ocd-jurisdiction/country:us/state:${code.toLowerCase()}/government`);
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\bcommittee\b|\bon\b|\bthe\b|\bsenate\b|\bhouse\b|[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function state(cfg, code, number, session) {
  if (!cfg.openStatesKey) throw new HttpError(501, 'Looking up state bills is not turned on yet. An admin adds a free Open States key under Admin settings.');
  if (!STATES[code]) throw new HttpError(400, 'Choose a state.');
  const ident = parseState(number);
  if (!ident) throw new HttpError(400, 'Enter a bill number such as HB 123 or SB 45.');
  const h = { 'X-API-KEY': cfg.openStatesKey };
  const q = new URLSearchParams({ jurisdiction: jurisdictionOf(code), identifier: ident, sort: 'latest_action_desc', per_page: '1' });
  if (session) q.set('session', String(session).slice(0, 20));
  for (const inc of ['sponsorships', 'actions', 'votes']) q.append('include', inc);
  const body = await get(`${cfg.openStatesBase}/bills?${q}`, h);
  const b = body && body.results && body.results[0];
  if (!b) throw new HttpError(404, `${ident} was not found in ${STATES[code]}.`);
  const person = (p, fallback) => ({ id: (p && p.id) || '', name: (p && p.name) || fallback || '', last: String((p && p.name) || fallback || '').split(/\s+/).pop(), district: (p && p.current_role && p.current_role.district) || '', chamber: (p && p.current_role && p.current_role.org_classification) || '' });
  const sp = (b.sponsorships || []).filter((s) => s.person || s.entity_type === 'person');
  const chamberOf = (v) => (v.organization && v.organization.classification) || '';
  const votes = (b.votes || []).map((v) => ({
    chamber: chamberOf(v), motion: v.motion_text || '', result: v.result || '', date: String(v.start_date || '').slice(0, 10), stance: stance(v.motion_text),
    committee: (v.counts || []).reduce((n, c) => n + (c.value || 0), 0) < 15 && /favorabl|do pass|report/i.test(v.motion_text || ''),
    votes: (v.votes || []).map((x) => ({ ...person(x.voter, x.voter_name), v: choice(x.option) })),
  })).sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const acts = (b.actions || []).slice().sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
  // Committees named in the actions ("Referred to A; B; C", "Now in B"), each
  // with the chamber it was referred in: a bill can go to a Finance committee
  // in the House and another Finance committee in the Senate.
  const CHAMBER = ['upper', 'lower', 'legislature'];
  const referred = [], reported = new Set(); let now = '';
  const refer = (name, where) => {
    name = String(name || '').trim(); if (!name || /calendar|special order/i.test(name)) return;
    const chamber = /\b(house|assembly|delegates)\b/i.test(name) ? 'lower' : /\bsenate\b/i.test(name) ? 'upper' : where;
    if (!referred.some((x) => norm(x.name) === norm(name) && x.chamber === chamber)) referred.push({ name, chamber });
  };
  for (const a of acts) {
    const d = a.description || '', where = CHAMBER.find((c) => c === (a.organization && a.organization.classification)) || '';
    const r = /referred to\s+(.+)$/i.exec(d); if (r) r[1].split(/;\s*/).forEach((n) => refer(n, where));
    const n = /now in\s+(.+)$/i.exec(d); if (n) now = n[1].trim();
    const f = /(?:CS by|favorable by|reported (?:out )?(?:favorably )?(?:by|from))\s+([^;]+?)(?:;|$)/i.exec(d); if (f) reported.add(`${where}|${norm(f[1])}`);
    for (const e of a.related_entities || []) if (e.entity_type === 'organization' && /committee/i.test(e.name)) refer(e.name, where);
  }
  // Each chamber's committees with their members, kept for 12 hours. A failed
  // lookup is not kept, so the next one tries again.
  const listFor = (chamber) => cached(`os-committees-${code}-${chamber || 'all'}`, 12 * 3600e3, async () => {
    const out = [];
    for (let pg = 1; pg <= 6; pg++) {
      const q = new URLSearchParams({ jurisdiction: jurisdictionOf(code), per_page: '20', page: String(pg), include: 'memberships' }); if (chamber) q.set('chamber', chamber);
      const r = await get(`${cfg.openStatesBase}/committees?${q}`, h).catch(() => null);
      if (!r && pg === 1) throw new Error('committees unavailable');
      out.push(...((r && r.results) || []).map((c) => ({ ...c, chamber: c.chamber || chamber })));
      if (!r || !r.pagination || pg >= r.pagination.max_page) break;
    }
    return out;
  }).catch(() => []);
  const committees = [];
  for (const x of referred.slice(-6)) {
    const want = norm(x.name), list = await listFor(x.chamber);
    const hit = list.find((c) => norm(c.name) === want);
    const cm = hit ? (hit.memberships || []).map((m) => m.person && m.person.current_role && m.person.current_role.org_classification).find(Boolean) : '';
    committees.push({ name: x.name, chamber: x.chamber || cm || '', reported: reported.has(`${x.chamber}|${want}`) || reported.has(`|${want}`), now: Boolean(now) && norm(now) === want,
      members: hit ? (hit.memberships || []).map((m) => ({ ...person(m.person, m.person_name), role: /chair/i.test(m.role || '') ? (m.role.replace(/\b\w/g, (y) => y.toUpperCase())) : '' })) : [] });
  }
  // Where it started and where it is now: the chamber of the latest action in
  // the legislature (not the governor's).
  const chambers = ['upper', 'lower', 'legislature'];
  const origin = chambers.find((c) => c === (b.from_organization && b.from_organization.classification)) || '';
  const lastChamber = acts.slice().reverse().map((a) => (a.organization && a.organization.classification) || '').find((c) => chambers.includes(c)) || '';
  const names = Object.fromEntries((namedChamber(code, 'lower') ? ['lower', 'upper'] : ['legislature']).map((c) => [c, (namedChamber(code, c) || {}).short || ({ upper: 'Senate', legislature: (namedChamber(code, 'legislature') || { label: 'Legislature' }).label.replace(/^Nebraska /, '') })[c] || 'House']));
  const story = billStory(acts.map((a) => ({ date: a.date, text: a.description, chamber: (a.organization && a.organization.classification) || '', kinds: a.classification || [] })), votes, names,
    { origin: origin || undefined, unicameral: !namedChamber(code, 'lower'), executive: code === 'DC' ? 'Mayor' : 'governor' });
  return {
    bill: b.identifier || ident, title: b.title || '', source: 'Open States', origin, now: lastChamber || origin, story,
    sponsors: sp.filter((s) => s.primary !== false).map((s) => person(s.person, s.name)),
    cosponsors: sp.filter((s) => s.primary === false).map((s) => person(s.person, s.name)),
    committees, votes: votes.filter((v) => v.votes.length).slice(0, 12),
  };
}

export async function billRecord(cfg, { jurisdiction, number, session }) {
  const j = String(jurisdiction || '').toUpperCase();
  // Kept ten minutes: starting a campaign and filling its count read the same record.
  return cached(`record|${j}|${String(number || '').toUpperCase().replace(/[\s.]/g, '')}|${session || ''}`, 10 * 60e3, () => (j === 'US' ? federal(cfg, number, session) : state(cfg, j, number, session)));
}
