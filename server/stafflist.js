import { HttpError } from './db.js';

// A workspace's own staff list, such as a contact export from LegiStorm,
// which the firm licenses. An admin uploads it once; every campaign in the
// workspace then shows those staff, with their real email addresses, ahead of
// the official lists (which have no emails). The rows stay on the server and
// only the staff matching a campaign's members are sent to the browser.

const MAX_ROWS = 60000;
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const word = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const SUFFIX = /\b(jr|sr|ii|iii|iv|md|phd|esq)\b/g;
const lastOf = (name) => { const p = word(name).replace(SUFFIX, '').trim().split(' ').filter(Boolean); return p[p.length - 1] || ''; };
const firstOf = (name) => word(name).split(' ')[0] || '';
// The person to ask for a meeting first: the scheduler, then the people who run the office.
const RANKS = ['scheduler', 'executive assistant', 'director of operations', 'chief of staff', 'legislative director', 'legislative aide', 'district aide'];
const rank = (title) => { const t = word(title); const i = RANKS.findIndex((r) => t.includes(r)); return i < 0 ? RANKS.length : i; };

// Two-letter codes, names and the newspaper abbreviations offices often use (R-Fla.)
const STATES = 'AL Alabama Ala|AK Alaska Alaska|AZ Arizona Ariz|AR Arkansas Ark|CA California Calif|CO Colorado Colo|CT Connecticut Conn|DE Delaware Del|FL Florida Fla|GA Georgia Ga|HI Hawaii Hawaii|ID Idaho Idaho|IL Illinois Ill|IN Indiana Ind|IA Iowa Iowa|KS Kansas Kan|KY Kentucky Ky|LA Louisiana La|ME Maine Maine|MD Maryland Md|MA Massachusetts Mass|MI Michigan Mich|MN Minnesota Minn|MS Mississippi Miss|MO Missouri Mo|MT Montana Mont|NE Nebraska Neb|NV Nevada Nev|NH New_Hampshire NH|NJ New_Jersey NJ|NM New_Mexico NM|NY New_York NY|NC North_Carolina NC|ND North_Dakota ND|OH Ohio Ohio|OK Oklahoma Okla|OR Oregon Ore|PA Pennsylvania Pa|RI Rhode_Island RI|SC South_Carolina SC|SD South_Dakota SD|TN Tennessee Tenn|TX Texas Texas|UT Utah Utah|VT Vermont Vt|VA Virginia Va|WA Washington Wash|WV West_Virginia W_Va|WI Wisconsin Wis|WY Wyoming Wyo|DC District_of_Columbia DC|PR Puerto_Rico PR|GU Guam Guam|VI Virgin_Islands VI|AS American_Samoa AS|MP Northern_Mariana_Islands MP'
  .split('|').map((x) => x.split(' ').map((y) => word(y.replace(/_/g, ' '))));
const stateWords = (code) => { const s = STATES.find((x) => x[0] === word(code)); return s ? [...new Set(s)] : [word(code)]; };
const has = (text, w) => Boolean(w) && ` ${text} `.includes(` ${w} `);

// Column names vary between exports; these cover LegiStorm's and most others.
const COLS = {
  name: ['name', 'full name', 'staff name', 'staffer', 'contact name', 'person'],
  first: ['first name', 'first', 'given name'], last: ['last name', 'last', 'surname', 'family name'],
  title: ['title', 'job title', 'position', 'staff title', 'role'],
  email: ['email', 'email address', 'e mail', 'work email', 'official email'],
  phone: ['phone', 'phone number', 'office phone', 'work phone', 'telephone', 'direct phone'],
  office: ['office', 'member', 'office name', 'member name', 'legislator', 'boss', 'employer', 'organization', 'committee', 'member office', 'works for', 'official'],
  state: ['state', 'member state', 'office state'], district: ['district', 'member district'], chamber: ['chamber', 'body', 'house senate', 'legislature'],
};
export function readStaffCsvHeader(head) {
  const h = head.map((x) => word(x));
  const find = (names) => { for (const n of names) { const i = h.indexOf(word(n)); if (i >= 0) return i; } for (const n of names) { const i = h.findIndex((x) => x.includes(word(n))); if (i >= 0) return i; } return -1; };
  return Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, find(names)]));
}

export function makeStaffLists(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS staff_lists (
    org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE, source TEXT NOT NULL, rows TEXT NOT NULL,
    n INTEGER NOT NULL, by_id TEXT, by_name TEXT, at INTEGER NOT NULL)`);
  const q = {
    get: store.db.prepare('SELECT * FROM staff_lists WHERE org_id = ?'),
    meta: store.db.prepare('SELECT source, n, by_name, at FROM staff_lists WHERE org_id = ?'),
    put: store.db.prepare('INSERT INTO staff_lists (org_id, source, rows, n, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET source = excluded.source, rows = excluded.rows, n = excluded.n, by_id = excluded.by_id, by_name = excluded.by_name, at = excluded.at'),
    del: store.db.prepare('DELETE FROM staff_lists WHERE org_id = ?'),
  };
  const cache = new Map(); // org -> { at, index }
  const metaOut = (r) => (r ? { source: r.source, count: r.n, by: r.by_name || '', at: r.at } : null);

  function info(oid, uid) { store.needOrg(oid, uid, 'member'); return { list: metaOut(q.meta.get(oid)) }; }

  // rows: [name, title, email, phone, office, state, district, chamber]
  function save(oid, user, body) {
    store.needOrg(oid, user.id, 'admin');
    const rows = body && Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) throw new HttpError(400, 'That file has no staff in it.');
    if (rows.length > MAX_ROWS) throw new HttpError(400, `Upload up to ${MAX_ROWS.toLocaleString('en-US')} staff at a time.`);
    const out = [];
    for (const r of rows) {
      if (!Array.isArray(r)) continue;
      const x = [clean(r[0], 100), clean(r[1], 120), clean(r[2], 160).toLowerCase(), clean(r[3], 40), clean(r[4], 200), clean(r[5], 40), clean(r[6], 20), clean(r[7], 40)];
      if (!x[0] || !x[4]) continue; // a name and whose office it is
      if (x[2] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x[2])) x[2] = '';
      out.push(x);
    }
    if (!out.length) throw new HttpError(400, 'No rows had both a staff name and the office they work for. Check the file has those columns.');
    const source = clean(body.source, 60) || 'LegiStorm';
    q.put.run(oid, source, JSON.stringify(out), out.length, user.id, clean(user.name, 80), Date.now());
    cache.delete(oid);
    store.log(oid, user.id, 'staff_list.upload', source, `${out.length} staff`);
    return { list: metaOut(q.meta.get(oid)), skipped: rows.length - out.length };
  }
  function remove(oid, uid) { store.needOrg(oid, uid, 'admin'); q.del.run(oid); cache.delete(oid); store.log(oid, uid, 'staff_list.remove', '', ''); return { list: null }; }

  function indexFor(oid) {
    const r = q.get.get(oid); if (!r) return null;
    const hit = cache.get(oid); if (hit && hit.at === r.at) return hit;
    const byLast = new Map();
    for (const row of JSON.parse(r.rows)) {
      const office = word(row[4]);
      for (const w of new Set(office.split(' '))) { if (w.length < 2) continue; if (!byLast.has(w)) byLast.set(w, []); byLast.get(w).push(row); }
    }
    const ix = { at: r.at, source: r.source, byLast };
    cache.set(oid, ix); if (cache.size > 50) cache.delete(cache.keys().next().value);
    return ix;
  }

  // Which rows belong to each member: the office names the member's last name,
  // and the state and chamber agree when the file gives them. If two different
  // offices could be the member's, the first name decides, or nothing is guessed.
  function match(oid, uid, body) {
    store.needOrg(oid, uid, 'member');
    const ix = indexFor(oid); if (!ix) return { list: null, staff: {} };
    const members = Array.isArray(body && body.members) ? body.members.slice(0, 1000) : [];
    const chamber = word(body && body.chamber), level = word(body && body.level), st0 = clean(body && body.state, 4);
    const chamberWords = chamber === 'upper' ? ['senate', 'senator', 'sen'] : chamber === 'lower' ? ['house', 'assembly', 'delegates', 'rep', 'representative', 'assemblymember', 'delegate'] : [];
    const staff = {};
    for (const m of members) {
      const last = lastOf(m.name), first = firstOf(m.name); if (!last) continue;
      const district = clean(m.district, 12), state = (/^[A-Z]{2}\b/.exec(district) || [])[0] || st0;
      const sw = state ? stateWords(state) : [];
      let rows = (ix.byLast.get(last) || []).filter((row) => {
        const office = word(row[4]);
        if (state && row[5] && !sw.includes(word(row[5])) && word(row[5]) !== word(state)) return false;
        if (state && !row[5] && /\(|-/.test(row[4]) && !sw.some((w) => has(office, w))) return false; // "(R-Fla.)"-style offices name the state
        if (chamberWords.length && row[7] && !chamberWords.some((w) => has(word(row[7]), w))) return false;
        if (level === 'us' && row[7] && /state|assembly/.test(word(row[7]))) return false;
        if (level === 'state' && row[7] && /\b(congress|u s|us house|us senate)\b/.test(word(row[7]))) return false;
        if (row[6] && district && !/^[A-Z]{2}$/.test(district) && word(row[6]).replace(/^0+/, '') !== word(district.replace(/^[A-Z]{2}-?/, '')).replace(/^0+/, '') && !/^(at large|al|0)$/.test(word(row[6]))) return false;
        return true;
      });
      const offices = [...new Set(rows.map((r) => word(r[4])))];
      if (offices.length > 1 && first) { const f = rows.filter((r) => has(word(r[4]), first)); if (f.length) rows = f; }
      if (new Set(rows.map((r) => word(r[4]))).size !== 1) continue;
      staff[m.id] = rows.slice().sort((a, b) => rank(a[1]) - rank(b[1])).slice(0, 40).map((r) => [r[0], r[1], r[3], r[2]]);
    }
    return { list: { source: ix.source, at: ix.at }, staff };
  }
  return { info, save, remove, match };
}
