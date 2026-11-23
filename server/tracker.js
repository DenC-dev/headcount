import { billRecord } from './record.js';

// Every bill a campaign is about is followed on its own: the server rereads
// its record every few hours, keeps the story (see story.js), and notes each
// new step so the campaign, the Today view and the digest can say "HB 2305 was
// sent to the Senate Finance committee". Free Open States keys allow few
// requests, so each bill is read at most every eight hours in the background
// and a handful are read per run.

export const billKey = (juris, number, session) => `${String(juris || '').toUpperCase()}|${String(number || '').toUpperCase().replace(/[\s.]/g, '')}|${session || ''}`;
const FRESH = 6 * 3600e3, EVERY = 8 * 3600e3, PER_RUN = 6;

export function makeTracker(cfg, store, { read = billRecord } = {}) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS bill_track (
      key TEXT PRIMARY KEY, juris TEXT NOT NULL, number TEXT NOT NULL, session TEXT, story TEXT, last_key TEXT,
      checked_at INTEGER, changed_at INTEGER, error TEXT);
    CREATE TABLE IF NOT EXISTS bill_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, found_at INTEGER NOT NULL, date TEXT, chamber TEXT, kind TEXT, plain TEXT, text TEXT);
    CREATE INDEX IF NOT EXISTS bill_news_key ON bill_news(key, found_at);
  `);
  const p = (sql) => db.prepare(sql);
  const q = {
    get: p('SELECT * FROM bill_track WHERE key = ?'),
    put: p(`INSERT INTO bill_track (key, juris, number, session, story, last_key, checked_at, changed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(key) DO UPDATE SET story = excluded.story, last_key = excluded.last_key, checked_at = excluded.checked_at, changed_at = COALESCE(excluded.changed_at, bill_track.changed_at), error = NULL`),
    failed: p(`INSERT INTO bill_track (key, juris, number, session, checked_at, error) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`),
    addNews: p('INSERT INTO bill_news (key, found_at, date, chamber, kind, plain, text) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    news: p('SELECT date, chamber, kind, plain, text, found_at AS foundAt FROM bill_news WHERE key = ? ORDER BY id DESC LIMIT ?'),
    newsSince: p('SELECT date, chamber, kind, plain, text, found_at AS foundAt FROM bill_news WHERE key = ? AND found_at >= ? ORDER BY id LIMIT 12'),
    campaigns: p("SELECT id, org_id, summary FROM campaigns WHERE archived = 0 AND summary IS NOT NULL"),
  };
  const stepKey = (t) => `${t.date}|${t.text}`;
  const compact = (r) => ({ bill: r.bill, title: r.title || '', source: r.source, origin: r.origin || '', now: r.now || '', stage: r.story.stage, stops: r.story.stops, floor: r.story.floor, hearings: r.story.hearings || [], timeline: r.story.timeline.slice(-120) });

  async function refresh(juris, number, session, now = Date.now()) {
    const key = billKey(juris, number, session), row = q.get.get(key);
    const data = compact(await read(cfg, { jurisdiction: juris, number, session }));
    const tl = data.timeline, last = tl.length ? stepKey(tl[tl.length - 1]) : '';
    let changed = null;
    if (row && row.story && row.last_key !== last) {
      const seen = new Set((JSON.parse(row.story).timeline || []).map(stepKey));
      const fresh = tl.filter((t) => !seen.has(stepKey(t)));
      for (const t of fresh) q.addNews.run(key, now, t.date, t.chamber, t.kind, t.plain, t.text);
      if (fresh.length) changed = now;
    }
    q.put.run(key, String(juris).toUpperCase(), number, session || '', JSON.stringify(data), last, now, changed);
    return data;
  }

  // The story for one bill: what was read in the last six hours, else read now.
  async function story(juris, number, session, { force = false } = {}) {
    const key = billKey(juris, number, session), row = q.get.get(key), now = Date.now();
    const out = (data, r) => ({ ...data, checkedAt: r ? r.checked_at : now, changedAt: r ? r.changed_at : null, news: q.news.all(key, 20) });
    if (row && row.story && !force && now - (row.checked_at || 0) < FRESH) return out(JSON.parse(row.story), row);
    try { const data = await refresh(juris, number, session, now); return out(data, q.get.get(key)); }
    catch (e) {
      if (row && row.story) return { ...out(JSON.parse(row.story), row), stale: e.message };
      throw e;
    }
  }

  // The bills of every active campaign, from each campaign's summary.
  function tracked() {
    const keys = new Map();
    for (const c of q.campaigns.all()) {
      let s; try { s = JSON.parse(c.summary); } catch (_) { continue; }
      if (!s || !s.bill || !s.leg) continue;
      const key = billKey(s.leg, s.bill, s.session);
      if (!keys.has(key)) keys.set(key, { juris: s.leg, number: s.bill, session: s.session || '', campaigns: [] });
      keys.get(key).campaigns.push(c.id);
    }
    // Bills on workspaces' bill lists, with no whip count of their own
    for (const source of sources) for (const b of source()) {
      const key = billKey(b.juris, b.number, b.session);
      if (!keys.has(key)) keys.set(key, { juris: b.juris, number: b.number, session: b.session || '', campaigns: [] });
    }
    return keys;
  }
  const sources = [];
  const addSource = (fn) => { sources.push(fn); };

  async function tick(now = Date.now()) {
    let n = 0;
    for (const [key, b] of tracked()) {
      if (n >= PER_RUN) break;
      if (b.juris === 'US' ? !cfg.congressKey : !cfg.openStatesKey) continue;
      const row = q.get.get(key); if (row && now - (row.checked_at || 0) < EVERY) continue;
      n++;
      try { await refresh(b.juris, b.number, b.session, now); }
      catch (e) { q.failed.run(key, String(b.juris).toUpperCase(), b.number, b.session, now, String(e.message || e).slice(0, 300)); if (e.status === 429) break; }
    }
    return n;
  }

  // New steps for a campaign's bill since a time, for digests and the Today view.
  function newsFor(summary, sinceMs) {
    if (!summary || !summary.bill || !summary.leg) return [];
    return q.newsSince.all(billKey(summary.leg, summary.bill, summary.session), sinceMs);
  }
  function stageFor(summary) {
    if (!summary || !summary.bill || !summary.leg) return null;
    const row = q.get.get(billKey(summary.leg, summary.bill, summary.session));
    if (!row || !row.story) return null;
    const s = JSON.parse(row.story);
    return { now: s.stage && s.stage.now, next: s.stage && s.stage.next, checkedAt: row.checked_at, changedAt: row.changed_at };
  }

  // For the Today view: where each bill is, its upcoming hearings and what
  // changed this week, from what was last read (nothing is fetched here).
  function todayFor(summary, now = Date.now()) {
    if (!summary || !summary.bill || !summary.leg) return null;
    const key = billKey(summary.leg, summary.bill, summary.session), row = q.get.get(key);
    if (!row || !row.story) return null;
    const s = JSON.parse(row.story), today = new Date(now - 864e5).toISOString().slice(0, 10);
    return { bill: s.bill || summary.bill, title: s.title || '', now: s.stage && s.stage.now, where: s.stage && s.stage.where, changedAt: row.changed_at, checkedAt: row.checked_at,
      hearings: (s.hearings || []).filter((h) => h.date >= today), news: q.newsSince.all(key, now - 7 * 864e5) };
  }
  return { story, refresh, tick, tracked, newsFor, stageFor, todayFor, addSource };
}
