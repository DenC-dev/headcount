import { HttpError } from './db.js';

// Product numbers for whoever runs Headcount: who signed up, who got to a
// first count, who came back. A small table of events, written by the server
// at the moments that matter (and a few the app reports), and summaries that
// answer "how many people used it last week?" without any outside service.

export const APP_EVENTS = new Set(['record_filled', 'meeting_requested', 'contact_logged', 'brief_viewed', 'story_viewed', 'search_used', 'fast_start']);
const DAY = 864e5, WEEK = 7 * DAY;
const day = (t) => new Date(t).toISOString().slice(0, 10);

export function makeMetrics(store) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, user_id TEXT, org_id TEXT, name TEXT NOT NULL, meta TEXT);
    CREATE INDEX IF NOT EXISTS events_name ON events(name, at);
    CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
    CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, email TEXT, name TEXT, page TEXT, message TEXT NOT NULL);
  `);
  const p = (sql) => db.prepare(sql);
  const q = {
    add: p('INSERT INTO events (at, day, user_id, org_id, name, meta) VALUES (?, ?, ?, ?, ?, ?)'),
    activeToday: p("SELECT 1 FROM events WHERE user_id = ? AND name = 'active' AND day = ? LIMIT 1"),
    once: p('SELECT 1 FROM events WHERE user_id = ? AND name = ? LIMIT 1'),
    distinctUsers: p('SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE name = ? AND at >= ? AND at < ?'),
    count: p('SELECT COUNT(*) AS n FROM events WHERE name = ? AND at >= ? AND at < ?'),
    signups: p("SELECT user_id, at FROM events WHERE name = 'signup' AND at >= ? ORDER BY at"),
    did: p('SELECT 1 FROM events WHERE user_id = ? AND name = ? LIMIT 1'),
    activeBetween: p("SELECT 1 FROM events WHERE user_id = ? AND name = 'active' AND at >= ? AND at < ? LIMIT 1"),
    addFeedback: p('INSERT INTO feedback (at, user_id, email, name, page, message) VALUES (?, ?, ?, ?, ?, ?)'),
    feedback: p('SELECT at, email, name, page, message FROM feedback ORDER BY id DESC LIMIT ?'),
    totals: p(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM orgs) AS workspaces, (SELECT COUNT(*) FROM campaigns WHERE archived = 0) AS campaigns`),
  };
  let lastDay = new Map(); // user -> day already marked active (saves a query per request)

  function track(name, { uid = null, oid = null, meta = null, once = false } = {}) {
    try {
      if (once && uid && q.once.get(uid, name)) return;
      const t = Date.now(); q.add.run(t, day(t), uid, oid, name, meta ? JSON.stringify(meta).slice(0, 500) : null);
    } catch (_) { /* numbers never break the app */ }
  }
  // Called on every signed-in request: one "active" event per person per day.
  function active(uid) {
    if (!uid) return; const d = day(Date.now());
    if (lastDay.get(uid) === d) return;
    if (lastDay.size > 5000) lastDay = new Map();
    lastDay.set(uid, d);
    if (!q.activeToday.get(uid, d)) { if (!q.once.get(uid, 'signup')) track('signup', { uid }); track('active', { uid }); }
  }
  function feedback(user, { message, page }) {
    const msg = String(message || '').trim().slice(0, 4000);
    if (msg.length < 3) throw new HttpError(400, 'Write a few words first.');
    q.addFeedback.run(Date.now(), user.id, user.email || '', user.name || '', String(page || '').slice(0, 60), msg);
    track('feedback', { uid: user.id });
    return { ok: true };
  }

  function summary(now = Date.now()) {
    const wk = (n, name) => q.distinctUsers.get(name, now - (n + 1) * WEEK, now - n * WEEK).n;
    const cnt = (n, name) => q.count.get(name, now - (n + 1) * WEEK, now - n * WEEK).n;
    const weeks = (name, distinct) => [0, 1].map((n) => (distinct ? wk(n, name) : cnt(n, name)));
    // Activation, for people who signed up in the last 60 days
    const recent = q.signups.all(now - 60 * DAY);
    const reached = (name) => recent.filter((s) => q.did.get(s.user_id, name)).length;
    const cameBack = recent.filter((s) => s.at < now - WEEK && q.activeBetween.get(s.user_id, s.at + DAY, now)).length;
    const funnel = [['Signed up', recent.length], ['Started a campaign', reached('campaign_created')], ['Filled a count from the record or logged a contact', recent.filter((s) => q.did.get(s.user_id, 'record_filled') || q.did.get(s.user_id, 'contact_logged')).length],
      ['Asked for a meeting', reached('meeting_requested')], ['Invited a teammate', reached('invite_created')], ['Came back after the first day', cameBack]];
    // Weekly cohorts: of those who signed up in a week, how many were active in each later week
    const cohorts = [];
    for (let w = 5; w >= 0; w--) {
      const from = now - (w + 1) * WEEK, to = now - w * WEEK, people = recent.filter((s) => s.at >= from && s.at < to);
      if (!people.length) { cohorts.push({ week: day(from), people: 0, kept: [] }); continue; }
      const kept = [];
      for (let k = 1; k <= w; k++) kept.push(Math.round((people.filter((s) => q.activeBetween.get(s.user_id, s.at + k * WEEK, s.at + (k + 1) * WEEK)).length / people.length) * 100));
      cohorts.push({ week: day(from), people: people.length, kept });
    }
    return {
      totals: q.totals.get(),
      weekly: { active: weeks('active', true), signups: weeks('signup', false), campaigns: weeks('campaign_created', false), contacts: weeks('contact_logged', false), meetings: weeks('meeting_requested', false), bills: weeks('bill_followed', false) },
      funnel, cohorts, feedback: q.feedback.all(20),
    };
  }
  // People who signed up a day or two ago and never started a campaign: one reminder, once.
  const stalled = p(`SELECT DISTINCT user_id FROM events WHERE name = 'signup' AND at >= ? AND at < ? AND user_id IS NOT NULL
    AND user_id NOT IN (SELECT user_id FROM events WHERE name IN ('campaign_created', 'nudged') AND user_id IS NOT NULL)`);
  const needNudge = (now = Date.now()) => stalled.all(now - 2 * DAY, now - 20 * 3600e3).map((r) => r.user_id);
  return { track, active, feedback, summary, needNudge };
}
