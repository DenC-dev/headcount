import { HttpError } from './db.js';
import { fedBill, STATES } from './bills.js';

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

async function getJson(url, { headers, method = 'GET', body, name } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (_) { throw new HttpError(502, `${name} could not be reached. Try again shortly.`); }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, `${name} rejected this server's API key.`);
  if (res.status === 429) throw new HttpError(429, `${name} is rate limiting this server. Try again later.`);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `${name} returned an error (${res.status}).`);
  return res.json();
}

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
  if (!cfg.congressKey) throw new HttpError(501, 'Federal bill monitoring needs CONGRESS_API_KEY on the server.');
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
  if (!cfg.openStatesKey) throw new HttpError(501, 'State bill monitoring needs OPENSTATES_API_KEY on the server.');
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

// ---------- regulations ----------
const FR_TYPES = { PRORULE: 'Proposed rule', RULE: 'Final rule', NOTICE: 'Notice', PRESDOCU: 'Presidential document' };
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
    agency: clip((d.agencies || []).map((a) => a.name || a.raw_name).filter(Boolean).join('; '), 200), docType: FR_TYPES[d.type] || d.type || '',
    date: d.publication_date || '', deadline: d.comments_close_on || '', url: d.html_url || '', summary: clip(d.abstract, 1200), source: 'Federal Register',
  }));
}

// ---------- contracts ----------
const mmddyyyy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Of|And|The|For)\b/g, (w) => w.toLowerCase()).replace(/^./, (c) => c.toUpperCase());
export async function samOpportunities(cfg, { q, since, naics }) {
  if (!cfg.samKey) throw new HttpError(501, 'Contract monitoring needs SAM_API_KEY on the server.');
  const to = new Date(), seen = new Map();
  const words = phrases(q).slice(0, 3);
  for (const title of words.length ? words : ['']) {
    const p = new URLSearchParams({ api_key: cfg.samKey, postedFrom: mmddyyyy(since), postedTo: mmddyyyy(to), limit: '100', offset: '0', ptype: 'o,p,k,r,s' });
    if (title) p.set('title', title);
    if (naics) p.set('ncode', String(naics).replace(/\D/g, '').slice(0, 6));
    const body = await getJson(`${cfg.samBase}/opportunities/v2/search?${p}`, { name: 'SAM.gov' });
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

// Who has won this kind of work at this agency over the last three years.
export async function incumbents(cfg, { agency, naics }) {
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
        issue: clip(acts[0].description, 300), entities: [...new Set(acts.flatMap((a) => (a.government_entities || []).map((g) => g.name)).filter(Boolean))].slice(0, 6),
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
export async function stateRoster(cfg, state, chamber) {
  if (!cfg.openStatesKey) throw new HttpError(501, 'Loading state rosters needs OPENSTATES_API_KEY on the server.');
  const st = String(state || '').toUpperCase();
  if (!STATES[st]) throw new HttpError(400, 'Choose a state.');
  if (!['upper', 'lower', 'legislature'].includes(chamber)) throw new HttpError(400, 'Choose a chamber.');
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
  const label = `${STATES[st]} ${chamber === 'upper' ? 'Senate' : chamber === 'legislature' ? 'Legislature' : 'House'}`;
  return { key: `os-${st.toLowerCase()}-${chamber}`, label, chamber: label, seats: members.length, asOf: day(new Date()), source: 'Open States', committees: [], members, juris: { level: 'state', state: st, chamber } };
}

// ---------- districts for an address ----------
const FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '72': 'PR' };
export const normDistrict = (d) => String(d == null ? '' : d).toLowerCase().replace(/district|no\.|#/g, '').replace(/\s+/g, ' ').trim().replace(/^0+(?=\d)/, '');
export async function districtsFor(cfg, address) {
  const a = clip(address, 200);
  if (a.length < 8) throw new HttpError(400, 'Enter your full street address, city and state or ZIP code.');
  const p = new URLSearchParams({ address: a, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'all', format: 'json' });
  const body = await getJson(`${cfg.geocoderBase}/geographies/onelineaddress?${p}`, { name: 'The Census address lookup' });
  const hit = body && body.result && (body.result.addressMatches || [])[0];
  if (!hit) throw new HttpError(404, 'That address was not found. Check the street and ZIP code, and use a home address rather than a P.O. box.');
  const g = hit.geographies || {}, layer = (re) => { const k = Object.keys(g).find((x) => re.test(x)); return k ? (g[k] || [])[0] : null; };
  const stRec = layer(/^States$/i), cdRec = layer(/Congressional Districts/i), up = layer(/Legislative Districts - Upper/i), low = layer(/Legislative Districts - Lower/i);
  const state = (stRec && stRec.STUSAB) || FIPS[(stRec || cdRec || up || low || {}).STATE] || '';
  let cd = '';
  if (cdRec) {
    const code = Object.entries(cdRec).find(([k]) => /^CD\d+$/i.test(k));
    const n = Number.parseInt(code ? code[1] : cdRec.BASENAME, 10);
    cd = !n || n === 98 ? 'AL' : String(n);
  }
  return { matched: hit.matchedAddress || a, state, cd, upper: up ? normDistrict(up.BASENAME || up.SLDU) : '', lower: low ? normDistrict(low.BASENAME || low.SLDL) : '' };
}
