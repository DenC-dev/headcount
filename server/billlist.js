import crypto from 'node:crypto';
import { HttpError, newId, clean } from './db.js';
import { STATES, parseFederal, parseState } from './bills.js';

// The workspace's bill list: every bill the team follows, not only the ones
// with a whip count. Each has the team's position (support, oppose, watch), a
// priority, a client and notes; the tracker follows each one, so the list shows
// where it stands, its next hearing and what moved. A list can be shared as a
// public read-only page (or embedded on a website) for clients and members.

export const POSITIONS = ['support', 'oppose', 'watch', 'amend'];
export const PRIORITIES = ['high', 'normal', 'low'];
const normNumber = (juris, n) => { if (juris === 'US') { const f = parseFederal(n); return f ? f.label : null; } return parseState(n); };

export function makeBillList(cfg, store, tracker) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_bills (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, juris TEXT NOT NULL, number TEXT NOT NULL, session TEXT NOT NULL DEFAULT '',
      title TEXT, position TEXT NOT NULL DEFAULT 'watch', priority TEXT NOT NULL DEFAULT 'normal', client_id TEXT, notes TEXT,
      added_by TEXT, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(org_id, juris, number, session));
    CREATE INDEX IF NOT EXISTS tracked_bills_org ON tracked_bills(org_id);
    CREATE TABLE IF NOT EXISTS bill_shares (
      token TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, client_id TEXT, title TEXT,
      created_by TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS bill_shares_org ON bill_shares(org_id);
  `);
  const p = (sql) => db.prepare(sql);
  const q = {
    list: p('SELECT * FROM tracked_bills WHERE org_id = ? ORDER BY added_at DESC'),
    one: p('SELECT * FROM tracked_bills WHERE id = ? AND org_id = ?'),
    find: p('SELECT * FROM tracked_bills WHERE org_id = ? AND juris = ? AND number = ? AND session = ?'),
    count: p('SELECT COUNT(*) AS n FROM tracked_bills WHERE org_id = ?'),
    add: p('INSERT INTO tracked_bills (id, org_id, juris, number, session, title, position, priority, client_id, notes, added_by, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: p('UPDATE tracked_bills SET title = ?, position = ?, priority = ?, client_id = ?, notes = ?, updated_at = ? WHERE id = ?'),
    remove: p('DELETE FROM tracked_bills WHERE id = ?'),
    setTitle: p("UPDATE tracked_bills SET title = ? WHERE id = ? AND (title IS NULL OR title = '')"),
    all: p('SELECT juris, number, session FROM tracked_bills'),
    shares: p('SELECT * FROM bill_shares WHERE org_id = ? ORDER BY created_at DESC'),
    share: p('SELECT * FROM bill_shares WHERE token = ?'),
    addShare: p('INSERT INTO bill_shares (token, org_id, client_id, title, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    dropShare: p('DELETE FROM bill_shares WHERE token = ? AND org_id = ?'),
  };
  const LIMIT = 500;

  // A bill row with where it stands, from the tracker's last reading.
  function out(r, { notes = true } = {}) {
    const t = tracker.todayFor({ bill: r.number, leg: r.juris, session: r.session }) || {};
    return { id: r.id, juris: r.juris, number: r.number, session: r.session || '', title: r.title || t.title || '', position: r.position, priority: r.priority,
      clientId: r.client_id || '', client: store.clientName(r.client_id), ...(notes ? { notes: r.notes || '' } : {}), addedAt: r.added_at, updatedAt: r.updated_at,
      now: t.now || '', where: t.where || '', hearings: t.hearings || [], news: (t.news || []).slice(-3), changedAt: t.changedAt || null, checkedAt: t.checkedAt || null };
  }
  // Campaign bills belong on the list too, with their whip count's side.
  function campaignRows(oid, uid) {
    return store.listOrgCampaigns(oid, uid).filter((c) => !c.archived && c.summary && c.summary.bill && c.summary.leg).map((c) => {
      const s = c.summary, t = tracker.todayFor(s) || {};
      return { id: `c:${c.id}`, campaignId: c.id, juris: s.leg, number: s.bill, session: s.session || '', title: c.name.replace(/^[^:]*:\s*/, ''), position: s.side === 'defeat' ? 'oppose' : 'support', priority: 'high',
        clientId: c.clientId || '', client: c.client || '', odds: typeof s.odds === 'number' ? s.odds : null, now: t.now || s.billStatus || '', where: t.where || '', hearings: t.hearings || [], news: (t.news || []).slice(-3), changedAt: t.changedAt || null, checkedAt: t.checkedAt || null };
    });
  }

  function list(oid, uid) {
    store.needOrg(oid, uid, 'member');
    const tracked = q.list.all(oid).map((r) => out(r));
    const seen = new Set(tracked.map((b) => `${b.juris}|${b.number}|${b.session}`));
    const fromCampaigns = campaignRows(oid, uid).filter((b) => !seen.has(`${b.juris}|${b.number}|${b.session}`));
    return { bills: [...fromCampaigns, ...tracked], shares: q.shares.all(oid).map(shareOut) };
  }

  function read(b) {
    const juris = String(b.juris || '').toUpperCase();
    if (juris !== 'US' && !STATES[juris]) throw new HttpError(400, 'Choose the legislature.');
    const number = normNumber(juris, b.number);
    if (!number) throw new HttpError(400, juris === 'US' ? 'Enter a bill number such as H.R. 1234 or S. 56.' : 'Enter a bill number such as HB 123 or SB 45.');
    const position = POSITIONS.includes(b.position) ? b.position : 'watch', priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
    return { juris, number, session: clean(b.session, 40) || '', title: clean(b.title, 400) || '', position, priority, clientId: clean(b.clientId, 40) || null, notes: clean(b.notes, 2000) || '' };
  }

  function add(oid, uid, body) {
    store.needOrg(oid, uid, 'member');
    const b = read(body || {});
    const dup = q.find.get(oid, b.juris, b.number, b.session);
    if (dup) return out(dup);
    if (q.count.get(oid).n >= LIMIT) throw new HttpError(413, `A workspace can follow up to ${LIMIT} bills. Remove some you no longer need.`);
    const id = newId('b'), now = Date.now();
    q.add.run(id, oid, b.juris, b.number, b.session, b.title, b.position, b.priority, b.clientId, b.notes, uid, now, now);
    // Read it now, so the list shows where it stands right away (best effort).
    tracker.story(b.juris, b.number, b.session).then((d) => { if (!b.title && d && d.title) q.setTitle.run(String(d.title).slice(0, 400), id); }).catch(() => {});
    return out(q.one.get(id, oid));
  }

  function update(oid, uid, id, body) {
    store.needOrg(oid, uid, 'member');
    const r = q.one.get(id, oid); if (!r) throw new HttpError(404, 'That bill is not on the list.');
    const b = body || {};
    q.update.run(b.title !== undefined ? clean(b.title, 400) : r.title, POSITIONS.includes(b.position) ? b.position : r.position, PRIORITIES.includes(b.priority) ? b.priority : r.priority,
      b.clientId !== undefined ? clean(b.clientId, 40) || null : r.client_id, b.notes !== undefined ? clean(b.notes, 2000) : r.notes, Date.now(), id);
    return out(q.one.get(id, oid));
  }

  function remove(oid, uid, id) {
    store.needOrg(oid, uid, 'member');
    if (!q.one.get(id, oid)) throw new HttpError(404, 'That bill is not on the list.');
    q.remove.run(id); return { ok: true };
  }

  // ---------- sharing ----------
  const shareUrl = (token) => `${cfg.publicUrl || ''}/bills/${token}`;
  const shareOut = (s) => ({ token: s.token, url: shareUrl(s.token), clientId: s.client_id || '', client: store.clientName(s.client_id), title: s.title || '', createdAt: s.created_at });
  function addShare(oid, uid, body) {
    store.needOrg(oid, uid, 'admin');
    const token = crypto.randomBytes(15).toString('base64url');
    q.addShare.run(token, oid, clean((body || {}).clientId, 40) || null, clean((body || {}).title, 120) || '', uid, Date.now());
    return shareOut(q.share.get(token));
  }
  function dropShare(oid, uid, token) { store.needOrg(oid, uid, 'admin'); q.dropShare.run(token, oid); return { ok: true }; }

  // What a shared page shows: the bills (for one client, if the link is for
  // a client), without the team's private notes.
  function publicList(token) {
    const s = q.share.get(String(token || '')); if (!s) throw new HttpError(404, 'This list is no longer shared.');
    const org = store.q.org.get(s.org_id); if (!org) throw new HttpError(404, 'This list is no longer shared.');
    const tracked = q.list.all(s.org_id).filter((r) => !s.client_id || r.client_id === s.client_id).map((r) => out(r, { notes: false }));
    const camps = store.q.orgCampaigns.all(s.org_id).filter((c) => !c.archived && c.summary && (!s.client_id || c.client_id === s.client_id)).map((c) => ({ ...c, summary: JSON.parse(c.summary) }))
      .filter((c) => c.summary.bill && c.summary.leg && !tracked.some((b) => b.juris === c.summary.leg && b.number === c.summary.bill))
      .map((c) => { const t = tracker.todayFor(c.summary) || {}; return { juris: c.summary.leg, number: c.summary.bill, session: c.summary.session || '', title: c.name.replace(/^[^:]*:\s*/, ''), position: c.summary.side === 'defeat' ? 'oppose' : 'support', priority: 'high', now: t.now || '', hearings: t.hearings || [], changedAt: t.changedAt || null }; });
    return { title: s.title || `${store.clientName(s.client_id) || org.name}: bills we follow`, org: org.name, client: store.clientName(s.client_id), bills: [...camps, ...tracked] };
  }

  // For the tracker: every tracked bill in every workspace.
  const allBills = () => q.all.all().map((r) => ({ juris: r.juris, number: r.number, session: r.session || '' }));
  return { list, add, update, remove, addShare, dropShare, publicList, allBills };
}
