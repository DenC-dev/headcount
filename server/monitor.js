import { HttpError, newId, clean, upgrade } from './db.js';
import { STATES } from './bills.js';
import * as src from './sources.js';

// The Monitor: saved searches ("watches") over new and updated bills in
// Congress and every state, Federal Register rules and notices, and SAM.gov
// contract opportunities. The server checks each watch on a schedule, keeps
// what it finds, scores it against the team's priorities (with Claude when it
// is set up, by keyword otherwise) and alerts people about what matters.

const KINDS = { bill: 'Bills', reg: 'Regulations', contract: 'Contracts' };
const ALERT_AT = 70;

export function makeMonitor(cfg, store, { score = null, aiOn = () => Boolean(score) } = {}) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL,
      query TEXT NOT NULL, states TEXT, agency TEXT, naics TEXT, priorities TEXT, client_id TEXT, paused INTEGER NOT NULL DEFAULT 0,
      created_by TEXT, created_at INTEGER NOT NULL, last_run INTEGER, last_error TEXT);
    CREATE INDEX IF NOT EXISTS watches_org ON watches(org_id);
    CREATE TABLE IF NOT EXISTS watch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, ext_id TEXT NOT NULL, number TEXT, title TEXT, juris TEXT, session TEXT, agency TEXT, doc_type TEXT,
      status TEXT, prev_status TEXT, status_date TEXT, date TEXT, deadline TEXT, url TEXT, summary TEXT, source TEXT, extra TEXT,
      score INTEGER, reason TEXT, state TEXT NOT NULL DEFAULT 'new', campaign_id TEXT, first_seen INTEGER NOT NULL, changed_at INTEGER, alerted INTEGER NOT NULL DEFAULT 0,
      UNIQUE(watch_id, ext_id));
    CREATE INDEX IF NOT EXISTS watch_items_org ON watch_items(org_id, first_seen);
  `);
  const p = (sql) => db.prepare(sql);
  const q = {
    watches: p('SELECT * FROM watches WHERE org_id = ? ORDER BY created_at'),
    watch: p('SELECT * FROM watches WHERE id = ? AND org_id = ?'),
    count: p('SELECT COUNT(*) AS n FROM watches WHERE org_id = ?'),
    insert: p('INSERT INTO watches (id, org_id, name, kind, query, states, agency, naics, priorities, client_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: p('UPDATE watches SET name = ?, query = ?, states = ?, agency = ?, naics = ?, priorities = ?, client_id = ?, paused = ? WHERE id = ?'),
    remove: p('DELETE FROM watches WHERE id = ?'),
    ran: p('UPDATE watches SET last_run = ?, last_error = ? WHERE id = ?'),
    due: p('SELECT * FROM watches WHERE paused = 0 AND (last_run IS NULL OR last_run <= ?) ORDER BY COALESCE(last_run, 0) LIMIT ?'),
    stats: p(`SELECT watch_id, COUNT(*) AS total, SUM(state = 'new') AS fresh, SUM(state = 'tracked') AS tracked FROM watch_items WHERE org_id = ? GROUP BY watch_id`),
    item: p('SELECT * FROM watch_items WHERE watch_id = ? AND ext_id = ?'),
    itemById: p('SELECT * FROM watch_items WHERE id = ? AND org_id = ?'),
    addItem: p(`INSERT INTO watch_items (org_id, watch_id, kind, ext_id, number, title, juris, session, agency, doc_type, status, status_date, date, deadline, url, summary, source, extra, first_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    moved: p('UPDATE watch_items SET prev_status = status, status = ?, status_date = ?, date = ?, changed_at = ?, alerted = 0 WHERE id = ?'),
    refresh: p('UPDATE watch_items SET title = ?, deadline = ?, date = ? WHERE id = ?'),
    setScore: p('UPDATE watch_items SET score = ?, reason = ? WHERE id = ?'),
    unscored: p('SELECT * FROM watch_items WHERE watch_id = ? AND score IS NULL ORDER BY id LIMIT 200'),
    setState: p('UPDATE watch_items SET state = ?, campaign_id = ? WHERE id = ?'),
    toAlert: p(`SELECT * FROM watch_items WHERE org_id = ? AND alerted = 0 AND state != 'dismissed'
      AND ((state = 'new' AND score >= ${ALERT_AT}) OR (state = 'tracked' AND changed_at IS NOT NULL)) ORDER BY score DESC LIMIT 40`),
    markAlerted: p('UPDATE watch_items SET alerted = 1 WHERE org_id = ? AND alerted = 0'),
    since: p(`SELECT i.*, w.name AS watch_name FROM watch_items i JOIN watches w ON w.id = i.watch_id WHERE i.org_id = ? AND i.state != 'dismissed'
      AND ((i.first_seen >= ? AND i.score >= 50) OR (i.state = 'tracked' AND i.changed_at >= ?)) ORDER BY i.score DESC LIMIT 12`),
  };
  const watchOut = (w, stats) => {
    const s = stats.get(w.id) || {};
    return { id: w.id, name: w.name, kind: w.kind, query: w.query, states: w.states ? JSON.parse(w.states) : [], agency: w.agency || '', naics: w.naics || '', priorities: w.priorities || '',
      clientId: w.client_id || '', client: store.clientName(w.client_id), paused: Boolean(w.paused), lastRun: w.last_run, lastError: w.last_error || '', total: s.total || 0, fresh: s.fresh || 0, tracked: s.tracked || 0 };
  };
  const itemOut = (i) => ({ id: i.id, watchId: i.watch_id, kind: i.kind, number: i.number, title: i.title, juris: i.juris, session: i.session, agency: i.agency, docType: i.doc_type,
    status: i.status, prevStatus: i.prev_status, statusDate: i.status_date, date: i.date, deadline: i.deadline, url: i.url, summary: i.summary, source: i.source,
    extra: i.extra ? JSON.parse(i.extra) : {}, score: i.score, reason: i.reason, state: i.state, campaignId: i.campaign_id, firstSeen: i.first_seen, changedAt: i.changed_at });

  function readWatch(b, existing) {
    const kind = existing ? existing.kind : String(b.kind || '');
    if (!KINDS[kind]) throw new HttpError(400, 'Choose bills, regulations or contracts.');
    const query = clean(b.query !== undefined ? b.query : existing && existing.query, 400);
    if (!src.phrases(query).length) throw new HttpError(400, 'Add at least one search term, for example "rural broadband".');
    let states = b.states !== undefined ? b.states : existing && existing.states ? JSON.parse(existing.states) : ['US'];
    states = (Array.isArray(states) ? states : String(states).split(',')).map((x) => String(x).trim().toUpperCase()).filter((x) => x === 'US' || x === 'ALL' || STATES[x]);
    if (kind === 'bill' && !states.length) throw new HttpError(400, 'Choose Congress, one or more states, or all of them.');
    const name = clean(b.name !== undefined ? b.name : existing && existing.name, 80) || src.phrases(query)[0];
    const naics = clean(b.naics !== undefined ? b.naics : existing && existing.naics, 6).replace(/\D/g, '');
    return { kind, query, name, states: kind === 'bill' ? [...new Set(states)].slice(0, 13) : [], agency: clean(b.agency !== undefined ? b.agency : existing && existing.agency, 120), naics,
      priorities: clean(b.priorities !== undefined ? b.priorities : existing && existing.priorities, 2000), clientId: b.clientId !== undefined ? String(b.clientId || '') : (existing && existing.client_id) || '',
      paused: b.paused !== undefined ? Boolean(b.paused) : Boolean(existing && existing.paused) };
  }
  function checkClient(oid, clientId) { if (clientId && (!store.q.client.get(clientId) || store.q.client.get(clientId).org_id !== oid)) throw new HttpError(400, 'Unknown client.'); }

  function list(oid, uid) {
    store.needOrg(oid, uid, 'member');
    const stats = new Map(q.stats.all(oid).map((r) => [r.watch_id, r]));
    return { watches: q.watches.all(oid).map((w) => watchOut(w, stats)), sources: { federal: Boolean(cfg.congressKey), states: Boolean(cfg.openStatesKey), regs: true, contracts: Boolean(cfg.samKey), ai: Boolean(score) && aiOn() } };
  }
  async function create(oid, uid, b) {
    store.needOrg(oid, uid, 'member');
    const plan = store.plan(oid);
    if (q.count.get(oid).n >= plan.watches) throw upgrade(`This plan allows ${plan.watches} watches. Upgrade to watch more.`);
    const w = readWatch(b); checkClient(oid, w.clientId);
    const id = newId('m');
    q.insert.run(id, oid, w.name, w.kind, w.query, JSON.stringify(w.states), w.agency || null, w.naics || null, w.priorities || null, w.clientId || null, uid, Date.now());
    store.log(oid, uid, 'watch.created', w.name);
    // Look right away, but answer within a few seconds even if a source is slow.
    await Promise.race([run(q.watch.get(id, oid)).catch(() => {}), new Promise((r) => setTimeout(r, 12000).unref())]);
    return list(oid, uid).watches.find((x) => x.id === id);
  }
  function update(oid, uid, wid, b) {
    store.needOrg(oid, uid, 'member');
    const cur = q.watch.get(wid, oid); if (!cur) throw new HttpError(404, 'Watch not found.');
    const w = readWatch(b, cur); checkClient(oid, w.clientId);
    q.update.run(w.name, w.query, JSON.stringify(w.states), w.agency || null, w.naics || null, w.priorities || null, w.clientId || null, w.paused ? 1 : 0, wid);
    return list(oid, uid).watches.find((x) => x.id === wid);
  }
  function remove(oid, uid, wid) {
    store.needOrg(oid, uid, 'member');
    const cur = q.watch.get(wid, oid); if (!cur) throw new HttpError(404, 'Watch not found.');
    q.remove.run(wid); store.log(oid, uid, 'watch.deleted', cur.name);
    return { ok: true };
  }
  async function runNow(oid, uid, wid) {
    store.needOrg(oid, uid, 'member');
    const w = q.watch.get(wid, oid); if (!w) throw new HttpError(404, 'Watch not found.');
    return run(w);
  }

  function items(oid, uid, f) {
    store.needOrg(oid, uid, 'member');
    const where = ['org_id = ?'], args = [oid];
    const view = ['new', 'tracked', 'dismissed', 'all'].includes(f.view) ? f.view : 'new';
    if (view === 'all') where.push("state != 'dismissed'"); else { where.push('state = ?'); args.push(view); }
    if (f.watch) { where.push('watch_id = ?'); args.push(String(f.watch)); }
    if (KINDS[f.kind]) { where.push('kind = ?'); args.push(f.kind); }
    if (f.q) { where.push('(title LIKE ? OR number LIKE ? OR agency LIKE ?)'); const like = `%${String(f.q).slice(0, 80).replace(/[%_]/g, '')}%`; args.push(like, like, like); }
    const min = Number(f.min) || 0; if (min) { where.push('COALESCE(score, 0) >= ?'); args.push(min); }
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 100));
    const rows = db.prepare(`SELECT * FROM watch_items WHERE ${where.join(' AND ')} ORDER BY ${view === 'tracked' ? 'COALESCE(changed_at, first_seen) DESC' : 'first_seen DESC, COALESCE(score, 0) DESC'} LIMIT ${limit}`).all(...args);
    return { items: rows.map(itemOut) };
  }
  function setItem(oid, uid, iid, b) {
    store.needOrg(oid, uid, 'member');
    const it = q.itemById.get(Number(iid), oid); if (!it) throw new HttpError(404, 'Item not found.');
    const state = b.state !== undefined ? String(b.state) : it.state;
    if (!['new', 'tracked', 'dismissed'].includes(state)) throw new HttpError(400, 'Unknown state.');
    let cid = b.campaignId !== undefined ? String(b.campaignId || '') : it.campaign_id;
    if (cid) { const c = store.q.campaign.get(cid); if (!c || c.org_id !== oid || !store.campaignRole(cid, uid)) throw new HttpError(400, 'Unknown campaign.'); }
    q.setState.run(state, cid || null, it.id);
    return itemOut(q.itemById.get(it.id, oid));
  }

  // ---------- checking a watch ----------
  async function fetchFor(w, since) {
    const states = w.states ? JSON.parse(w.states) : [], errors = [], out = [];
    const tryIt = async (fn) => { try { out.push(...await fn()); } catch (e) { errors.push(e.message || String(e)); } };
    if (w.kind === 'bill') {
      const all = states.includes('ALL');
      if (all || states.includes('US')) await tryIt(async () => (await src.congressUpdated(cfg, since)).filter((b) => src.matches(b.title, w.query)));
      const st = states.filter((x) => STATES[x]);
      if (all || st.length) await tryIt(() => src.stateBills(cfg, { states: all ? 'all' : st, q: w.query, since }));
    } else if (w.kind === 'reg') await tryIt(() => src.federalRegister(cfg, { q: w.query, since, agency: w.agency }));
    else await tryIt(() => src.samOpportunities(cfg, { q: w.query, since, naics: w.naics }));
    return { found: out, error: errors.join(' ') };
  }
  const keywordScore = (w, it) => {
    const text = `${it.title} ${it.summary || ''} ${it.agency || ''}`.toLowerCase(), hits = src.phrases(w.query).filter((x) => text.includes(x.toLowerCase())).length;
    return hits ? { score: Math.min(90, 55 + hits * 15), reason: 'Matches your search terms.' } : { score: 40, reason: 'Found by the source\'s own search; your terms are not in the title.' };
  };

  async function run(w, nowMs = Date.now()) {
    const since = new Date(w.last_run ? w.last_run - 864e5 : nowMs - (w.kind === 'bill' ? 7 : 14) * 864e5);
    const { found, error } = await fetchFor(w, since);
    let added = 0, changed = 0;
    store.tx(() => {
      for (const it of found) {
        const cur = q.item.get(w.id, it.extId);
        if (!cur) {
          q.addItem.run(w.org_id, w.id, it.kind, it.extId, it.number || '', it.title || '', it.juris || '', it.session || '', it.agency || '', it.docType || '', it.status || '', it.statusDate || '', it.date || '', it.deadline || '', it.url || '', it.summary || '', it.source || '', JSON.stringify({ naics: it.naics || undefined, agencyTop: it.agencyTop || undefined }), nowMs);
          added++;
        } else if (it.status && it.status !== cur.status) { q.moved.run(it.status, it.statusDate || '', it.date || cur.date, nowMs, cur.id); changed++; }
        else q.refresh.run(it.title || cur.title, it.deadline || cur.deadline, it.date || cur.date, cur.id);
      }
    });
    const todo = q.unscored.all(w.id);
    if (todo.length) {
      let scored = new Map();
      if (score && aiOn() && store.meterGlobal('screen', (cfg.aiDailyLimit || 200) * 5)) {
        const client = store.clientName(w.client_id);
        for (let i = 0; i < todo.length; i += 25) {
          try {
            const batch = todo.slice(i, i + 25).map((x) => ({ id: String(x.id), number: x.number, title: x.title, agency: x.agency, juris: x.juris, docType: x.doc_type, status: x.status, summary: x.summary }));
            for (const s of await score({ watch: w, client, items: batch })) scored.set(Number(s.id), s);
          } catch (e) { console.error('Monitor scoring failed', e.message); break; }
        }
      }
      for (const x of todo) { const s = scored.get(x.id) || keywordScore(w, x); q.setScore.run(s.score, s.reason, x.id); }
    }
    q.ran.run(nowMs, error || null, w.id);
    alerts(w.org_id);
    return { added, changed, error };
  }

  // People who chose instant alerts get an email now; everyone else sees it in their digest.
  let onAlert = () => {};
  function alerts(oid) {
    const rows = q.toAlert.all(oid);
    if (!rows.length) return 0;
    q.markAlerted.run(oid);
    const watches = new Map(q.watches.all(oid).map((w) => [w.id, w.name]));
    onAlert({ org: store.q.org.get(oid), items: rows.map((r) => ({ ...itemOut(r), watchName: watches.get(r.watch_id) || '' })) });
    return rows.length;
  }

  let running = false;
  async function tick(nowMs = Date.now(), max = 20) {
    if (running) return 0;
    running = true; let n = 0;
    try {
      for (const w of q.due.all(nowMs - cfg.monitorEvery, max * 3)) {
        if (n >= max) break;
        if (w.kind === 'contract' && w.last_run && w.last_run > nowMs - Math.max(cfg.monitorEvery, cfg.samEvery || 0)) continue;
        try { await run(w, nowMs); } catch (e) { q.ran.run(nowMs, String(e.message || e).slice(0, 300), w.id); }
        n++;
      }
    }
    finally { running = false; }
    return n;
  }

  // For the digest: what is new in a workspace since a date.
  const forDigest = (oid, sinceMs) => q.since.all(oid, sinceMs, sinceMs).map((r) => ({ ...itemOut(r), watchName: r.watch_name }));

  return { list, create, update, remove, runNow, items, setItem, run, tick, forDigest, setAlertHandler: (fn) => { onAlert = fn; }, KINDS };
}

export function describeItem(i) {
  const head = [i.number, i.title].filter(Boolean).join(': ');
  if (i.state === 'tracked' && i.changedAt) return `${head}: now "${i.status}"`;
  const where = i.kind === 'bill' ? (i.juris === 'US' ? 'Congress' : STATES[i.juris] || i.juris) : i.agency;
  return `${head}${where ? ` (${where})` : ''}${i.deadline ? `, ${i.kind === 'reg' ? 'comments due' : 'responses due'} ${i.deadline}` : ''}`;
}
