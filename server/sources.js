import { HttpError } from './db.js';
import { pacedFetch } from './pace.js';
import { fedBill, STATES, chamberOf, parseFederal } from './bills.js';

// Public data behind the Monitor, the intelligence panels and the action
// center. Each function returns plain, normalized objects so the rest of the
// server does not depend on any one source's format.
//
//   Congress.gov      federal bills (key: CONGRESS_API_KEY)
//   Open States       bills and legislators in every state (key: OPENSTATES_API_KEY)
//   Federal Register  proposed rules, final rules and notices (no key)
//   SAM.gov           federal contract opportunities (key: SAM_API_KEY)
//   LDA.gov           federal lobbying disclosure filings (key optional: LDA_API_KEY)
//   USAspending.gov   past federal contract awards (no key)
//   Census Geocoder   an address's congressional and state legislative districts (no key)

const day = (d) => d.toISOString().slice(0, 10);
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// Public services have bad moments (timeouts, 5xx, an HTML error page instead
// of JSON), so each call is tried twice before it fails with a plain message.
async function getJson(url, { headers, method = 'GET', body, name, notFound = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    const again = attempt < 1;
    let res;
    try {
      res = await pacedFetch(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    } catch (_) { if (again) { await pause(); continue; } throw new HttpError(502, `${name} could not be reached. Try again shortly.`); }
    if (res.status === 401 || res.status === 403) throw new HttpError(502, `${name} did not accept the key. An admin can check it under Admin settings.`);
    if (res.status === 429) throw new HttpError(429, `${name} is busy right now. Try again later.`);
    if (res.status === 404) { if (notFound) throw new HttpError(502, notFound); return null; }
    if (res.status >= 500 && again) { await pause(); continue; }
    if (!res.ok) throw new HttpError(502, `${name} returned an error (${res.status}).`);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (_) { if (again) { await pause(); continue; } throw new HttpError(502, `${name} sent an unexpected response. Try again shortly.`); }
  }
}
const pause = () => new Promise((r) => setTimeout(r, 700));

// Watch queries are comma-separated phrases: "rural broadband, digital equity".
export const phrases = (q) => String(q || '').split(/[,\n;]+/).map((s) => s.trim().replace(/^"|"$/g, '')).filter((s) => s.length >= 2).slice(0, 6);
export function matches(text, q) {
  const t = String(text || '').toLowerCase();
  return phrases(q).some((p) => t.includes(p.toLowerCase()));
}
const ocd = (st) => (st === 'DC' ? 'ocd-jurisdiction/country:us/district:dc/government' : st === 'PR' ? 'ocd-jurisdiction/country:us/territory:pr/government' : `ocd-jurisdiction/country:us/state:${st.toLowerCase()}/government`);
const stateOf = (jid) => { const m = /(?:state|district|territory):([a-z]{2})/.exec(String(jid || '')); return m ? m[1].toUpperCase() : ''; };

// ---------- bills ----------
// Congress.gov has no keyword search, so the Monitor reads every bill updated
// since the last run and matches titles itself.
export async function congressUpdated(cfg, since, maxPages = 4) {
  if (!cfg.congressKey) throw new HttpError(501, 'Watching Congress needs a free Congress.gov key, which an admin adds under Admin settings.');
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ format: 'json', fromDateTime: `${day(since)}T00:00:00Z`, sort: 'updateDate desc', limit: '250', offset: String(page * 250) });
    const body = await getJson(`${cfg.congressBase}/bill?${q}`, { headers: { 'X-Api-Key': cfg.congressKey }, name: 'Congress.gov' });
    const bills = (body && body.bills) || [];
    for (const b of bills) {
      const f = fedBill(b.type, b.number, b.congress);
      if (!f) continue;
      out.push({ kind: 'bill', extId: `us-${b.congress}-${String(b.type).toLowerCase()}${b.number}`, number: f.label, title: clip(b.title, 500), juris: 'US', session: `${b.congress}`, status: clip(b.latestAction && b.latestAction.text, 400), statusDate: (b.latestAction && b.latestAction.actionDate) || '', date: String(b.updateDate || '').slice(0, 10), url: f.url, source: 'Congress.gov' });
    }
    if (bills.length < 250) break;
  }
  return out;
}

export async function stateBills(cfg, { states, q, since }) {
  if (!cfg.openStatesKey) throw new HttpError(501, 'Watching the states needs a free Open States key, which an admin adds under Admin settings.');
  const terms = phrases(q).map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' or ');
  if (!terms) return [];
  const list = states === 'all' || !states.length ? [null] : states.slice(0, 12);
  const out = [];
  for (const st of list) {
    const p = new URLSearchParams({ q: terms, sort: 'updated_desc', per_page: '20', updated_since: day(since) });
    if (st) p.set('jurisdiction', ocd(st));
    const body = await getJson(`${cfg.openStatesBase}/bills?${p}`, { headers: { 'X-API-KEY': cfg.openStatesKey }, name: 'Open States' });
    for (const b of (body && body.results) || []) {
      const s = stateOf(b.jurisdiction && b.jurisdiction.id) || st || '';
      out.push({ kind: 'bill', extId: `os-${b.id}`, number: clip(b.identifier, 40), title: clip(b.title, 500), juris: s, session: clip(b.session, 40), status: clip(b.latest_action_description, 400), statusDate: b.latest_action_date || '', date: String(b.updated_at || b.latest_action_date || '').slice(0, 10), url: b.openstates_url || '', source: 'Open States' });
    }
  }
  return out;
}

// ---------- finding a bill by topic ----------
// "sales tax" in Pennsylvania, "broadband" in Congress: the newest matching
// bills, for someone who does not know the number. Open States covers
// Congress as well as every state. Kept ten minutes.
const SEARCH_CACHE = new Map();
export async function searchBills(cfg, { leg, q }) {
  if (!cfg.openStatesKey) throw new HttpError(501, 'Searching bills needs a free Open States key, which an admin adds under Admin settings.');
  const st = String(leg || '').toUpperCase(), words = clip(q, 120);
  if (st !== 'US' && st !== 'ALL' && !STATES[st]) throw new HttpError(400, 'Choose the legislature to search.');
  if (words.length < 3) throw new HttpError(400, 'Type a few words about the bill, like "sales tax" or "broadband".');
  const key = `${st}|${words.toLowerCase()}`, hit = SEARCH_CACHE.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.value;
  const terms = phrases(words).map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
  const p = new URLSearchParams({ q: terms || words, sort: 'updated_desc', per_page: st === 'ALL' ? '20' : '12' });
  if (st !== 'ALL') p.set('jurisdiction', st === 'US' ? 'ocd-jurisdiction/country:us/government' : ocd(st));
  p.set('classification', 'bill'); // not resolutions or memorials
  const body = await getJson(`${cfg.openStatesBase}/bills?${p}`, { headers: { 'X-API-KEY': cfg.openStatesKey }, name: 'Open States' });
  const value = ((body && body.results) || []).map((b) => {
    const where = st !== 'ALL' ? st : /country:us\/government/.test((b.jurisdiction && b.jurisdiction.id) || '') ? 'US' : stateOf(b.jurisdiction && b.jurisdiction.id) || '';
    const f = where === 'US' ? parseFederal(b.identifier) : null;
    return { number: f ? f.label : clip(b.identifier, 40), title: clip(b.title, 400), session: clip(b.session, 40), status: clip(b.latest_action_description, 200), statusDate: clip(b.latest_action_date, 10), leg: where };
  });
  SEARCH_CACHE.set(key, { at: Date.now(), value }); if (SEARCH_CACHE.size > 200) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
  return value;
}

// ---------- regulations ----------
// The API takes type codes in searches but returns display names ("Proposed Rule").
const FR_TYPES = { PRORULE: 'Proposed rule', RULE: 'Final rule', NOTICE: 'Notice', PRESDOCU: 'Presidential document', 'PROPOSED RULE': 'Proposed rule', 'PRESIDENTIAL DOCUMENT': 'Presidential document' };
export async function federalRegister(cfg, { q, since, agency }) {
  const p = new URLSearchParams({ order: 'newest', per_page: '50', 'conditions[publication_date][gte]': day(since) });
  const terms = phrases(q).map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' | ');
  if (terms) p.set('conditions[term]', terms);
  if (agency) p.append('conditions[agencies][]', String(agency).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  for (const t of ['PRORULE', 'RULE', 'NOTICE', 'PRESDOCU']) p.append('conditions[type][]', t);
  for (const f of ['title', 'type', 'abstract', 'document_number', 'html_url', 'publication_date', 'agencies', 'comments_close_on', 'docket_ids']) p.append('fields[]', f);
  const body = await getJson(`${cfg.fedRegBase}/documents.json?${p}`, { name: 'The Federal Register' });
  return ((body && body.results) || []).map((d) => ({
    kind: 'reg', extId: `fr-${d.document_number}`, number: (d.docket_ids || [])[0] || d.document_number, title: clip(d.title, 500), juris: 'US',
    agency: clip((d.agencies || []).map((a) => a.name || a.raw_name).filter(Boolean).join('; '), 200), docType: FR_TYPES[String(d.type || '').toUpperCase()] || d.type || '',
    date: d.publication_date || '', deadline: d.comments_close_on || '', url: d.html_url || '', summary: clip(d.abstract, 1200), source: 'Federal Register',
  }));
}

// ---------- contracts ----------
const mmddyyyy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Of|And|The|For)\b/g, (w) => w.toLowerCase()).replace(/^./, (c) => c.toUpperCase());
export async function samOpportunities(cfg, { q, since, naics }) {
  if (!cfg.samKey) throw new HttpError(501, 'Watching federal contracts needs a free SAM.gov key, which an admin adds under Admin settings.');
  const to = new Date(), seen = new Map();
  const words = phrases(q).slice(0, 3);
  for (const title of words.length ? words : ['']) {
    const p = new URLSearchParams({ api_key: cfg.samKey, postedFrom: mmddyyyy(since), postedTo: mmddyyyy(to), limit: '100', offset: '0', ptype: 'o,p,k,r,s' });
    if (title) p.set('title', title);
    if (naics) p.set('ncode', String(naics).replace(/\D/g, '').slice(0, 6));
    // SAM.gov answers 404 with an empty body when it does not accept the key.
    const body = await getJson(`${cfg.samBase}/opportunities/v2/search?${p}`, { name: 'SAM.gov', notFound: 'SAM.gov did not accept the request. Check SAM_API_KEY.' });
    for (const o of (body && body.opportunitiesData) || []) {
      if (o.active === 'No') continue;
      const path = String(o.fullParentPathName || '').split('.').map((x) => x.trim()).filter(Boolean);
      seen.set(o.noticeId, {
        kind: 'contract', extId: `sam-${o.noticeId}`, number: clip(o.solicitationNumber, 60), title: clip(o.title, 500), juris: 'US',
        agency: clip([titleCase(path[0] || o.department || ''), titleCase(path.slice(1).join(' / ') || o.subTier || '')].filter(Boolean).join(': '), 200),
        docType: clip(o.type || o.baseType, 60), date: String(o.postedDate || '').slice(0, 10), deadline: String(o.responseDeadLine || '').slice(0, 10),
        url: o.uiLink || `https://sam.gov/opp/${o.noticeId}/view`, summary: clip([o.typeOfSetAsideDescription, o.naicsCode ? `NAICS ${o.naicsCode}` : ''].filter(Boolean).join(' · '), 300),
        naics: o.naicsCode || '', agencyTop: titleCase(path[0] || o.department || ''), source: 'SAM.gov',
      });
    }
  }
  return [...seen.values()];
}

// SAM.gov writes "Agriculture, Department of" or "Dept of Defense"; USAspending wants "Department of Agriculture".
export function usaAgencyName(name) {
  const n = String(name || '').trim().replace(/\bDept\.?\s+of\b/gi, 'Department of');
  const m = /^(.+?),\s*Department of( the)?$/i.exec(n);
  return m ? `Department of${m[2] || ''} ${m[1]}` : n;
}

// Who has won this kind of work at this agency over the last three years.
export async function incumbents(cfg, { agency: rawAgency, naics }) {
  const agency = usaAgencyName(rawAgency);
  const end = new Date(), start = new Date(Date.UTC(end.getUTCFullYear() - 3, end.getUTCMonth(), end.getUTCDate()));
  const filters = { time_period: [{ start_date: day(start), end_date: day(end) }], award_type_codes: ['A', 'B', 'C', 'D'] };
  if (naics) filters.naics_codes = [String(naics)];
  const ask = (f) => getJson(`${cfg.usaSpendingBase}/search/spending_by_category/recipient/`, { method: 'POST', body: { filters: f, category: 'recipient', limit: 8, page: 1 }, name: 'USAspending.gov' });
  let scope = `All agencies${naics ? `, NAICS ${naics}` : ''}, last 3 years`, body = null;
  if (agency) {
    try { body = await ask({ ...filters, agencies: [{ type: 'awarding', tier: 'toptier', name: agency }] }); scope = `${agency}${naics ? `, NAICS ${naics}` : ''}, last 3 years`; } catch (_) { body = null; }
    if (!body || !(body.results || []).length) { body = null; scope = `All agencies${naics ? `, NAICS ${naics}` : ''}, last 3 years`; }
  }
  body = body || await ask(filters);
  const rows = ((body && body.results) || []).map((r) => ({ name: clip(r.name, 120), amount: Number(r.amount) || 0 }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return { scope, total, recipients: rows.map((r) => ({ ...r, share: total ? r.amount / total : 0 })) };
}

// ---------- lobbying disclosures ----------
// Filings whose specific lobbying issues mention this bill: who else is
// lobbying on it, for which clients, and what they reported spending.
export function billPattern(number) {
  const m = /^\s*([A-Za-z. ]+?)\s*(\d+)\s*$/.exec(String(number || ''));
  if (!m) return null;
  const letters = m[1].replace(/[^A-Za-z]/g, '').split('').map((c) => `${c}\\.?\\s?`).join('');
  return new RegExp(`\\b${letters}${m[2]}\\b`, 'i');
}
// Issue descriptions are often long lists of bills; show the passage that names this one.
function excerpt(text, re, span = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim(), m = re.exec(t);
  if (!m || t.length <= span * 2) return t.slice(0, span * 2);
  const from = Math.max(0, m.index - span / 2), to = Math.min(t.length, m.index + m[0].length + span);
  return `${from ? '…' : ''}${t.slice(from, to).trim()}${to < t.length ? '…' : ''}`;
}
export async function lobbyingOn(cfg, { number, title }) {
  const re = billPattern(number);
  if (!re) throw new HttpError(400, 'Enter a federal bill number such as H.R. 1234.');
  const year = new Date().getUTCFullYear(), seen = new Map();
  for (const y of [year, year - 1]) {
    const p = new URLSearchParams({ filing_specific_lobbying_issues: String(number).trim(), filing_year: String(y), page_size: '25', ordering: '-dt_posted' });
    const body = await getJson(`${cfg.ldaBase}/filings/?${p}`, { headers: cfg.ldaKey ? { Authorization: `Token ${cfg.ldaKey}` } : {}, name: 'LDA.gov' });
    for (const f of (body && body.results) || []) {
      const acts = (f.lobbying_activities || []).filter((a) => re.test(a.description || ''));
      if (!acts.length) continue;
      seen.set(f.filing_uuid, {
        client: clip(f.client && f.client.name, 160), registrant: clip(f.registrant && f.registrant.name, 160),
        period: clip(`${f.filing_period_display || ''} ${f.filing_year || ''}`, 40), amount: Number(f.income || f.expenses) || 0,
        issue: excerpt(acts[0].description, re), entities: [...new Set(acts.flatMap((a) => (a.government_entities || []).map((g) => g.name)).filter(Boolean))].slice(0, 6),
        url: f.filing_document_url || '', posted: String(f.dt_posted || '').slice(0, 10),
      });
    }
  }
  const filings = [...seen.values()].sort((a, b) => b.posted.localeCompare(a.posted));
  const byClient = new Map();
  for (const f of filings) {
    const k = f.client || f.registrant, row = byClient.get(k) || { client: f.client, registrants: new Set(), amount: 0, filings: 0 };
    row.registrants.add(f.registrant); row.amount += f.amount; row.filings++; byClient.set(k, row);
  }
  return {
    bill: clip(number, 40), title: clip(title, 200), years: [year - 1, year],
    clients: [...byClient.values()].map((r) => ({ ...r, registrants: [...r.registrants] })).sort((a, b) => b.amount - a.amount || b.filings - a.filings).slice(0, 30),
    filings: filings.slice(0, 40), source: 'LDA.gov',
  };
}

// ---------- legislators ----------
const partyLetter = (p) => (/^dem/i.test(p) ? 'D' : /^rep/i.test(p) ? 'R' : 'I');
// A chamber's members change rarely, and Open States' free keys allow few
// requests a minute, so each roster is kept for six hours.
const ROSTER_CACHE = new Map();
export async function stateRoster(cfg, state, chamber) {
  if (!cfg.openStatesKey) throw new HttpError(501, 'Loading a state legislature needs a free Open States key, which an admin adds under Admin settings.');
  const st = String(state || '').toUpperCase();
  if (!STATES[st]) throw new HttpError(400, 'Choose a state.');
  if (!['upper', 'lower', 'legislature'].includes(chamber)) throw new HttpError(400, 'Choose a chamber.');
  const named = chamberOf(st, chamber);
  if (!named) throw new HttpError(400, `${STATES[st]} has no such chamber.`);
  const key = `${cfg.openStatesBase}|${st}|${named.chamber}`, hit = ROSTER_CACHE.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.value;
  const value = await fetchStateRoster(cfg, st, named.chamber);
  ROSTER_CACHE.set(key, { at: Date.now(), value }); if (ROSTER_CACHE.size > 120) ROSTER_CACHE.delete(ROSTER_CACHE.keys().next().value);
  return value;
}
async function fetchStateRoster(cfg, st, chamber) {
  const members = [];
  for (let page = 1; page <= 12; page++) {
    const p = new URLSearchParams({ jurisdiction: ocd(st), org_classification: chamber, per_page: '50', page: String(page) });
    p.append('include', 'offices');
    const body = await getJson(`${cfg.openStatesBase}/people?${p}`, { headers: { 'X-API-KEY': cfg.openStatesKey }, name: 'Open States' });
    for (const x of (body && body.results) || []) {
      const offices = x.offices || [], cap = offices.find((o) => o.classification === 'capitol') || {}, dist = offices.find((o) => o.classification === 'district') || {};
      members.push({ k: String(x.id || '').replace(/^ocd-person\//, '').slice(0, 13), n: clip(x.name, 120), p: partyLetter(x.party), d: clip(x.current_role && x.current_role.district, 40),
        ph: clip(cap.voice, 40), of: clip(cap.address, 200), em: clip(x.email, 160), dph: clip(dist.voice, 40), dof: clip(dist.address, 200), url: x.openstates_url || '' });
    }
    const pg = body && body.pagination;
    if (!pg || page >= (pg.max_page || 1)) break;
  }
  if (!members.length) throw new HttpError(404, `No current legislators were found for that chamber in ${STATES[st]}.`);
  const num = (d) => (Number.parseInt(d, 10) || 0);
  members.sort((a, b) => num(a.d) - num(b.d) || a.d.localeCompare(b.d) || a.n.localeCompare(b.n));
  const label = (chamberOf(st, chamber) || {}).label || `${STATES[st]} ${chamber === 'upper' ? 'Senate' : chamber === 'legislature' ? 'Legislature' : 'House'}`;
  return { key: `os-${st.toLowerCase()}-${chamber}`, label, chamber: label, seats: members.length, asOf: day(new Date()), source: 'Open States', committees: [], members, juris: { level: 'state', state: st, chamber } };
}

// ---------- districts for an address ----------
const FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR' };
// District names are written differently by the Census and by Open States
// ("1st Middlesex" and "First Middlesex", "&" and "and", "003" and "3"), so
// both sides are reduced to the same plain form before they are compared.
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 };
export const normDistrict = (d) => String(d == null ? '' : d).toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(state senate|state house|senate|house of representatives|house|assembly|legislative|district|dist|no|number)\b\.?/g, ' ')
  .replace(/[#.,'’()/-]/g, ' ')
  .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\b/g, (w) => String(ORDINALS[w]))
  .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
  .replace(/\b0+(?=\d)/g, '')
  .replace(/\s+/g, ' ').trim();

// Apartment, suite and unit numbers trip the Census lookup, which matches
// buildings, not units: "100 Main St Apt 4B" is found as "100 Main St".
const UNIT = /(?:,?\s*\b(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|spc|space|trlr|trailer|dept)\b\.?\s*#?\s*[\w-]+|,?\s*#\s*[\w-]+)\s*$/i;
export const stripUnit = (street) => { let t = String(street || '').trim(); for (let i = 0; i < 2; i++) t = t.replace(UNIT, '').trim(); return t.replace(/,\s*$/, ''); };
const tidy = (s) => String(s || '').replace(/\./g, ' ').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
// One line for letters and records, whichever way the address arrived.
export function addressLine(input) {
  if (input && typeof input === 'object') return clip([input.street, input.city, [input.state, input.zip].filter(Boolean).join(' ')].map((x) => clip(x, 120)).filter(Boolean).join(', '), 200);
  return clip(input, 200);
}

// Finds the districts for a home address, given either separate fields
// (street, city, state, ZIP: what browsers fill in) or one line. Formatting
// should never be why a constituent is turned away, so it tries the address
// as given, then without a unit number, then with fewer fields, before
// saying it could not be found.
export async function districtsFor(cfg, input) {
  const parts = input && typeof input === 'object' ? { street: tidy(clip(input.street, 120)), city: tidy(clip(input.city, 80)), state: clip(input.state, 30), zip: (String(input.zip || '').match(/\d{5}/) || [''])[0] } : null;
  const line = parts ? '' : clip(input, 200);
  if (parts ? !parts.street || !(parts.zip || (parts.city && parts.state)) : line.length < 8) throw new HttpError(400, 'Enter your street address, and your ZIP code or your city and state.');
  const tries = [];
  if (parts) {
    const bare = stripUnit(parts.street);
    tries.push(['address', { street: parts.street, city: parts.city, state: parts.state, zip: parts.zip }]);
    if (bare !== parts.street) tries.push(['address', { street: bare, city: parts.city, state: parts.state, zip: parts.zip }]);
    if (parts.zip) tries.push(['address', { street: bare, zip: parts.zip }]);
    if (parts.city && parts.state) tries.push(['address', { street: bare, city: parts.city, state: parts.state }]);
  } else {
    const a = tidy(line), segs = a.split(','), bare = [stripUnit(segs[0]), ...segs.slice(1)].join(',');
    tries.push(['onelineaddress', { address: a }]);
    if (bare !== a) tries.push(['onelineaddress', { address: bare }]);
  }
  const seen = new Set();
  let hit = null;
  for (const [kind, q] of tries) {
    const params = Object.fromEntries(Object.entries(q).filter(([, v]) => v));
    const key = kind + JSON.stringify(params); if (seen.has(key)) continue; seen.add(key);
    const p = new URLSearchParams({ ...params, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'all', format: 'json' });
    const body = await getJson(`${cfg.geocoderBase}/geographies/${kind}?${p}`, { name: 'The Census address lookup' });
    hit = body && body.result && (body.result.addressMatches || [])[0];
    if (hit) break;
  }
  if (!hit) throw new HttpError(404, 'We could not find that address. Check the street number and ZIP code, and use a home address rather than a P.O. box.', { notFound: true });
  const g = hit.geographies || {}, layer = (re) => { const k = Object.keys(g).find((x) => re.test(x)); return k ? (g[k] || [])[0] : null; };
  const stRec = layer(/^States$/i), cdRec = layer(/Congressional Districts/i), up = layer(/Legislative Districts - Upper/i), low = layer(/Legislative Districts - Lower/i);
  const state = (stRec && stRec.STUSAB) || FIPS[(stRec || cdRec || up || low || {}).STATE] || '';
  let cd = '';
  if (cdRec) {
    const code = Object.entries(cdRec).find(([k]) => /^CD\d+$/i.test(k));
    const n = Number.parseInt(code ? code[1] : cdRec.BASENAME, 10);
    cd = !n || n === 98 ? 'AL' : String(n);
  }
  // Every way the Census names each district, so a target written either way matches.
  const names = (rec, code) => (rec ? [...new Set([rec.BASENAME, rec.NAME, rec[code]].filter(Boolean).map(normDistrict).filter(Boolean))] : []);
  const upperNames = names(up, 'SLDU'), lowerNames = names(low, 'SLDL');
  return { matched: hit.matchedAddress || addressLine(input), state, cd, upper: upperNames[0] || '', lower: lowerNames[0] || '', upperNames, lowerNames,
    label: { upper: up ? clip(up.NAME || `State Senate district ${up.BASENAME || up.SLDU}`, 80) : '', lower: low ? clip(low.NAME || `${(chamberOf(state, 'lower') || { short: 'House' }).short} district ${low.BASENAME || low.SLDL}`, 80) : '' } };
}
