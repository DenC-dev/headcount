import { HttpError } from './db.js';

// Bill lookup for briefs: Congress.gov for federal bills, Open States for state
// bills. Both need free API keys (see README). Results are normalized into the
// fields a bill brief shows.

const FED_TYPES = [
  ['hconres', 'H.Con.Res.', 'house-concurrent-resolution'], ['sconres', 'S.Con.Res.', 'senate-concurrent-resolution'],
  ['hjres', 'H.J.Res.', 'house-joint-resolution'], ['sjres', 'S.J.Res.', 'senate-joint-resolution'],
  ['hres', 'H.Res.', 'house-resolution'], ['sres', 'S.Res.', 'senate-resolution'],
  ['hr', 'H.R.', 'house-bill'], ['s', 'S.', 'senate-bill'],
];
export const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

export function currentCongress(d = new Date()) {
  const y = d.getUTCFullYear();
  // A new Congress convenes January 3 of odd years.
  const started = y % 2 === 1 && (d.getUTCMonth() > 0 || d.getUTCDate() >= 3) ? y : y % 2 === 1 ? y - 2 : y - 1;
  return Math.floor((started - 1789) / 2) + 1;
}

export function parseFederal(number) {
  const s = String(number || '').toLowerCase().replace(/[\s.]/g, '');
  for (const [code, label, slug] of FED_TYPES) {
    const m = new RegExp(`^${code}(\\d{1,5})$`).exec(s);
    if (m) return { type: code, number: Number(m[1]), label: `${label} ${Number(m[1])}`, slug };
  }
  return null;
}

export function parseState(number) {
  const m = /^([A-Za-z]{1,6})\.?\s*(\d{1,5})$/.exec(String(number || '').trim());
  return m ? `${m[1].toUpperCase()} ${Number(m[2])}` : null;
}

const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
export function stripHtml(html) {
  return String(html || '')
    .replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function getJson(url, headers) {
  let res;
  try { res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) }); }
  catch (_) { throw new HttpError(502, 'The bill database could not be reached. Try again shortly.'); }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The bill database rejected this server\'s API key.');
  if (res.status === 429) throw new HttpError(429, 'The bill database is rate limiting this server. Try again in a minute.');
  if (!res.ok) throw new HttpError(502, `The bill database returned an error (${res.status}).`);
  return res.json();
}

async function federal(cfg, number, congress) {
  if (!cfg.congressKey) throw new HttpError(501, 'Federal bill lookup is not set up on this server (CONGRESS_API_KEY).');
  const p = parseFederal(number);
  if (!p) throw new HttpError(400, 'Enter a federal bill number such as H.R. 1234, S. 56 or H.Res. 7.');
  const c = Number(congress) || currentCongress();
  if (c < 93 || c > currentCongress() + 1) throw new HttpError(400, 'That Congress number is out of range.');
  const base = `${cfg.congressBase}/bill/${c}/${p.type}/${p.number}`, h = { 'X-Api-Key': cfg.congressKey };
  const main = await getJson(`${base}?format=json`, h);
  if (!main || !main.bill) throw new HttpError(404, `${p.label} was not found in the ${ordinal(c)} Congress.`);
  const [sums, cmtes] = await Promise.all([
    getJson(`${base}/summaries?format=json`, h).catch(() => null),
    getJson(`${base}/committees?format=json`, h).catch(() => null),
  ]);
  const b = main.bill;
  const summaries = ((sums && sums.summaries) || []).slice().sort((x, y) => String(y.updateDate || y.actionDate || '').localeCompare(String(x.updateDate || x.actionDate || '')));
  const latest = summaries[0];
  return {
    source: 'Congress.gov',
    jurisdiction: 'U.S. Congress',
    session: `${ordinal(c)} Congress`,
    number: p.label,
    title: b.title || '',
    sponsors: (b.sponsors || []).map((s) => ({ name: s.fullName || [s.firstName, s.lastName].join(' '), party: s.party || '', district: [s.state, s.district].filter((x) => x !== undefined && x !== null && x !== '').join('-') })),
    cosponsors: (b.cosponsors && b.cosponsors.count) || 0,
    introduced: b.introducedDate || '',
    latestAction: b.latestAction ? { date: b.latestAction.actionDate || '', text: b.latestAction.text || '' } : null,
    committees: ((cmtes && cmtes.committees) || []).map((x) => x.name).filter(Boolean),
    subjects: b.policyArea && b.policyArea.name ? [b.policyArea.name] : [],
    officialSummary: latest ? stripHtml(latest.text) : '',
    officialSummaryLabel: latest ? `Congressional Research Service summary${latest.actionDesc ? ` (${latest.actionDesc})` : ''}` : '',
    url: `https://www.congress.gov/bill/${ordinal(c)}-congress/${p.slug}/${p.number}`,
    fetchedAt: new Date().toISOString(),
  };
}

async function state(cfg, st, number, session) {
  if (!cfg.openStatesKey) throw new HttpError(501, 'State bill lookup is not set up on this server (OPENSTATES_API_KEY).');
  const code = String(st || '').toUpperCase();
  if (!STATES[code]) throw new HttpError(400, 'Choose a state.');
  const ident = parseState(number);
  if (!ident) throw new HttpError(400, 'Enter a bill number such as HB 123 or SB 45.');
  const q = new URLSearchParams({ jurisdiction: `ocd-jurisdiction/country:us/state:${code.toLowerCase()}/government`, identifier: ident, sort: 'latest_action_desc', per_page: '1' });
  if (code === 'DC') q.set('jurisdiction', 'ocd-jurisdiction/country:us/district:dc/government');
  if (code === 'PR') q.set('jurisdiction', 'ocd-jurisdiction/country:us/territory:pr/government');
  if (session) q.set('session', String(session).slice(0, 20));
  for (const inc of ['sponsorships', 'abstracts', 'actions', 'sources']) q.append('include', inc);
  const body = await getJson(`${cfg.openStatesBase}/bills?${q}`, { 'X-API-KEY': cfg.openStatesKey });
  const b = body && body.results && body.results[0];
  if (!b) throw new HttpError(404, `${ident} was not found in ${STATES[code]}${session ? ` for session ${session}` : ''}.`);
  const actions = (b.actions || []).slice().sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
  const committees = [...new Set(actions.flatMap((a) => (a.related_entities || []).filter((e) => e.entity_type === 'organization').map((e) => e.name)).filter((n) => /committee/i.test(n)))].slice(0, 6);
  const abstract = (b.abstracts || []).map((a) => a.abstract).filter(Boolean)[0] || '';
  return {
    source: 'Open States',
    jurisdiction: `${STATES[code]} Legislature`,
    session: b.session || '',
    number: b.identifier || ident,
    title: b.title || '',
    sponsors: (b.sponsorships || []).filter((s) => s.primary !== false).slice(0, 8).map((s) => ({ name: s.name || '', party: (s.person && s.person.party) || '', district: (s.person && s.person.current_role && s.person.current_role.district) || '' })),
    cosponsors: (b.sponsorships || []).filter((s) => s.primary === false).length,
    introduced: b.first_action_date || '',
    latestAction: b.latest_action_description ? { date: b.latest_action_date || '', text: b.latest_action_description } : null,
    committees,
    subjects: (b.subject || []).slice(0, 6),
    officialSummary: stripHtml(abstract),
    officialSummaryLabel: abstract ? 'Legislative abstract' : '',
    url: b.openstates_url || ((b.sources || [])[0] || {}).url || '',
    fetchedAt: new Date().toISOString(),
  };
}

export async function lookupBill(cfg, { jurisdiction, number, session }) {
  const j = String(jurisdiction || '').toUpperCase();
  if (j === 'US') return federal(cfg, number, session);
  return state(cfg, j, number, session);
}
