import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// One SQLite file holds everything. Campaign content is stored as small JSON
// records (one per member, task, meeting, plus meta, brief and trend) so that
// teammates editing different members never overwrite each other.

export const KINDS = new Set(['meta', 'brief', 'trend', 'members', 'tasks', 'meetings']);
export const SINGLE = new Set(['meta', 'brief', 'trend']);
export const LIMITS = { recordBytes: 200_000, recordsPerCampaign: 8000, opsPerBatch: 600, campaignsPerUser: 300, invitesPerCampaign: 50 };
const RANK = { viewer: 1, editor: 2, owner: 3 };

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, provider TEXT,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      rev INTEGER NOT NULL DEFAULT 0, records INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS access (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
      added_at INTEGER NOT NULL, PRIMARY KEY (campaign_id, user_id));
    CREATE INDEX IF NOT EXISTS access_user ON access(user_id);
    CREATE TABLE IF NOT EXISTS records (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, rid TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL,
      updated_by TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (campaign_id, kind, rid));
    CREATE INDEX IF NOT EXISTS records_rev ON records(campaign_id, rev);
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('editor','viewer')), created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 25);
    CREATE TABLE IF NOT EXISTS usage (
      user_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, kind));
  `);
  return new Store(db);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => Date.now();
const idOk = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(s);

class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      upsertUser: db.prepare(`INSERT INTO users (id, email, name, provider, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, provider = excluded.provider, last_seen = excluded.last_seen`),
      role: db.prepare('SELECT role FROM access WHERE campaign_id = ? AND user_id = ?'),
      campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?'),
      listMine: db.prepare(`SELECT c.id, c.name, c.updated_at, a.role, (SELECT COUNT(*) FROM access x WHERE x.campaign_id = c.id) AS people
        FROM access a JOIN campaigns c ON c.id = a.campaign_id WHERE a.user_id = ? ORDER BY c.updated_at DESC`),
      countOwned: db.prepare("SELECT COUNT(*) AS n FROM access WHERE user_id = ? AND role = 'owner'"),
      insertCampaign: db.prepare('INSERT INTO campaigns (id, owner, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
      insertAccess: db.prepare('INSERT INTO access (campaign_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id, user_id) DO UPDATE SET role = excluded.role'),
      deleteAccess: db.prepare('DELETE FROM access WHERE campaign_id = ? AND user_id = ?'),
      deleteCampaign: db.prepare('DELETE FROM campaigns WHERE id = ?'),
      allRecords: db.prepare('SELECT kind, rid, data, rev FROM records WHERE campaign_id = ? AND data IS NOT NULL'),
      changedRecords: db.prepare('SELECT kind, rid, data, rev FROM records WHERE campaign_id = ? AND rev > ? ORDER BY rev'),
      record: db.prepare('SELECT data FROM records WHERE campaign_id = ? AND kind = ? AND rid = ?'),
      putRecord: db.prepare(`INSERT INTO records (campaign_id, kind, rid, data, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, kind, rid) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
      bump: db.prepare('UPDATE campaigns SET rev = ?, records = ?, updated_at = ? WHERE id = ?'),
      rename: db.prepare('UPDATE campaigns SET name = ? WHERE id = ?'),
      liveCount: db.prepare('SELECT COUNT(*) AS n FROM records WHERE campaign_id = ? AND data IS NOT NULL'),
      people: db.prepare(`SELECT u.id, u.name, u.email, a.role FROM access a JOIN users u ON u.id = a.user_id WHERE a.campaign_id = ?
        ORDER BY CASE a.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`),
      insertInvite: db.prepare('INSERT INTO invites (code, campaign_id, role, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      invite: db.prepare('SELECT i.*, c.name AS campaign_name, u.name AS inviter FROM invites i JOIN campaigns c ON c.id = i.campaign_id LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?'),
      useInvite: db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?'),
      countInvites: db.prepare('SELECT COUNT(*) AS n FROM invites WHERE campaign_id = ? AND expires_at > ?'),
      revokeInvites: db.prepare('DELETE FROM invites WHERE campaign_id = ?'),
      ownedBy: db.prepare("SELECT campaign_id FROM access WHERE user_id = ? AND role = 'owner'"),
      successor: db.prepare("SELECT user_id FROM access WHERE campaign_id = ? AND user_id != ? AND role = 'editor' ORDER BY added_at LIMIT 1"),
      setOwner: db.prepare('UPDATE campaigns SET owner = ? WHERE id = ?'),
      deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
      getUsage: db.prepare('SELECT n FROM usage WHERE user_id = ? AND day = ? AND kind = ?'),
      addUsage: db.prepare('INSERT INTO usage (user_id, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, day, kind) DO UPDATE SET n = n + 1'),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  touchUser(u) {
    this.q.upsertUser.run(u.id, u.email || '', u.name || '', u.provider || '', now(), now());
  }

  role(cid, uid) {
    const r = this.q.role.get(cid, uid);
    return r ? r.role : null;
  }

  need(cid, uid, min) {
    const r = this.role(cid, uid);
    if (!r) throw new HttpError(404, 'Campaign not found, or you do not have access to it.');
    if (RANK[r] < RANK[min]) throw new HttpError(403, min === 'owner' ? 'Only the campaign owner can do that.' : 'You have view-only access to this campaign.');
    return r;
  }

  listCampaigns(uid) {
    return this.q.listMine.all(uid).map((r) => ({ id: r.id, name: r.name, role: r.role, people: r.people, updatedAt: r.updated_at }));
  }

  createCampaign(uid, id, name) {
    if (!idOk(id)) throw new HttpError(400, 'Campaign id is not valid.');
    return this.tx(() => {
      if (this.q.countOwned.get(uid).n >= LIMITS.campaignsPerUser) throw new HttpError(409, `You can keep up to ${LIMITS.campaignsPerUser} campaigns. Delete one to add another.`);
      if (this.q.campaign.get(id)) {
        if (this.role(id, uid) === 'owner') return { id, role: 'owner' };
        throw new HttpError(409, 'That campaign id is taken.');
      }
      this.q.insertCampaign.run(id, uid, String(name || '').slice(0, 140), now(), now());
      this.q.insertAccess.run(id, uid, 'owner', now());
      return { id, role: 'owner' };
    });
  }

  records(cid, uid, since) {
    const role = this.need(cid, uid, 'viewer');
    const c = this.q.campaign.get(cid);
    const rows = since > 0 ? this.q.changedRecords.all(cid, since) : this.q.allRecords.all(cid);
    return { role, cursor: c.rev, name: c.name, records: rows.map((r) => ({ kind: r.kind, id: r.rid, data: r.data === null ? null : JSON.parse(r.data), rev: r.rev })) };
  }

  write(cid, uid, ops) {
    if (!Array.isArray(ops) || !ops.length) throw new HttpError(400, 'No changes were sent.');
    if (ops.length > LIMITS.opsPerBatch) throw new HttpError(413, `Send at most ${LIMITS.opsPerBatch} changes at a time.`);
    const clean = ops.map((op) => {
      if (!op || !KINDS.has(op.kind)) throw new HttpError(400, 'Unknown record type.');
      const rid = SINGLE.has(op.kind) ? op.kind : op.id;
      if (!idOk(rid)) throw new HttpError(400, 'Record id is not valid.');
      if (op.data !== null && (typeof op.data !== 'object' || Array.isArray(op.data))) throw new HttpError(400, 'Record must be an object or null.');
      const json = op.data === null ? null : JSON.stringify(op.data);
      if (json && json.length > LIMITS.recordBytes) throw new HttpError(413, 'One record is too large.');
      return { kind: op.kind, rid, json, data: op.data };
    });
    return this.tx(() => {
      this.need(cid, uid, 'editor');
      const c = this.q.campaign.get(cid);
      let rev = c.rev, t = now();
      for (const op of clean) {
        rev += 1;
        this.q.putRecord.run(cid, op.kind, op.rid, op.json, rev, uid, t);
        if (op.kind === 'meta' && op.data && op.data.campaign) this.q.rename.run(String(op.data.campaign.bill || '').slice(0, 140), cid);
      }
      const count = this.q.liveCount.get(cid).n;
      if (count > LIMITS.recordsPerCampaign) throw new HttpError(413, `A campaign can hold up to ${LIMITS.recordsPerCampaign} records.`);
      this.q.bump.run(rev, count, t, cid);
      return { cursor: rev };
    });
  }

  removeCampaign(cid, uid) {
    const role = this.need(cid, uid, 'viewer');
    if (role === 'owner') this.q.deleteCampaign.run(cid);
    else this.q.deleteAccess.run(cid, uid);
    return { deleted: role === 'owner', left: role !== 'owner' };
  }

  people(cid, uid) {
    this.need(cid, uid, 'viewer');
    return this.q.people.all(cid).map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role, you: p.id === uid }));
  }

  setRole(cid, uid, target, role) {
    this.need(cid, uid, 'owner');
    if (target === uid) throw new HttpError(400, 'You cannot change your own role.');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be editor or viewer.');
    if (!this.role(cid, target)) throw new HttpError(404, 'That person is not on this campaign.');
    this.q.insertAccess.run(cid, target, role, now());
    return { ok: true };
  }

  removePerson(cid, uid, target) {
    if (target !== uid) this.need(cid, uid, 'owner');
    if (this.role(cid, target) === 'owner') throw new HttpError(400, 'The owner cannot be removed. Delete the campaign instead.');
    this.q.deleteAccess.run(cid, target);
    return { ok: true };
  }

  createInvite(cid, uid, role) {
    const mine = this.need(cid, uid, 'editor');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be editor or viewer.');
    if (role === 'editor' && mine !== 'owner' && mine !== 'editor') throw new HttpError(403, 'You cannot invite editors.');
    if (this.q.countInvites.get(cid, now()).n >= LIMITS.invitesPerCampaign) throw new HttpError(409, 'Too many open invitations. Revoke them and create a new one.');
    const code = crypto.randomBytes(16).toString('base64url');
    const expires = now() + 14 * 864e5;
    this.q.insertInvite.run(code, cid, role, uid, now(), expires, 25);
    return { code, role, expiresAt: expires };
  }

  revokeInvites(cid, uid) {
    this.need(cid, uid, 'owner');
    this.q.revokeInvites.run(cid);
    return { ok: true };
  }

  previewInvite(code) {
    const i = typeof code === 'string' && code.length < 64 ? this.q.invite.get(code) : null;
    if (!i || i.expires_at < now() || i.uses >= i.max_uses) throw new HttpError(404, 'This invitation has expired or was revoked. Ask for a new link.');
    return { campaign: i.campaign_name || 'Untitled campaign', role: i.role, invitedBy: i.inviter || 'A teammate', campaignId: i.campaign_id };
  }

  acceptInvite(code, uid) {
    return this.tx(() => {
      const p = this.previewInvite(code);
      const cur = this.role(p.campaignId, uid);
      if (!cur || RANK[cur] < RANK[p.role]) this.q.insertAccess.run(p.campaignId, uid, cur === 'owner' ? 'owner' : p.role, now());
      if (!cur) this.q.useInvite.run(code);
      return { campaignId: p.campaignId, role: this.role(p.campaignId, uid) };
    });
  }

  // Deleting an account removes the person everywhere. A campaign they own goes
  // to their longest-standing editor, or is deleted if nobody else edits it.
  deleteUser(uid) {
    return this.tx(() => {
      let transferred = 0, deleted = 0;
      for (const { campaign_id: cid } of this.q.ownedBy.all(uid)) {
        const next = this.q.successor.get(cid, uid);
        if (next) { this.q.insertAccess.run(cid, next.user_id, 'owner', now()); this.q.setOwner.run(next.user_id, cid); transferred++; }
        else { this.q.deleteCampaign.run(cid); deleted++; }
      }
      this.q.deleteUser.run(uid);
      return { transferred, deleted };
    });
  }

  // Counts one use of a metered feature; returns false once today's limit is reached.
  meter(uid, kind, limit) {
    const day = new Date().toISOString().slice(0, 10);
    const n = (this.q.getUsage.get(uid, day, kind) || { n: 0 }).n;
    if (n >= limit) return false;
    this.q.addUsage.run(uid, day, kind);
    return true;
  }
}
