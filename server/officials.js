// Current members and their staff, read from the official sources:
//   Florida Senate   flsenate.gov senator pages (name, party, district, email,
//                    offices, phones, legislative aides)
//   Florida House    flhouse.gov member pages (name, party, district, offices,
//                    phones, legislative and district aides)
//   U.S. House       directory.house.gov, the House's own staff directory
//                    (every staffer's name, job title and direct phone)
// None of these publish staff email addresses. Each chamber uses one standard
// format, so Headcount writes the address in that format and marks it as such
// ("f": 1) for people to confirm; published addresses are never marked.

const UA = 'Mozilla/5.0 (compatible; Headcount roster refresh; +https://github.com/DenC-dev/headcount)';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { tries = 3 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      return await res.text();
    } catch (e) { if (i + 1 >= tries) throw e; await pause(1500 * (i + 1)); }
  }
}
// A few pages at a time, politely.
async function each(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); await pause(150); } }));
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s) => String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));
// Page text as trimmed lines, without scripts, styles or markup.
export function lines(html) {
  return decode(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n'))
    .split('\n').map((l) => l.replace(/[\s ]+/g, ' ').trim()).filter(Boolean);
}
const PHONE = /\(?(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})/;
export const phone = (s) => { const m = PHONE.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
// The lines of an office block: address lines up to and including its phone number.
function block(ls, heading) {
  const i = ls.findIndex((l) => l.toLowerCase() === heading.toLowerCase());
  if (i < 0) return null;
  const addr = []; let ph = '';
  for (let j = i + 1; j < Math.min(ls.length, i + 9); j++) {
    if (PHONE.test(ls[j]) && /^\(?\d{3}/.test(ls[j])) { ph = phone(ls[j]); break; }
    if (/^(Map|Senate VOIP|Legislative Aide|District Aide|Satellite Office|Tallahassee Office|District Office|Capitol Office)/i.test(ls[j])) break;
    addr.push(ls[j]);
  }
  return { address: addr.join(', ').replace(/\s+,/g, ','), phone: ph };
}
// "Ann Lee, Bo Diaz, and Cy Park" -> ["Ann Lee", "Bo Diaz", "Cy Park"]
// Pages say "Legislative Aide: None" or "Vacant" when there is nobody; those are not people.
const NOBODY = /^(none|vacant|tbd|tba|n\/?a|to be (announced|determined)|position vacant|unassigned)\.?$/i;
export const splitNames = (s) => String(s || '').split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter((x) => /\p{L}/u.test(x) && !NOBODY.test(x));

// ---------- standard email formats ----------
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z-]/g, '').toLowerCase();
const SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|md|esq)\.?$/i;
const HONORIFIC = /\b(dr|rev|hon|mr|mrs|ms)\.\s*/gi;
// "Mooney Jr., James Vernon "Jim"" -> "Jim Mooney Jr."; "Bush III, Dr. James" -> "James Bush III"
export function preferredName(sortName) {
  const s = String(sortName || ''), cut = s.indexOf(',');
  if (cut < 0) return s.replace(HONORIFIC, '').replace(/\s+/g, ' ').trim();
  const lastWords = s.slice(0, cut).trim().split(/\s+/), rest = s.slice(cut + 1);
  const nick = /["“]([^"”]+)["”]/.exec(rest);
  const firsts = rest.replace(/["“][^"”]*["”]/g, ' ').replace(HONORIFIC, '').trim().split(/\s+/).filter(Boolean);
  const suffix = lastWords.filter((w) => SUFFIX.test(w)), last = lastWords.filter((w) => !SUFFIX.test(w)).join(' ');
  return [nick ? nick[1] : firsts[0], last, ...suffix].filter(Boolean).join(' ');
}
// "First Middle Last" (or "Last, First Middle") -> { first, last }
export function nameParts(name) {
  let s = String(name || '').replace(/["“”][^"“”]*["“”]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(HONORIFIC, '').trim();
  let first, last;
  if (s.includes(',')) {
    const [l, ...rest] = s.split(',').map((x) => x.trim());
    const r = rest.filter((x) => !SUFFIX.test(x)).join(' ').split(/\s+/).filter(Boolean);
    last = l.split(/\s+/).filter((x) => !SUFFIX.test(x)).join(''); first = r[0] || '';
  } else {
    const w = s.split(/\s+/).filter((x) => x && !SUFFIX.test(x.replace(/,$/, '')));
    first = w[0] || ''; last = w[w.length - 1] || '';
  }
  return { first: plain(first), last: plain(last) };
}
export const EMAIL_FORMAT = {
  ushouse: (n) => { const p = nameParts(n); return p.first && p.last ? `${p.first}.${p.last}@mail.house.gov` : ''; },
  flhouse: (n) => { const p = nameParts(n); return p.first && p.last ? `${p.first}.${p.last}@flhouse.gov` : ''; },
  flsenate: (n) => { const p = nameParts(n); return p.first && p.last ? `${p.last}.${p.first}@flsenate.gov` : ''; },
  flsenator: (n) => { const p = nameParts(n); return p.first && p.last ? `${p.last}.${p.first}.web@flsenate.gov` : ''; },
};

// ---------- Florida Senate ----------
export function parseSenateList(html) {
  const out = [];
  const re = /<a class="senatorLink" href="(\/Senators\/[\d-]+\/S(\d+))"[^>]*>\s*<img[^>]*alt="Senator ([^"]+)"[^>]*>\s*([^<]+)<\/a>[\s\S]*?<td class="middle">(\d+)<\/td>\s*<td class="middle">([^<]+)<\/td>/g;
  for (let m; (m = re.exec(html));) out.push({ path: `/Senators/s${m[2]}`, display: decode(m[3]).replace(/\s+/g, ' ').trim(), sortName: decode(m[4]).trim(), district: m[5], party: /^Rep/i.test(m[6]) ? 'R' : /^Dem/i.test(m[6]) ? 'D' : 'I' });
  return out;
}
export function parseSenator(html) {
  const ls = lines(html), email = (String(html).match(/[\w.-]+\.web@flsenate\.gov/i) || [''])[0].toLowerCase();
  const dist = block(ls, 'District Office'), tal = block(ls, 'Tallahassee Office');
  const ai = ls.findIndex((l) => /^Legislative Aides?$/i.test(l));
  return { email, district: dist, capitol: tal, aides: ai >= 0 ? splitNames(ls[ai + 1]) : [] };
}
export async function floridaSenate(base = 'https://www.flsenate.gov') {
  const list = parseSenateList(await get(`${base}/Senators/`));
  if (list.length < 35) throw new Error(`The Florida Senate list had ${list.length} senators, expected 40.`);
  return each(list, 4, async (s) => {
    const d = parseSenator(await get(base + s.path));
    const derived = !d.email;
    return { n: s.display, p: s.party, d: s.district, ph: d.capitol ? d.capitol.phone : '', of: d.capitol ? d.capitol.address : '',
      em: d.email || EMAIL_FORMAT.flsenator(s.display), ...(derived ? { emf: 1 } : {}), dph: d.district ? d.district.phone : '', dof: d.district ? d.district.address : '',
      url: `${base}/Senators/s${s.district}`, staff: d.aides.map((a) => ({ n: a, t: 'Legislative Aide', em: EMAIL_FORMAT.flsenate(a), f: 1 })) };
  });
}

// ---------- Florida House ----------
export function parseHouseList(html) {
  const out = [], seen = new Set();
  const re = /href="(\/Sections\/Representatives\/details\.aspx\?MemberId=(\d+)&(?:amp;)?LegislativeTermId=(\d+))"[\s\S]*?<h5>\s*([^<]+?)\s*<\/h5>\s*<p>\s*(\w+)[^<]*<span[^>]*>District:\s*(\d+)<\/span>/g;
  for (let m; (m = re.exec(html));) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    out.push({ path: decode(m[1]), id: m[2], term: m[3], sortName: decode(m[4]).replace(/\s+/g, ' ').trim(), party: /^Rep/i.test(m[5]) ? 'R' : /^Dem/i.test(m[5]) ? 'D' : 'I', district: m[6] });
  }
  return out;
}
export function parseRepresentative(html) {
  const ls = lines(html);
  const ai = ls.findIndex((l) => l === 'All Members');
  const display = ai >= 0 ? `${ls[ai + 1]} ${ls[ai + 2]}`.replace(/\s+/g, ' ').trim() : '';
  const staff = [];
  ls.forEach((l, i) => { const m = /^(Legislative|District) Aides?:$/i.exec(l); if (m) splitNames(ls[i + 1]).forEach((n) => staff.push({ n, t: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} Aide` })); });
  return { display, capitol: block(ls, 'Capitol Office'), district: block(ls, 'District Office'), staff };
}
export async function floridaHouse(base = 'https://www.flhouse.gov') {
  const list = parseHouseList(await get(`${base}/representatives`));
  if (list.length < 100) throw new Error(`The Florida House list had ${list.length} members, expected 120.`);
  return each(list, 4, async (r) => {
    const html = await get(base + r.path), d = parseRepresentative(html);
    // Some member pages keep the offices on their "Contact Member" page.
    if (!d.capitol) {
      const link = /href="(\/Sections\/Representatives\/contactmember\.aspx\?[^"]+)"/i.exec(html);
      if (link) { const c = parseRepresentative(await get(base + decode(link[1]))); d.capitol = c.capitol; d.district = c.district; }
    }
    const display = preferredName(r.sortName), surname = r.sortName.split(',')[0];
    // The House gives each district's Capitol office the number 850-717-50xx
    // (5000 plus the district); new members' pages may not list it yet.
    const capPhone = d.capitol && d.capitol.phone, usual = `850-717-${String(5000 + Number(r.district))}`;
    return { n: display, p: r.party, d: r.district, ph: capPhone || usual, ...(capPhone ? {} : { phf: 1 }), of: d.capitol ? d.capitol.address : '402 South Monroe Street, Tallahassee, FL 32399-1300',
      em: EMAIL_FORMAT.flhouse(`${surname}, ${display.split(' ')[0]}`), emf: 1, dph: d.district ? d.district.phone : '', dof: d.district ? d.district.address : '',
      url: `${base}/Sections/Representatives/details.aspx?MemberId=${r.id}&LegislativeTermId=${r.term}`,
      staff: d.staff.map((s) => ({ ...s, em: EMAIL_FORMAT.flhouse(s.n), f: 1 })) };
  });
}

// ---------- U.S. House staff ----------
export function parseHouseDirectory(html) {
  const grab = (name) => {
    const m = new RegExp(`angular\\.module\\("employeeDirectory"\\)\\.value\\("${name}",\\s*`).exec(html);
    if (!m) return null;
    const s = html.slice(m.index + m[0].length);
    // the value is a JSON array; find where it ends by bracket depth, outside strings
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '[' || c === '{') depth++; else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return end > 0 ? JSON.parse(s.slice(0, end)) : null;
  };
  const staff = grab('employees') || [];
  const byOffice = {};
  for (const e of staff) {
    const id = e.worksFor && e.worksFor._id;
    if (!id || !/^[A-Z]{2}\d{2}$/.test(id)) continue; // a member's Washington office; district offices add a digit
    const st = id.slice(0, 2), n = Number(id.slice(2)), key = `${st}-${n === 0 ? 'AL' : n}`;
    const p = nameParts(e.name);
    const display = String(e.name || '').includes(',') ? `${e.name.split(',').slice(1).join(' ').trim()} ${e.name.split(',')[0].trim()}`.replace(/\s+/g, ' ') : e.name;
    (byOffice[key] ||= []).push({ n: display, t: String(e.jobTitle || '').replace(/\bOf\b/g, 'of').trim(), ph: phone(e.telephone), em: p.first && p.last ? EMAIL_FORMAT.ushouse(e.name) : '', f: 1 });
  }
  return byOffice;
}
export async function houseStaff(base = 'https://directory.house.gov') {
  const byOffice = parseHouseDirectory(await get(`${base}/`));
  if (Object.keys(byOffice).length < 400) throw new Error(`The House staff directory listed ${Object.keys(byOffice).length} member offices, expected about 440.`);
  return byOffice;
}

// ---------- putting it together ----------
const lastName = (n) => nameParts(n).last;
// Same district, same last name and same first initial: the same member.
const who = (m) => { const p = nameParts(m.n); return `${m.d}|${p.last}|${p.first.slice(0, 1)}`; };
// Keeps each returning member's key, so campaigns already counting them stay linked.
// A returning member also keeps a published email address over one written in
// the standard format.
function keepKeys(prev, next, prefix) {
  const old = new Map((prev || []).map((m) => [who(m), m]));
  return next.map((m) => {
    const o = old.get(who(m));
    const keepEmail = o && o.em && m.emf;
    const { emf, ...rest } = m;
    return { k: o ? o.k : `${prefix}-${m.d}-${lastName(m.n)}`, ...rest, em: keepEmail ? o.em : m.em, ...(m.emf && !keepEmail ? { emf: 1 } : {}) };
  });
}
// Staff people reach first for a meeting come first.
const RANK = [/schedul/i, /executive assistant/i, /director of operations|operations director|director - operations/i, /chief of staff/i, /legislative director/i, /legislative aide/i, /district aide/i];
const rank = (t) => { const i = RANK.findIndex((r) => r.test(t || '')); return i < 0 ? RANK.length : i; };
const sortStaff = (list) => [...list].sort((a, b) => rank(a.t) - rank(b.t));

// Staff files are compact: { asOf, source, people: { memberKey: [[name, title, phone, email]] } }.
// Every email in them is written in the chamber's usual format.
export const STAFF_SOURCES = { ushouse: 'U.S. House staff directory (directory.house.gov)', flhouse: 'Florida House member pages (flhouse.gov)', flsenate: 'Florida Senate senator pages (flsenate.gov)' };
export function staffFiles(staff) {
  return Object.fromEntries(Object.entries(staff.chambers).map(([key, byMember]) => [key, { asOf: staff.asOf, source: STAFF_SOURCES[key], emailNote: 'Emails follow the chamber\'s usual format; confirm before relying on them.',
    people: Object.fromEntries(Object.entries(byMember).map(([k, list]) => [k, list.map((s) => [s.n, s.t || '', s.ph || '', s.em || ''])])) }]));
}

// Returns updated presets and a staff file; leaves out any source that failed.
export async function refreshOfficials(bundled, { log = () => {}, sources = {} } = {}) {
  const today = new Date().toISOString().slice(0, 10), presets = JSON.parse(JSON.stringify(bundled.presets)), staff = { asOf: today, chambers: {} }, report = [];
  const run = async (name, fn) => { try { const r = await fn(); report.push(`${name}: ok`); return r; } catch (e) { report.push(`${name}: ${e.message}`); log(`${name} failed: ${e.message}`); return null; } };
  const fls = await run('Florida Senate', () => (sources.flsenate || floridaSenate)());
  if (fls) {
    const members = keepKeys(presets.flsenate && presets.flsenate.members, fls, 'fls');
    staff.chambers.flsenate = Object.fromEntries(members.filter((m) => m.staff.length).map((m) => [m.k, sortStaff(m.staff)]));
    presets.flsenate = { label: 'Florida Senate', chamber: 'Florida Senate', seats: 40, asOf: today, source: 'Florida Senate (flsenate.gov)', members: members.map(({ staff: _, ...m }) => m), committees: [] };
  }
  const flh = await run('Florida House', () => (sources.flhouse || floridaHouse)());
  if (flh) {
    const members = keepKeys(presets.flhouse && presets.flhouse.members, flh, 'flh');
    staff.chambers.flhouse = Object.fromEntries(members.filter((m) => m.staff.length).map((m) => [m.k, sortStaff(m.staff)]));
    presets.flhouse = { label: 'Florida House', chamber: 'Florida House of Representatives', seats: 120, asOf: today, source: 'Florida House (flhouse.gov)', members: members.map(({ staff: _, ...m }) => m), committees: [] };
  }
  const hs = await run('U.S. House staff', () => (sources.houseStaff || houseStaff)());
  if (hs && presets.ushouse) staff.chambers.ushouse = Object.fromEntries(presets.ushouse.members.filter((m) => hs[m.d]).map((m) => [m.k, sortStaff(hs[m.d])]));
  return { presets, staff, report };
}
