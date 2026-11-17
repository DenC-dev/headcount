import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { effectivePlan } from './plans.js';

// One SQLite file holds everything.
//
// A workspace (organization) is a firm, team or advocacy group. People belong
// to it as owner, admin, member or guest; owners, admins and members use paid
// seats, guests (clients, coalition partners) do not. Campaigns belong to a
// workspace and are open either to every member or only to the people added.
// Campaign content is stored as small JSON records (one per member, task and
// meeting, plus meta, brief, trend and summary) so that teammates editing
// different members never overwrite each other.

export const KINDS = new Set(['meta', 'brief', 'trend', 'summary', 'members', 'tasks', 'meetings']);
export const SINGLE = new Set(['meta', 'brief', 'trend', 'summary']);
export const LIMITS = { recordBytes: 200_000, recordsPerCampaign: 8000, opsPerBatch: 600, orgsPerUser: 20, invitesPerOrg: 200, invitesPerCampaign: 50, clientsPerOrg: 500 };
const ORANK = { guest: 0, member: 1, admin: 2, owner: 3 };
const CRANK = { viewer: 1, editor: 2, owner: 3 };
const SEAT_ROLES = "('owner','admin','member')";
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'yandex.com', 'mail.com', 'hey.com', 'fastmail.com']);
export const CONTACT_TYPES = new Set(['Meeting', 'Call', 'Email', 'Event', 'Constituent push']);

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const upgrade = (message) => new HttpError(402, message, { upgrade: true });

const now = () => Date.now();
const idOk = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(s);
const newId = (p) => p + crypto.randomBytes(9).toString('base64url');
const month = () => new Date().toISOString().slice(0, 7);
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function openDb(file, cfg = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, provider TEXT,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'team', status TEXT NOT NULL DEFAULT 'trialing',
      trial_ends INTEGER, seats INTEGER NOT NULL DEFAULT 0, period_end INTEGER,
      stripe_customer TEXT, stripe_subscription TEXT, stripe_item TEXT,
      domain TEXT, domain_token TEXT, domain_verified INTEGER NOT NULL DEFAULT 0, domain_join INTEGER NOT NULL DEFAULT 0,
      created_by TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS orgs_customer ON orgs(stripe_customer);
    CREATE INDEX IF NOT EXISTS orgs_domain ON orgs(domain);
    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
      added_at INTEGER NOT NULL, PRIMARY KEY (org_id, user_id));
    CREATE INDEX IF NOT EXISTS org_members_user ON org_members(user_id);
    CREATE TABLE IF NOT EXISTS org_invites (
      code TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin','member','guest')), email TEXT, created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 25);
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS clients_org ON clients(org_id);
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
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, at INTEGER NOT NULL,
      actor TEXT, actor_name TEXT, action TEXT NOT NULL, target TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS audit_org ON audit(org_id, id);
    CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      digest TEXT NOT NULL DEFAULT 'weekly', notify_assigned INTEGER NOT NULL DEFAULT 1, notify_added INTEGER NOT NULL DEFAULT 1,
      tz TEXT, digest_hour INTEGER NOT NULL DEFAULT 8, last_digest TEXT);
    CREATE TABLE IF NOT EXISTS email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, text_body TEXT NOT NULL, html_body TEXT,
      kind TEXT NOT NULL, user_id TEXT, reply_to TEXT, unsubscribe TEXT, dedupe TEXT UNIQUE,
      created_at INTEGER NOT NULL, next_at INTEGER NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS email_due ON email_queue(sent_at, next_at);
    CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT, email TEXT, firm TEXT, size TEXT, message TEXT);
  `);
  const orgCols = new Set(db.prepare('PRAGMA table_info(orgs)').all().map((c) => c.name));
  for (const [col, def] of Object.entries({ sso_provider: 'TEXT', sso_required: 'INTEGER NOT NULL DEFAULT 0', trial_notice: 'INTEGER NOT NULL DEFAULT 0' })) if (!orgCols.has(col)) db.exec(`ALTER TABLE orgs ADD COLUMN ${col} ${def}`);
  // Columns added in version 2; older databases get them here.
  const have = new Set(db.prepare('PRAGMA table_info(campaigns)').all().map((c) => c.name));
  const add = { org_id: 'TEXT REFERENCES orgs(id) ON DELETE CASCADE', client_id: 'TEXT', visibility: "TEXT NOT NULL DEFAULT 'org'", archived: 'INTEGER NOT NULL DEFAULT 0', summary: 'TEXT', created_by: 'TEXT' };
  for (const [col, def] of Object.entries(add)) if (!have.has(col)) db.exec(`ALTER TABLE campaigns ADD COLUMN ${col} ${def}`);
  db.exec('CREATE INDEX IF NOT EXISTS campaigns_org ON campaigns(org_id)');
  const store = new Store(db, { billing: false, trialDays: 14, trialSeats: 10, ...cfg });
  store.migrateV1();
  return store;
}

class Store {
  constructor(db, cfg) {
    this.db = db; this.cfg = cfg;
    const p = (sql) => db.prepare(sql);
    this.q = {
      upsertUser: p(`INSERT INTO users (id, email, name, provider, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, provider = excluded.provider, last_seen = excluded.last_seen`),
      user: p('SELECT * FROM users WHERE id = ?'),
      // workspaces
      org: p('SELECT * FROM orgs WHERE id = ?'),
      orgRole: p('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'),
      myOrgs: p(`SELECT o.*, m.role AS my_role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name`),
      createdOrgs: p('SELECT COUNT(*) AS n FROM orgs WHERE created_by = ?'),
      insertOrg: p('INSERT INTO orgs (id, name, plan, status, trial_ends, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      renameOrg: p('UPDATE orgs SET name = ? WHERE id = ?'),
      deleteOrg: p('DELETE FROM orgs WHERE id = ?'),
      putMember: p('INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role'),
      dropMember: p('DELETE FROM org_members WHERE org_id = ? AND user_id = ?'),
      members: p(`SELECT u.id, u.name, u.email, m.role, m.added_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name`),
      seatsUsed: p(`SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role IN ${SEAT_ROLES}`),
      guestsUsed: p("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'guest'"),
      owners: p("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner'"),
      successor: p(`SELECT user_id FROM org_members WHERE org_id = ? AND user_id != ? AND role IN ('admin','member') ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, added_at LIMIT 1`),
      orgsOwnedBy: p("SELECT org_id FROM org_members WHERE user_id = ? AND role = 'owner'"),
      dropOrgAccess: p('DELETE FROM access WHERE user_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE org_id = ?)'),
      // workspace invitations
      insertOrgInvite: p('INSERT INTO org_invites (code, org_id, role, email, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      orgInvite: p('SELECT i.*, o.name AS org_name, u.name AS inviter FROM org_invites i JOIN orgs o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?'),
      orgInvites: p('SELECT i.code, i.role, i.email, i.created_at, i.expires_at, i.uses, i.max_uses, u.name AS inviter FROM org_invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.org_id = ? AND i.expires_at > ? AND i.uses < i.max_uses ORDER BY i.created_at DESC'),
      countOrgInvites: p('SELECT COUNT(*) AS n FROM org_invites WHERE org_id = ? AND expires_at > ?'),
      useOrgInvite: p('UPDATE org_invites SET uses = uses + 1 WHERE code = ?'),
      dropOrgInvite: p('DELETE FROM org_invites WHERE code = ? AND org_id = ?'),
      // clients
      clients: p('SELECT id, name, archived, created_at FROM clients WHERE org_id = ? ORDER BY archived, name'),
      client: p('SELECT * FROM clients WHERE id = ?'),
      countClients: p('SELECT COUNT(*) AS n FROM clients WHERE org_id = ?'),
      insertClient: p('INSERT INTO clients (id, org_id, name, created_at) VALUES (?, ?, ?, ?)'),
      updateClient: p('UPDATE clients SET name = ?, archived = ? WHERE id = ?'),
      deleteClient: p('DELETE FROM clients WHERE id = ?'),
      unsetClient: p('UPDATE campaigns SET client_id = NULL WHERE client_id = ?'),
      // campaigns
      campaign: p('SELECT * FROM campaigns WHERE id = ?'),
      orgCampaigns: p('SELECT c.*, (SELECT COUNT(*) FROM access a WHERE a.campaign_id = c.id) AS people FROM campaigns c WHERE c.org_id = ? ORDER BY c.archived, c.updated_at DESC'),
      activeCampaigns: p('SELECT COUNT(*) AS n FROM campaigns WHERE org_id = ? AND archived = 0'),
      insertCampaign: p('INSERT INTO campaigns (id, owner, name, org_id, client_id, visibility, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      setCampaign: p('UPDATE campaigns SET client_id = ?, visibility = ?, archived = ?, updated_at = ? WHERE id = ?'),
      deleteCampaign: p('DELETE FROM campaigns WHERE id = ?'),
      role: p('SELECT role FROM access WHERE campaign_id = ? AND user_id = ?'),
      putAccess: p('INSERT INTO access (campaign_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id, user_id) DO UPDATE SET role = excluded.role'),
      dropAccess: p('DELETE FROM access WHERE campaign_id = ? AND user_id = ?'),
      allRecords: p('SELECT kind, rid, data, rev FROM records WHERE campaign_id = ? AND data IS NOT NULL'),
      recordsOf: p('SELECT rid, data FROM records WHERE campaign_id = ? AND kind = ? AND data IS NOT NULL'),
      changedRecords: p('SELECT kind, rid, data, rev FROM records WHERE campaign_id = ? AND rev > ? ORDER BY rev'),
      putRecord: p(`INSERT INTO records (campaign_id, kind, rid, data, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, kind, rid) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
      bump: p('UPDATE campaigns SET rev = ?, records = ?, updated_at = ? WHERE id = ?'),
      rename: p('UPDATE campaigns SET name = ? WHERE id = ?'),
      mirrorClient: p('UPDATE campaigns SET client_id = ? WHERE id = ?'),
      saveSummary: p('UPDATE campaigns SET summary = ? WHERE id = ?'),
      liveCount: p('SELECT COUNT(*) AS n FROM records WHERE campaign_id = ? AND data IS NOT NULL'),
      people: p(`SELECT u.id, u.name, u.email, a.role FROM access a JOIN users u ON u.id = a.user_id WHERE a.campaign_id = ?
        ORDER BY CASE a.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`),
      // campaign invitations (bring in guests or add people to a closed campaign)
      insertInvite: p('INSERT INTO invites (code, campaign_id, role, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      invite: p('SELECT i.*, c.name AS campaign_name, c.org_id, o.name AS org_name, u.name AS inviter FROM invites i JOIN campaigns c ON c.id = i.campaign_id JOIN orgs o ON o.id = c.org_id LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?'),
      useInvite: p('UPDATE invites SET uses = uses + 1 WHERE code = ?'),
      countInvites: p('SELECT COUNT(*) AS n FROM invites WHERE campaign_id = ? AND expires_at > ?'),
      revokeInvites: p('DELETE FROM invites WHERE campaign_id = ?'),
      // domains, billing, usage, audit
      orgByDomain: p('SELECT * FROM orgs WHERE domain = ? AND domain_verified = 1'),
      setDomain: p('UPDATE orgs SET domain = ?, domain_token = ?, domain_verified = ?, domain_join = ? WHERE id = ?'),
      setDomainJoin: p('UPDATE orgs SET domain_join = ? WHERE id = ?'),
      orgByCustomer: p('SELECT * FROM orgs WHERE stripe_customer = ?'),
      setCustomer: p('UPDATE orgs SET stripe_customer = ? WHERE id = ?'),
      setBilling: p('UPDATE orgs SET plan = ?, status = ?, seats = ?, period_end = ?, stripe_customer = ?, stripe_subscription = ?, stripe_item = ? WHERE id = ?'),
      seenEvent: p('SELECT id FROM stripe_events WHERE id = ?'),
      markEvent: p('INSERT INTO stripe_events (id, at) VALUES (?, ?)'),
      getUsage: p('SELECT n FROM usage WHERE user_id = ? AND day = ? AND kind = ?'),
      addUsage: p('INSERT INTO usage (user_id, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, day, kind) DO UPDATE SET n = n + 1'),
      audit: p('INSERT INTO audit (org_id, at, actor, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      auditPage: p('SELECT * FROM audit WHERE org_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
      deleteUser: p('DELETE FROM users WHERE id = ?'),
      // email
      setting: p('SELECT value FROM settings WHERE key = ?'),
      putSetting: p('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'),
      prefs: p('SELECT * FROM user_prefs WHERE user_id = ?'),
      putPrefs: p(`INSERT INTO user_prefs (user_id, digest, notify_assigned, notify_added, tz, digest_hour) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET digest = excluded.digest, notify_assigned = excluded.notify_assigned, notify_added = excluded.notify_added, tz = excluded.tz, digest_hour = excluded.digest_hour`),
      setLastDigest: p('INSERT INTO user_prefs (user_id, last_digest) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_digest = excluded.last_digest'),
      digestUsers: p(`SELECT u.id, u.email, u.name, COALESCE(p.digest, 'weekly') AS digest, COALESCE(p.tz, 'UTC') AS tz, COALESCE(p.digest_hour, 8) AS digest_hour, p.last_digest
        FROM users u LEFT JOIN user_prefs p ON p.user_id = u.id WHERE u.email != '' AND COALESCE(p.digest, 'weekly') != 'off'`),
      enqueue: p(`INSERT INTO email_queue (to_addr, subject, text_body, html_body, kind, user_id, reply_to, unsubscribe, dedupe, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe) DO NOTHING`),
      dueEmails: p('SELECT * FROM email_queue WHERE sent_at IS NULL AND attempts < 10 AND next_at <= ? ORDER BY id LIMIT ?'),
      sentEmail: p('UPDATE email_queue SET sent_at = ?, error = NULL WHERE id = ?'),
      failedEmail: p('UPDATE email_queue SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?'),
      outbox: p('SELECT id, to_addr, subject, text_body, kind, created_at, sent_at, unsubscribe, reply_to FROM email_queue ORDER BY id DESC LIMIT ?'),
      addLead: p('INSERT INTO leads (at, name, email, firm, size, message) VALUES (?, ?, ?, ?, ?, ?)'),
      admins: p("SELECT u.id, u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role IN ('owner','admin') AND u.email != ''"),
      trialEnding: p('SELECT * FROM orgs WHERE trial_ends BETWEEN ? AND ? AND stripe_subscription IS NULL AND trial_notice = 0'),
      trialNoticed: p('UPDATE orgs SET trial_notice = 1 WHERE id = ?'),
      record: p('SELECT data FROM records WHERE campaign_id = ? AND kind = ? AND rid = ?'),
      userOrgs: p('SELECT o.*, m.role AS my_role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?'),
      setSso: p('UPDATE orgs SET sso_provider = ?, sso_required = ? WHERE id = ?'),
      orgBySso: p('SELECT * FROM orgs WHERE sso_provider = ?'),
    };
    this.notify = () => {};
  }

  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTx = true;
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.inTx = false; }
  }

  // Databases from version 1 had campaigns without workspaces: each owner gets
  // a workspace, and the people they shared with become guests on that campaign.
  migrateV1() {
    const orphans = this.db.prepare('SELECT id, owner FROM campaigns WHERE org_id IS NULL').all();
    if (!orphans.length) return;
    this.tx(() => {
      const made = new Map();
      for (const c of orphans) {
        let oid = made.get(c.owner);
        if (!oid) {
          const u = this.q.user.get(c.owner) || { name: 'My' };
          oid = newId('w'); made.set(c.owner, oid);
          this.q.insertOrg.run(oid, `${clean(u.name, 60) || 'My'}'s workspace`, 'team', this.cfg.billing ? 'trialing' : 'active', this.cfg.billing ? now() + this.cfg.trialDays * 864e5 : null, c.owner, now());
          this.q.putMember.run(oid, c.owner, 'owner', now());
        }
        this.db.prepare("UPDATE campaigns SET org_id = ?, visibility = 'team', created_by = owner WHERE id = ?").run(oid, c.id);
        for (const a of this.db.prepare('SELECT user_id FROM access WHERE campaign_id = ? AND user_id != ?').all(c.id, c.owner)) {
          if (!this.q.orgRole.get(oid, a.user_id)) this.q.putMember.run(oid, a.user_id, 'guest', now());
        }
      }
    });
  }

  touchUser(u) { this.q.upsertUser.run(u.id, u.email || '', u.name || '', u.provider || '', now(), now()); }

  log(oid, actorId, action, target, detail) {
    const u = actorId ? this.q.user.get(actorId) : null;
    this.q.audit.run(oid, now(), actorId || null, u ? u.name || u.email : actorId ? '' : 'Billing', action, target ? String(target).slice(0, 200) : null, detail ? JSON.stringify(detail).slice(0, 2000) : null);
  }

  // ---------- workspaces ----------
  orgRole(oid, uid) { const r = this.q.orgRole.get(oid, uid); return r ? r.role : null; }
  ssoBlocked(org, uid, role) {
    if (!org || !org.sso_required || !org.sso_provider || role === 'guest' || role === 'owner') return false;
    const u = this.q.user.get(uid); return !u || u.provider !== org.sso_provider;
  }
  ssoError(org) { return new HttpError(403, `${org.name} requires single sign-on. Sign in with your firm's SSO to continue.`, { sso: true, workspace: org.name }); }
  needOrg(oid, uid, min) {
    const r = this.orgRole(oid, uid), org = this.q.org.get(oid);
    if (!r || !org) throw new HttpError(404, 'Workspace not found, or you are not a member.');
    if (this.ssoBlocked(org, uid, r)) throw this.ssoError(org);
    if (ORANK[r] < ORANK[min]) throw new HttpError(403, min === 'owner' ? 'Only a workspace owner can do that.' : min === 'admin' ? 'Only workspace admins can do that.' : 'Guests cannot do that.');
    return r;
  }
  plan(oid) { return effectivePlan(this.q.org.get(oid), this.cfg); }
  feature(oid, name, what) { if (!this.plan(oid).features[name]) throw upgrade(`${what} is part of the Team plan. Upgrade to use it.`); }
  seatCheck(oid, extra = 1) {
    const p = this.plan(oid), used = this.q.seatsUsed.get(oid).n;
    if (used + extra > p.seats) throw upgrade(`All ${p.seats} seats on this workspace are in use. Add seats, or remove someone first.`);
  }
  guestCheck(oid) {
    const p = this.plan(oid);
    if (this.q.guestsUsed.get(oid).n + 1 > p.guests) throw upgrade(p.guests ? `This workspace has room for ${p.guests} guests and all are in use.` : 'Guests are part of the Team plan.');
  }

  listOrgs(uid) {
    return this.q.myOrgs.all(uid).map((o) => ({ id: o.id, name: o.name, role: o.my_role, plan: effectivePlan(o, this.cfg).key, ssoRequired: this.ssoBlocked(o, uid, o.my_role) }));
  }
  createOrg(uid, name) {
    const n = clean(name, 80);
    if (!n) throw new HttpError(400, 'Give the workspace a name.');
    return this.tx(() => {
      if (this.q.createdOrgs.get(uid).n >= LIMITS.orgsPerUser) throw new HttpError(409, 'You have created the maximum number of workspaces.');
      const oid = newId('w');
      this.q.insertOrg.run(oid, n, 'team', this.cfg.billing ? 'trialing' : 'active', this.cfg.billing ? now() + this.cfg.trialDays * 864e5 : null, uid, now());
      this.q.putMember.run(oid, uid, 'owner', now());
      this.log(oid, uid, 'workspace.created', n);
      return { id: oid, name: n, role: 'owner' };
    });
  }
  orgInfo(oid, uid) {
    const role = this.needOrg(oid, uid, 'guest'), o = this.q.org.get(oid), p = this.plan(oid);
    const admin = ORANK[role] >= ORANK.admin;
    return {
      id: o.id, name: o.name, role, plan: p,
      usage: { seats: this.q.seatsUsed.get(oid).n, guests: this.q.guestsUsed.get(oid).n, campaigns: this.q.activeCampaigns.get(oid).n, drafts: this.usage(oid, 'draft') },
      domain: o.domain ? { name: o.domain, verified: Boolean(o.domain_verified), join: Boolean(o.domain_join), token: admin ? o.domain_token : undefined } : null,
      sso: admin || o.sso_provider ? { provider: admin ? o.sso_provider || '' : undefined, required: Boolean(o.sso_required), enabled: Boolean(o.sso_provider) } : null,
      billing: { enabled: Boolean(this.cfg.billing), customer: admin ? Boolean(o.stripe_customer) : undefined, subscription: admin ? Boolean(o.stripe_subscription) : undefined },
    };
  }
  renameOrg(oid, uid, name) {
    this.needOrg(oid, uid, 'admin');
    const n = clean(name, 80); if (!n) throw new HttpError(400, 'Give the workspace a name.');
    this.q.renameOrg.run(n, oid); this.log(oid, uid, 'workspace.renamed', n);
    return { ok: true };
  }
  deleteOrg(oid, uid) {
    this.needOrg(oid, uid, 'owner');
    const o = this.q.org.get(oid);
    if (o.stripe_subscription && ['active', 'trialing', 'past_due'].includes(o.status)) throw new HttpError(409, 'Cancel the subscription in Billing first, then delete the workspace.');
    this.q.deleteOrg.run(oid);
    return { ok: true };
  }
  members(oid, uid) {
    this.needOrg(oid, uid, 'member');
    return this.q.members.all(oid).map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, you: m.id === uid, since: m.added_at }));
  }
  setOrgRole(oid, actor, target, role) {
    if (!ORANK.hasOwnProperty(role)) throw new HttpError(400, 'Unknown role.');
    return this.tx(() => {
      const mine = this.needOrg(oid, actor, 'admin'), cur = this.orgRole(oid, target);
      if (!cur) throw new HttpError(404, 'That person is not in this workspace.');
      if ((cur === 'owner' || role === 'owner') && mine !== 'owner') throw new HttpError(403, 'Only an owner can change who owns the workspace.');
      if (cur === 'owner' && role !== 'owner' && this.q.owners.all(oid).length < 2) throw new HttpError(400, 'A workspace needs at least one owner.');
      if (cur === 'guest' && role !== 'guest') this.seatCheck(oid);
      if (cur !== 'guest' && role === 'guest') this.guestCheck(oid);
      this.q.putMember.run(oid, target, role, now());
      this.log(oid, actor, 'member.role_changed', (this.q.user.get(target) || {}).email, { from: cur, to: role });
      return { ok: true };
    });
  }
  removeMember(oid, actor, target) {
    return this.tx(() => {
      const cur = this.orgRole(oid, target);
      if (!cur) throw new HttpError(404, 'That person is not in this workspace.');
      if (target !== actor) {
        const mine = this.needOrg(oid, actor, 'admin');
        if (cur === 'owner' && mine !== 'owner') throw new HttpError(403, 'Only an owner can remove an owner.');
      }
      if (cur === 'owner' && this.q.owners.all(oid).length < 2) throw new HttpError(400, target === actor ? 'Make someone else an owner before you leave.' : 'A workspace needs at least one owner.');
      const who = (this.q.user.get(target) || {}).email;
      this.q.dropOrgAccess.run(target, oid); this.q.dropMember.run(oid, target);
      this.log(oid, actor, target === actor ? 'member.left' : 'member.removed', who);
      return { ok: true };
    });
  }

  // ---------- workspace invitations ----------
  createOrgInvite(oid, uid, role, email) {
    this.needOrg(oid, uid, 'admin');
    if (!['admin', 'member', 'guest'].includes(role)) throw new HttpError(400, 'Role must be admin, member or guest.');
    const e = email ? String(email).trim().toLowerCase() : '';
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'That email address is not valid.');
    if (role === 'guest') this.guestCheck(oid); else this.seatCheck(oid);
    if (this.q.countOrgInvites.get(oid, now()).n >= LIMITS.invitesPerOrg) throw new HttpError(409, 'Too many open invitations. Revoke some first.');
    const code = crypto.randomBytes(16).toString('base64url'), expires = now() + 14 * 864e5;
    this.q.insertOrgInvite.run(code, oid, role, e || null, uid, now(), expires, e ? 1 : 25);
    this.log(oid, uid, 'invite.created', e || null, { role });
    return { code, role, email: e || null, expiresAt: expires };
  }
  listOrgInvites(oid, uid) {
    this.needOrg(oid, uid, 'admin');
    return this.q.orgInvites.all(oid, now()).map((i) => ({ code: i.code, role: i.role, email: i.email, expiresAt: i.expires_at, uses: i.uses, maxUses: i.max_uses, inviter: i.inviter }));
  }
  revokeOrgInvite(oid, uid, code) {
    this.needOrg(oid, uid, 'admin');
    this.q.dropOrgInvite.run(code, oid); this.log(oid, uid, 'invite.revoked');
    return { ok: true };
  }
  previewOrgInvite(code) {
    const i = typeof code === 'string' && code.length < 64 ? this.q.orgInvite.get(code) : null;
    if (!i || i.expires_at < now() || i.uses >= i.max_uses) throw new HttpError(404, 'This invitation has expired or was revoked. Ask for a new one.');
    return { workspace: i.org_name, role: i.role, invitedBy: i.inviter || 'A colleague', email: i.email, orgId: i.org_id };
  }
  acceptOrgInvite(code, user) {
    return this.tx(() => {
      const p = this.previewOrgInvite(code);
      if (p.email && p.email !== String(user.email || '').toLowerCase()) throw new HttpError(403, `This invitation is for ${p.email}. Sign in with that account to accept it.`);
      const cur = this.orgRole(p.orgId, user.id);
      if (!cur || ORANK[cur] < ORANK[p.role]) {
        if (p.role === 'guest') this.guestCheck(p.orgId); else if (!cur || cur === 'guest') this.seatCheck(p.orgId);
        this.q.putMember.run(p.orgId, user.id, p.role, now());
        this.log(p.orgId, user.id, 'member.joined', user.email, { role: p.role, via: 'invitation' });
      }
      this.q.useOrgInvite.run(code);
      return { orgId: p.orgId, role: this.orgRole(p.orgId, user.id) };
    });
  }

  // ---------- clients ----------
  listClients(oid, uid) { this.needOrg(oid, uid, 'guest'); return this.q.clients.all(oid).map((c) => ({ id: c.id, name: c.name, archived: Boolean(c.archived) })); }
  addClient(oid, uid, name) {
    this.needOrg(oid, uid, 'member');
    const n = clean(name, 120); if (!n) throw new HttpError(400, 'Give the client a name.');
    if (this.q.countClients.get(oid).n >= LIMITS.clientsPerOrg) throw new HttpError(409, 'This workspace has the maximum number of clients.');
    const id = newId('k'); this.q.insertClient.run(id, oid, n, now()); this.log(oid, uid, 'client.added', n);
    return { id, name: n, archived: false };
  }
  updateClient(oid, uid, cid, { name, archived }) {
    this.needOrg(oid, uid, 'member');
    const c = this.q.client.get(cid); if (!c || c.org_id !== oid) throw new HttpError(404, 'Client not found.');
    const n = name === undefined ? c.name : clean(name, 120); if (!n) throw new HttpError(400, 'Give the client a name.');
    this.q.updateClient.run(n, archived === undefined ? c.archived : archived ? 1 : 0, cid);
    this.log(oid, uid, 'client.updated', n);
    return { ok: true };
  }
  deleteClient(oid, uid, cid) {
    this.needOrg(oid, uid, 'admin');
    const c = this.q.client.get(cid); if (!c || c.org_id !== oid) throw new HttpError(404, 'Client not found.');
    this.tx(() => { this.q.unsetClient.run(cid); this.q.deleteClient.run(cid); });
    this.log(oid, uid, 'client.deleted', c.name);
    return { ok: true };
  }

  // ---------- campaigns ----------
  campaignRole(cid, uid) {
    const c = this.q.campaign.get(cid); if (!c || !c.org_id) return null;
    const om = this.orgRole(c.org_id, uid); if (!om) return null;
    const ex = (this.q.role.get(cid, uid) || {}).role || null;
    if (om === 'owner' || om === 'admin') return 'owner';
    if (om === 'member') return ex || (c.visibility === 'org' ? 'editor' : null);
    return ex;
  }
  need(cid, uid, min) {
    const c = this.q.campaign.get(cid), org = c && c.org_id ? this.q.org.get(c.org_id) : null;
    if (org && this.ssoBlocked(org, uid, this.orgRole(org.id, uid))) throw this.ssoError(org);
    const r = this.campaignRole(cid, uid);
    if (!r) throw new HttpError(404, 'Campaign not found, or you do not have access to it.');
    if (CRANK[r] < CRANK[min]) throw new HttpError(403, min === 'owner' ? 'Only the campaign owner or a workspace admin can do that.' : 'You have view-only access to this campaign.');
    return r;
  }
  clientName(id) { const c = id ? this.q.client.get(id) : null; return c ? c.name : ''; }
  listOrgCampaigns(oid, uid) {
    this.needOrg(oid, uid, 'guest');
    const out = [];
    for (const c of this.q.orgCampaigns.all(oid)) {
      const role = this.campaignRole(c.id, uid); if (!role) continue;
      out.push({ id: c.id, name: c.name, role, clientId: c.client_id, client: this.clientName(c.client_id), visibility: c.visibility, archived: Boolean(c.archived), summary: c.summary ? JSON.parse(c.summary) : null, updatedAt: c.updated_at, people: c.people });
    }
    return out;
  }
  createCampaign(uid, { id, orgId, name, clientId, visibility }) {
    if (!idOk(id)) throw new HttpError(400, 'Campaign id is not valid.');
    return this.tx(() => {
      this.needOrg(orgId, uid, 'member');
      if (this.q.campaign.get(id)) {
        if (this.campaignRole(id, uid) === 'owner') return { id, role: 'owner' };
        throw new HttpError(409, 'That campaign id is taken.');
      }
      const p = this.plan(orgId);
      if (this.q.activeCampaigns.get(orgId).n >= p.campaigns) throw upgrade(`The ${p.label} plan includes ${p.campaigns} active campaigns. Archive one, or upgrade for more.`);
      const client = clientId && (this.q.client.get(clientId) || {}).org_id === orgId ? clientId : null;
      this.q.insertCampaign.run(id, uid, clean(name, 140), orgId, client, visibility === 'team' ? 'team' : 'org', uid, now(), now());
      this.q.putAccess.run(id, uid, 'owner', now());
      this.log(orgId, uid, 'campaign.created', clean(name, 140));
      return { id, role: 'owner' };
    });
  }
  updateCampaign(cid, uid, { visibility, archived }) {
    return this.tx(() => {
      this.need(cid, uid, 'owner');
      const c = this.q.campaign.get(cid);
      const vis = visibility === undefined ? c.visibility : visibility === 'team' ? 'team' : 'org';
      const arch = archived === undefined ? c.archived : archived ? 1 : 0;
      if (c.archived && !arch) { const p = this.plan(c.org_id); if (this.q.activeCampaigns.get(c.org_id).n >= p.campaigns) throw upgrade(`The ${p.label} plan includes ${p.campaigns} active campaigns. Archive another first, or upgrade.`); }
      this.q.setCampaign.run(c.client_id, vis, arch, now(), cid);
      if (vis !== c.visibility) this.log(c.org_id, uid, 'campaign.visibility', c.name, { to: vis });
      if (arch !== c.archived) this.log(c.org_id, uid, arch ? 'campaign.archived' : 'campaign.restored', c.name);
      return { ok: true };
    });
  }
  removeCampaign(cid, uid) {
    const role = this.need(cid, uid, 'viewer'), c = this.q.campaign.get(cid);
    if (role === 'owner') { this.q.deleteCampaign.run(cid); this.log(c.org_id, uid, 'campaign.deleted', c.name); return { deleted: true }; }
    if (!this.q.role.get(cid, uid)) throw new HttpError(400, 'This campaign is open to everyone in the workspace, so there is nothing to leave.');
    this.q.dropAccess.run(cid, uid);
    return { left: true };
  }
  records(cid, uid, since) {
    const role = this.need(cid, uid, 'viewer'), c = this.q.campaign.get(cid);
    const rows = since > 0 ? this.q.changedRecords.all(cid, since) : this.q.allRecords.all(cid);
    return { role, cursor: c.rev, name: c.name, orgId: c.org_id, visibility: c.visibility, client: this.clientName(c.client_id), archived: Boolean(c.archived),
      records: rows.map((r) => ({ kind: r.kind, id: r.rid, data: r.data === null ? null : JSON.parse(r.data), rev: r.rev })) };
  }
  write(cid, uid, ops) {
    if (!Array.isArray(ops) || !ops.length) throw new HttpError(400, 'No changes were sent.');
    if (ops.length > LIMITS.opsPerBatch) throw new HttpError(413, `Send at most ${LIMITS.opsPerBatch} changes at a time.`);
    const clean2 = ops.map((op) => {
      if (!op || !KINDS.has(op.kind)) throw new HttpError(400, 'Unknown record type.');
      const rid = SINGLE.has(op.kind) ? op.kind : op.id;
      if (!idOk(rid)) throw new HttpError(400, 'Record id is not valid.');
      if (op.data !== null && (typeof op.data !== 'object' || Array.isArray(op.data))) throw new HttpError(400, 'Record must be an object or null.');
      const json = op.data === null ? null : JSON.stringify(op.data);
      if (json && json.length > LIMITS.recordBytes) throw new HttpError(413, 'One record is too large.');
      return { kind: op.kind, rid, json, data: op.data };
    });
    const events = [];
    const result = this.tx(() => {
      this.need(cid, uid, 'editor');
      const c = this.q.campaign.get(cid);
      let rev = c.rev; const t = now();
      for (const op of clean2) {
        rev += 1;
        if (op.kind === 'tasks' && op.data && op.data.assignee && !op.data.done && op.data.assignee !== uid) {
          const old = this.q.record.get(cid, 'tasks', op.rid), was = old && old.data ? JSON.parse(old.data).assignee : null;
          if (was !== op.data.assignee) events.push({ type: 'task.assigned', cid, by: uid, task: op.data });
        }
        this.q.putRecord.run(cid, op.kind, op.rid, op.json, rev, uid, t);
        if (op.kind === 'meta' && op.data && op.data.campaign) {
          this.q.rename.run(clean(op.data.campaign.bill, 140), cid);
          const k = op.data.campaign.clientId; const ok = k && (this.q.client.get(k) || {}).org_id === c.org_id;
          this.q.mirrorClient.run(ok ? k : null, cid);
        }
        if (op.kind === 'summary') this.q.saveSummary.run(op.json, cid);
      }
      const count = this.q.liveCount.get(cid).n;
      if (count > LIMITS.recordsPerCampaign) throw new HttpError(413, `A campaign can hold up to ${LIMITS.recordsPerCampaign} records.`);
      this.q.bump.run(rev, count, t, cid);
      return { cursor: rev };
    });
    for (const e of events) this.notify(e);
    return result;
  }
  people(cid, uid) {
    this.need(cid, uid, 'viewer');
    const c = this.q.campaign.get(cid), o = this.q.org.get(c.org_id);
    return { visibility: c.visibility, workspace: o.name, people: this.q.people.all(cid).map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role, you: p.id === uid, guest: this.orgRole(c.org_id, p.id) === 'guest' })) };
  }
  addPerson(cid, uid, target, role) {
    this.need(cid, uid, 'owner');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be editor or viewer.');
    const c = this.q.campaign.get(cid);
    if (!this.orgRole(c.org_id, target)) throw new HttpError(404, 'That person is not in this workspace.');
    const had = this.q.role.get(cid, target);
    this.q.putAccess.run(cid, target, role, now());
    if (!had) this.notify({ type: 'campaign.added', cid, by: uid, target, role });
    return { ok: true };
  }
  setRole(cid, uid, target, role) {
    this.need(cid, uid, 'owner');
    if (target === uid) throw new HttpError(400, 'You cannot change your own role.');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be editor or viewer.');
    if (!this.q.role.get(cid, target)) throw new HttpError(404, 'That person is not on this campaign.');
    this.q.putAccess.run(cid, target, role, now());
    return { ok: true };
  }
  removePerson(cid, uid, target) {
    if (target !== uid) this.need(cid, uid, 'owner');
    const r = this.q.role.get(cid, target);
    if (r && r.role === 'owner' && target === (this.q.campaign.get(cid) || {}).created_by && target !== uid) throw new HttpError(400, 'The person who created the campaign cannot be removed. A workspace admin can delete the campaign instead.');
    this.q.dropAccess.run(cid, target);
    return { ok: true };
  }
  createInvite(cid, uid, role) {
    this.need(cid, uid, 'editor');
    if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be editor or viewer.');
    if (this.q.countInvites.get(cid, now()).n >= LIMITS.invitesPerCampaign) throw new HttpError(409, 'Too many open invitations. Turn them off and create a new one.');
    const code = crypto.randomBytes(16).toString('base64url'), expires = now() + 14 * 864e5;
    this.q.insertInvite.run(code, cid, role, uid, now(), expires, 25);
    return { code, role, expiresAt: expires };
  }
  revokeInvites(cid, uid) { this.need(cid, uid, 'owner'); this.q.revokeInvites.run(cid); return { ok: true }; }
  previewInvite(code) {
    const i = typeof code === 'string' && code.length < 64 ? this.q.invite.get(code) : null;
    if (!i || i.expires_at < now() || i.uses >= i.max_uses) throw new HttpError(404, 'This invitation has expired or was revoked. Ask for a new link.');
    return { campaign: i.campaign_name || 'Untitled campaign', workspace: i.org_name, role: i.role, invitedBy: i.inviter || 'A teammate', campaignId: i.campaign_id, orgId: i.org_id };
  }
  // Joining a campaign from outside the workspace makes you a guest of it.
  acceptInvite(code, user) {
    return this.tx(() => {
      const p = this.previewInvite(code);
      if (!this.orgRole(p.orgId, user.id)) {
        this.guestCheck(p.orgId);
        this.q.putMember.run(p.orgId, user.id, 'guest', now());
        this.log(p.orgId, user.id, 'member.joined', user.email, { role: 'guest', via: 'campaign link', campaign: p.campaign });
      }
      const cur = (this.q.role.get(p.campaignId, user.id) || {}).role;
      if (!cur || CRANK[cur] < CRANK[p.role]) this.q.putAccess.run(p.campaignId, user.id, p.role, now());
      this.q.useInvite.run(code);
      return { campaignId: p.campaignId, orgId: p.orgId, role: this.campaignRole(p.campaignId, user.id) };
    });
  }

  // ---------- reports ----------
  auditLog(oid, uid, before, limit) {
    this.needOrg(oid, uid, 'admin'); this.feature(oid, 'audit', 'The activity log');
    return this.q.auditPage.all(oid, before > 0 ? before : Number.MAX_SAFE_INTEGER, Math.min(200, Math.max(1, limit || 50)))
      .map((a) => ({ id: a.id, at: a.at, actor: a.actor_name || '', action: a.action, target: a.target || '', detail: a.detail ? JSON.parse(a.detail) : null }));
  }
  // Every contact logged in the workspace between two dates, for lobbying
  // disclosure work (for example the quarterly LD-2 report).
  activity(oid, uid, from, to, clientId) {
    this.needOrg(oid, uid, 'admin'); this.feature(oid, 'activityReport', 'The lobbying activity report');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError(400, 'Choose a start and end date.');
    const names = new Map(this.q.members.all(oid).map((m) => [m.id, m.name || m.email]));
    const rows = [];
    for (const c of this.q.orgCampaigns.all(oid)) {
      if (clientId && c.client_id !== clientId) continue;
      const one = (kind) => { const r = this.q.recordsOf.all(c.id, kind)[0]; return r ? JSON.parse(r.data) : {}; };
      const meta = (one('meta').campaign) || {}, brief = one('brief');
      const issue = brief.number ? `${brief.number}${brief.title ? `: ${brief.title}` : ''}` : meta.bill || c.name;
      for (const r of this.q.recordsOf.all(c.id, 'members')) {
        const m = JSON.parse(r.data);
        for (const h of m.history || []) {
          if (!CONTACT_TYPES.has(h.type) || !(h.d >= from && h.d <= to)) continue;
          rows.push({ date: h.d, client: this.clientName(c.client_id) || meta.client || '', campaign: c.name, issue, chamber: meta.chamber || '', member: m.name, party: m.party, district: m.district,
            withWhom: h.who || 'Member', type: h.type, note: h.note || '', loggedBy: h.by ? names.get(h.by) || 'Former member' : '' });
        }
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.client.localeCompare(b.client));
    const byClient = new Map();
    for (const r of rows) {
      const k = r.client || 'No client';
      const g = byClient.get(k) || { client: k, contacts: 0, issues: new Set(), chambers: new Set(), lobbyists: new Set() };
      g.contacts++; g.issues.add(r.issue); if (r.chamber) g.chambers.add(r.chamber); if (r.loggedBy) g.lobbyists.add(r.loggedBy);
      byClient.set(k, g);
    }
    const summary = [...byClient.values()].map((g) => ({ client: g.client, contacts: g.contacts, issues: [...g.issues], chambers: [...g.chambers], lobbyists: [...g.lobbyists] }));
    this.log(oid, uid, 'report.activity', `${from} to ${to}`);
    return { from, to, rows, summary };
  }
  exportOrg(oid, uid) {
    this.needOrg(oid, uid, 'admin');
    const o = this.q.org.get(oid);
    const campaigns = this.q.orgCampaigns.all(oid).map((c) => {
      const recs = { members: [], tasks: [], meetings: [] };
      for (const r of this.q.allRecords.all(c.id)) { const d = JSON.parse(r.data); if (SINGLE.has(r.kind)) recs[r.kind] = d; else recs[r.kind].push(d); }
      return { id: c.id, name: c.name, client: this.clientName(c.client_id), visibility: c.visibility, archived: Boolean(c.archived), createdAt: new Date(c.created_at).toISOString(), ...recs };
    });
    this.log(oid, uid, 'workspace.exported');
    return { exportedAt: new Date().toISOString(), workspace: { id: o.id, name: o.name, createdAt: new Date(o.created_at).toISOString() },
      people: this.q.members.all(oid).map((m) => ({ name: m.name, email: m.email, role: m.role })), clients: this.q.clients.all(oid).map((c) => ({ name: c.name, archived: Boolean(c.archived) })), campaigns };
  }

  // ---------- sign-in domain ----------
  setDomain(oid, uid, domain) {
    this.needOrg(oid, uid, 'admin'); this.feature(oid, 'domain', 'Joining by email domain');
    const d = String(domain || '').trim().toLowerCase().replace(/^@/, '');
    if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw new HttpError(400, 'Enter a domain such as yourfirm.com.');
    if (PUBLIC_DOMAINS.has(d)) throw new HttpError(400, `${d} is a public email service, so it cannot be claimed by a workspace.`);
    const token = crypto.randomBytes(12).toString('hex');
    this.q.setDomain.run(d, token, 0, 0, oid); this.log(oid, uid, 'domain.added', d);
    return { domain: d, record: `headcount-verification=${token}` };
  }
  async verifyDomain(oid, uid, resolveTxt) {
    this.needOrg(oid, uid, 'admin');
    const o = this.q.org.get(oid); if (!o.domain) throw new HttpError(400, 'Add a domain first.');
    let txt = [];
    try { txt = (await resolveTxt(o.domain)).map((parts) => parts.join('')); } catch (_) { txt = []; }
    if (!txt.includes(`headcount-verification=${o.domain_token}`)) throw new HttpError(409, `The TXT record was not found on ${o.domain} yet. DNS changes can take an hour to appear.`);
    const taken = this.q.orgByDomain.get(o.domain);
    if (taken && taken.id !== oid) throw new HttpError(409, 'Another workspace already verified this domain.');
    this.q.setDomain.run(o.domain, o.domain_token, 1, o.domain_join, oid); this.log(oid, uid, 'domain.verified', o.domain);
    return { verified: true };
  }
  setDomainJoin(oid, uid, on) {
    this.needOrg(oid, uid, 'admin');
    const o = this.q.org.get(oid); if (!o.domain_verified) throw new HttpError(400, 'Verify the domain first.');
    this.q.setDomainJoin.run(on ? 1 : 0, oid); this.log(oid, uid, on ? 'domain.join_on' : 'domain.join_off', o.domain);
    return { ok: true };
  }
  clearDomain(oid, uid) { this.needOrg(oid, uid, 'admin'); this.q.setDomain.run(null, null, 0, 0, oid); this.log(oid, uid, 'domain.removed'); return { ok: true }; }
  domainMatches(user) {
    if (!user.emailVerified || !user.email) return [];
    const o = this.q.orgByDomain.get(String(user.email).split('@')[1].toLowerCase());
    return o && o.domain_join && !this.orgRole(o.id, user.id) ? [{ id: o.id, name: o.name }] : [];
  }
  joinByDomain(oid, user) {
    return this.tx(() => {
      if (!this.domainMatches(user).some((o) => o.id === oid)) throw new HttpError(403, 'Your email address does not let you join this workspace.');
      this.seatCheck(oid);
      this.q.putMember.run(oid, user.id, 'member', now());
      this.log(oid, user.id, 'member.joined', user.email, { role: 'member', via: 'email domain' });
      return { orgId: oid, role: 'member' };
    });
  }

  // ---------- billing ----------
  billingOrg(oid, uid) { this.needOrg(oid, uid, 'admin'); return this.q.org.get(oid); }
  setCustomer(oid, customer) { this.q.setCustomer.run(customer, oid); }
  orgForStripe(orgId, customer) { return (orgId && this.q.org.get(orgId)) || (customer && this.q.orgByCustomer.get(customer)) || null; }
  applySubscription(org, s) {
    this.q.setBilling.run(s.plan, s.status, s.seats, s.periodEnd || null, s.customer || org.stripe_customer, s.subscription, s.item, org.id);
    this.log(org.id, null, 'billing.subscription', s.status, { plan: s.plan, seats: s.seats });
  }
  endSubscription(org) {
    this.q.setBilling.run(org.plan, 'canceled', 0, null, org.stripe_customer, null, null, org.id);
    this.log(org.id, null, 'billing.canceled');
  }
  firstSeen(eventId) { if (this.q.seenEvent.get(eventId)) return false; this.q.markEvent.run(eventId, now()); return true; }

  // ---------- metering ----------
  usage(oid, kind) { return (this.q.getUsage.get('org:' + oid, month(), kind) || { n: 0 }).n; }
  meter(oid, kind) {
    const p = this.plan(oid), used = this.usage(oid, kind);
    if (used >= p.drafts) throw upgrade(p.drafts ? `This workspace has used all ${p.drafts} drafted briefs for this month.` : 'Drafting briefs with Claude is part of the Team plan.');
    this.q.addUsage.run('org:' + oid, month(), kind);
  }
  meterGlobal(kind, limit) {
    const day = new Date().toISOString().slice(0, 10), n = (this.q.getUsage.get('all', day, kind) || { n: 0 }).n;
    if (n >= limit) return false;
    this.q.addUsage.run('all', day, kind); return true;
  }

  // ---------- single sign-on ----------
  // Large firms sign in through their own identity provider (Okta, Entra ID and
  // so on), set up as a SAML or OIDC provider in Identity Platform.
  setSso(oid, uid, { provider, required }) {
    this.needOrg(oid, uid, 'admin'); this.feature(oid, 'sso', 'Single sign-on');
    const o = this.q.org.get(oid), p = provider === undefined ? o.sso_provider : String(provider || '').trim();
    if (p && !/^(saml|oidc)\.[A-Za-z0-9._-]{1,60}$/.test(p)) throw new HttpError(400, 'Enter the provider ID from Identity Platform, such as saml.yourfirm or oidc.yourfirm.');
    if (p && !o.domain_verified) throw new HttpError(400, 'Verify your email domain first, so people can find your sign-in page by their work address.');
    const other = p ? this.q.orgBySso.get(p) : null;
    if (other && other.id !== oid) throw new HttpError(409, 'Another workspace already uses that provider.');
    const req = required === undefined ? Boolean(o.sso_required) : Boolean(required);
    if (req && !p) throw new HttpError(400, 'Add a provider before requiring single sign-on.');
    this.q.setSso.run(p || null, req ? 1 : 0, oid);
    this.log(oid, uid, 'sso.updated', p || 'removed', { required: req });
    return { ok: true };
  }
  ssoLookup(email) {
    const d = String(email || '').toLowerCase().split('@')[1] || '';
    const o = d ? this.q.orgByDomain.get(d) : null;
    if (!o || !o.sso_provider) throw new HttpError(404, 'Your firm has not set up single sign-on with Headcount. Sign in with Google or Microsoft instead.');
    return { provider: o.sso_provider, workspace: o.name };
  }
  // Signing in through a firm's identity provider makes you a member of its workspace.
  ssoJoin(user) {
    if (!/^(saml|oidc)\./.test(user.provider || '')) return null;
    const o = this.q.orgBySso.get(user.provider);
    if (!o || this.orgRole(o.id, user.id)) return null;
    try {
      return this.tx(() => { this.seatCheck(o.id); this.q.putMember.run(o.id, user.id, 'member', now()); this.log(o.id, user.id, 'member.joined', user.email, { role: 'member', via: 'single sign-on' }); return o.id; });
    } catch (e) { if (e.status === 402) return null; throw e; }
  }

  // ---------- email ----------
  secret() {
    if (this.cfg.appSecret) return this.cfg.appSecret;
    this.q.putSetting.run('app_secret', crypto.randomBytes(32).toString('hex'));
    return this.q.setting.get('app_secret').value;
  }
  getPrefs(uid) {
    const p = this.q.prefs.get(uid) || {};
    return { digest: p.digest || 'weekly', notifyAssigned: p.notify_assigned !== 0, notifyAdded: p.notify_added !== 0, tz: p.tz || '', digestHour: p.digest_hour === undefined || p.digest_hour === null ? 8 : p.digest_hour, lastDigest: p.last_digest || null };
  }
  setPrefs(uid, patch) {
    const cur = this.getPrefs(uid), next = { ...cur };
    if (patch.digest !== undefined) { if (!['daily', 'weekly', 'off'].includes(patch.digest)) throw new HttpError(400, 'Digest must be daily, weekly or off.'); next.digest = patch.digest; }
    if (patch.notifyAssigned !== undefined) next.notifyAssigned = Boolean(patch.notifyAssigned);
    if (patch.notifyAdded !== undefined) next.notifyAdded = Boolean(patch.notifyAdded);
    if (patch.digestHour !== undefined) { const h = Number(patch.digestHour); if (!Number.isInteger(h) || h < 0 || h > 23) throw new HttpError(400, 'Choose an hour from 0 to 23.'); next.digestHour = h; }
    if (patch.tz !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: String(patch.tz) }); next.tz = String(patch.tz).slice(0, 64); } catch (_) { throw new HttpError(400, 'Unknown time zone.'); } }
    this.q.putPrefs.run(uid, next.digest, next.notifyAssigned ? 1 : 0, next.notifyAdded ? 1 : 0, next.tz || null, next.digestHour);
    return next;
  }
  enqueueEmail(m) {
    this.q.enqueue.run(m.to, m.subject, m.text, m.html || null, m.kind, m.userId || null, m.replyTo || null, m.unsubscribe || null, m.dedupe || null, now(), now());
  }
  addLead(l) { this.q.addLead.run(now(), l.name, l.email, l.firm, l.size, l.message); }

  // ---------- accounts ----------
  // Removes the person everywhere. A workspace they alone own passes to its
  // longest-standing admin or member, or is deleted if nobody else is in it.
  deleteUser(uid) {
    return this.tx(() => {
      let transferred = 0, deleted = 0; const cancel = [];
      for (const { org_id: oid } of this.q.orgsOwnedBy.all(uid)) {
        if (this.q.owners.all(oid).length > 1) continue;
        const next = this.q.successor.get(oid, uid);
        if (next) { this.q.putMember.run(oid, next.user_id, 'owner', now()); this.log(oid, uid, 'workspace.owner_changed', (this.q.user.get(next.user_id) || {}).email, { reason: 'account deleted' }); transferred++; }
        else { const o = this.q.org.get(oid); if (o.stripe_subscription) cancel.push(o.stripe_subscription); this.q.deleteOrg.run(oid); deleted++; }
      }
      this.q.deleteUser.run(uid);
      return { transferred, deleted, cancel };
    });
  }
}
