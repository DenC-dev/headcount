import { HttpError, newId, clean } from './db.js';

// Stakeholders: everyone the team works with besides the legislators in a
// campaign: agency staff, coalition partners, client contacts, reporters,
// donors. Each contact has an owner, tags and a timeline of interactions.

const TYPES = new Set(['Meeting', 'Call', 'Email', 'Event', 'Note']);
const MAX_CONTACTS = 20000;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : new Date().toISOString().slice(0, 10));

export function makeCrm(cfg, store) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, title TEXT, organization TEXT,
      email TEXT, phone TEXT, tags TEXT, notes TEXT, owner_id TEXT, client_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_touch TEXT);
    CREATE INDEX IF NOT EXISTS contacts_org ON contacts(org_id, name);
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      day TEXT NOT NULL, type TEXT NOT NULL, note TEXT, campaign_id TEXT, by_id TEXT, by_name TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS interactions_contact ON interactions(contact_id, day);
  `);
  const p = (sql) => db.prepare(sql);
  const q = {
    all: p('SELECT * FROM contacts WHERE org_id = ? ORDER BY name COLLATE NOCASE LIMIT 20000'),
    one: p('SELECT * FROM contacts WHERE id = ? AND org_id = ?'),
    count: p('SELECT COUNT(*) AS n FROM contacts WHERE org_id = ?'),
    byEmail: p('SELECT id FROM contacts WHERE org_id = ? AND lower(email) = lower(?)'),
    insert: p('INSERT INTO contacts (id, org_id, name, title, organization, email, phone, tags, notes, owner_id, client_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: p('UPDATE contacts SET name = ?, title = ?, organization = ?, email = ?, phone = ?, tags = ?, notes = ?, owner_id = ?, client_id = ?, updated_at = ? WHERE id = ?'),
    remove: p('DELETE FROM contacts WHERE id = ?'),
    touch: p('UPDATE contacts SET last_touch = MAX(COALESCE(last_touch, ?), ?) WHERE id = ?'),
    log: p('INSERT INTO interactions (id, org_id, contact_id, day, type, note, campaign_id, by_id, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    timeline: p('SELECT * FROM interactions WHERE contact_id = ? ORDER BY day DESC, created_at DESC LIMIT 500'),
    orgInteractions: p('SELECT i.*, c.name AS contact_name, c.organization FROM interactions i JOIN contacts c ON c.id = i.contact_id WHERE i.org_id = ? ORDER BY i.day DESC LIMIT 20000'),
    unlog: p('DELETE FROM interactions WHERE id = ? AND org_id = ?'),
  };
  const tagsOf = (t) => [...new Set((Array.isArray(t) ? t : String(t || '').split(',')).map((x) => clean(x, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
  const out = (c) => ({ id: c.id, name: c.name, title: c.title || '', organization: c.organization || '', email: c.email || '', phone: c.phone || '', tags: c.tags ? JSON.parse(c.tags) : [], notes: c.notes || '', ownerId: c.owner_id || '', clientId: c.client_id || '', lastTouch: c.last_touch || '', updatedAt: c.updated_at });
  function read(b, cur = {}) {
    const v = (k, n) => clean(b[k] !== undefined ? b[k] : cur[k], n);
    const c = { name: v('name', 120), title: v('title', 120), organization: v('organization', 160), email: v('email', 160), phone: v('phone', 40), notes: String(b.notes !== undefined ? b.notes : cur.notes || '').slice(0, 4000),
      tags: tagsOf(b.tags !== undefined ? b.tags : cur.tags), ownerId: b.ownerId !== undefined ? String(b.ownerId || '') : cur.ownerId || '', clientId: b.clientId !== undefined ? String(b.clientId || '') : cur.clientId || '' };
    if (!c.name) throw new HttpError(400, 'Add a name.');
    if (c.email && !isEmail(c.email)) throw new HttpError(400, `${c.email} is not a valid email address.`);
    return c;
  }
  function checkRefs(oid, c) {
    if (c.ownerId && !store.orgRole(oid, c.ownerId)) c.ownerId = '';
    if (c.clientId) { const k = store.q.client.get(c.clientId); if (!k || k.org_id !== oid) c.clientId = ''; }
  }

  function list(oid, uid) { store.needOrg(oid, uid, 'member'); return { contacts: q.all.all(oid).map(out) }; }
  function create(oid, uid, b) {
    store.needOrg(oid, uid, 'member');
    if (q.count.get(oid).n >= MAX_CONTACTS) throw new HttpError(400, `A workspace can hold ${MAX_CONTACTS} contacts.`);
    const c = read(b); checkRefs(oid, c);
    const id = newId('k');
    q.insert.run(id, oid, c.name, c.title, c.organization, c.email, c.phone, JSON.stringify(c.tags), c.notes, c.ownerId || uid, c.clientId || null, uid, Date.now(), Date.now());
    return out(q.one.get(id, oid));
  }
  // Imports a spreadsheet. Rows whose email is already in the workspace update that contact.
  function importRows(oid, uid, rows) {
    store.needOrg(oid, uid, 'member');
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'No rows to import.');
    if (rows.length > 5000) throw new HttpError(400, 'Import up to 5,000 rows at a time.');
    let added = 0, updated = 0; const skipped = [];
    store.tx(() => {
      rows.forEach((r, i) => {
        let c; try { c = read(r); } catch (e) { skipped.push(`Row ${i + 2}: ${e.message}`); return; }
        checkRefs(oid, c);
        const hit = c.email ? q.byEmail.get(oid, c.email) : null;
        if (hit) { const cur = out(q.one.get(hit.id, oid)); const m = read({ ...r, tags: [...cur.tags, ...tagsOf(r.tags)] }, cur); q.update.run(m.name, m.title, m.organization, m.email, m.phone, JSON.stringify(m.tags), m.notes, cur.ownerId || uid, m.clientId || null, Date.now(), hit.id); updated++; }
        else if (q.count.get(oid).n < MAX_CONTACTS) { q.insert.run(newId('k'), oid, c.name, c.title, c.organization, c.email, c.phone, JSON.stringify(c.tags), c.notes, uid, c.clientId || null, uid, Date.now(), Date.now()); added++; }
      });
    });
    store.log(oid, uid, 'contacts.imported', `${added} added, ${updated} updated`);
    return { added, updated, skipped: skipped.slice(0, 50) };
  }
  function update(oid, uid, id, b) {
    store.needOrg(oid, uid, 'member');
    const cur = q.one.get(id, oid); if (!cur) throw new HttpError(404, 'Contact not found.');
    const c = read(b, out(cur)); checkRefs(oid, c);
    q.update.run(c.name, c.title, c.organization, c.email, c.phone, JSON.stringify(c.tags), c.notes, c.ownerId || null, c.clientId || null, Date.now(), id);
    return out(q.one.get(id, oid));
  }
  function remove(oid, uid, id) {
    store.needOrg(oid, uid, 'member');
    if (!q.one.get(id, oid)) throw new HttpError(404, 'Contact not found.');
    q.remove.run(id); return { ok: true };
  }
  function timeline(oid, uid, id) {
    store.needOrg(oid, uid, 'member');
    if (!q.one.get(id, oid)) throw new HttpError(404, 'Contact not found.');
    return { interactions: q.timeline.all(id).map((i) => ({ id: i.id, day: i.day, type: i.type, note: i.note || '', campaignId: i.campaign_id || '', by: i.by_name || '' })) };
  }
  // Logs one interaction with one or many contacts (a bulk email logs one per person).
  function log(oid, uid, b) {
    store.needOrg(oid, uid, 'member');
    const ids = (Array.isArray(b.contactIds) ? b.contactIds : [b.contactId]).map(String).slice(0, 2000);
    const type = TYPES.has(b.type) ? b.type : 'Note', d = day(b.day), note = String(b.note || '').trim().slice(0, 2000);
    let cid = String(b.campaignId || '');
    if (cid) { const c = store.q.campaign.get(cid); if (!c || c.org_id !== oid || !store.campaignRole(cid, uid)) cid = ''; }
    const u = store.q.user.get(uid) || {}; let n = 0;
    store.tx(() => {
      for (const id of ids) {
        if (!q.one.get(id, oid)) continue;
        q.log.run(newId('i'), oid, id, d, type, note, cid || null, uid, u.name || u.email || '', Date.now()); q.touch.run(d, d, id); n++;
      }
    });
    if (!n) throw new HttpError(404, 'Contact not found.');
    return { logged: n };
  }
  function unlog(oid, uid, iid) { store.needOrg(oid, uid, 'member'); q.unlog.run(iid, oid); return { ok: true }; }
  const exportOrg = (oid) => ({ contacts: q.all.all(oid).map(out), interactions: q.orgInteractions.all(oid).map((i) => ({ day: i.day, type: i.type, contact: i.contact_name, organization: i.organization || '', note: i.note || '', by: i.by_name || '' })) });
  return { list, create, importRows, update, remove, timeline, log, unlog, exportOrg };
}
