import crypto from 'node:crypto';
import { HttpError, clean } from './db.js';
import { districtsFor, normDistrict, addressLine } from './sources.js';

// The action center: a public page for each campaign where supporters enter
// their address, find their own legislators among the campaign's targets, and
// send them a letter (by email where the office publishes one) or call. Each
// response counts toward that member in the campaign's whip count.

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

export function makeActionCenter(cfg, store, mail) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, campaign_id TEXT NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
      title TEXT NOT NULL, intro TEXT, subject TEXT, letter TEXT, call_script TEXT, juris TEXT, targets TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS action_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE, org_id TEXT NOT NULL, at INTEGER NOT NULL,
      name TEXT, email TEXT, address TEXT, state TEXT, members TEXT, emailed INTEGER NOT NULL DEFAULT 0, optin INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS action_responses_action ON action_responses(action_id, at);
  `);
  const p = (sql) => db.prepare(sql);
  const q = {
    byCampaign: p('SELECT * FROM actions WHERE campaign_id = ?'),
    byId: p('SELECT * FROM actions WHERE id = ?'),
    insert: p('INSERT INTO actions (id, org_id, campaign_id, title, intro, subject, letter, call_script, juris, targets, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: p('UPDATE actions SET title = ?, intro = ?, subject = ?, letter = ?, call_script = ?, juris = ?, targets = ?, active = ?, updated_at = ? WHERE id = ?'),
    respond: p('INSERT INTO action_responses (action_id, org_id, at, name, email, address, state, members, emailed, optin, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    already: p('SELECT COUNT(*) AS n FROM action_responses WHERE action_id = ? AND email = ? AND at > ?'),
    responses: p('SELECT * FROM action_responses WHERE action_id = ? ORDER BY at DESC LIMIT ?'),
    count: p('SELECT COUNT(*) AS n, SUM(optin) AS optin, MAX(at) AS last FROM action_responses WHERE action_id = ?'),
    orgResponses: p('SELECT r.*, a.title AS action_title FROM action_responses r JOIN actions a ON a.id = r.action_id WHERE r.org_id = ? ORDER BY r.at DESC LIMIT 5000'),
  };

  const out = (a) => a && ({ id: a.id, url: `${cfg.publicUrl || ''}/act/${a.id}`, title: a.title, intro: a.intro || '', subject: a.subject || '', letter: a.letter || '', callScript: a.call_script || '', juris: a.juris ? JSON.parse(a.juris) : null, active: Boolean(a.active), targets: JSON.parse(a.targets).length, updatedAt: a.updated_at });

  function readTargets(list) {
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Load the legislators for this campaign first.');
    return list.slice(0, 600).map((t) => ({ id: clean(t.id, 64), name: clean(t.name, 120), party: clean(t.party, 4), district: clean(t.district, 40), email: isEmail(t.email) ? clean(t.email, 160) : '', phone: clean(t.phone, 40), form: /^https:\/\//.test(t.form || '') ? clean(t.form, 300) : '', title: clean(t.title, 40) })).filter((t) => t.id && t.name);
  }
  function readJuris(j) {
    if (!j || typeof j !== 'object') return null;
    const level = j.level === 'us' ? 'us' : j.level === 'state' ? 'state' : null, chamber = ['upper', 'lower', 'legislature'].includes(j.chamber) ? j.chamber : null;
    if (!level || !chamber) return null;
    return { level, chamber, state: level === 'state' ? clean(j.state, 2).toUpperCase() : '' };
  }

  function get(cid, uid) {
    store.need(cid, uid, 'viewer');
    const a = q.byCampaign.get(cid);
    if (!a) return { action: null };
    const c = q.count.get(a.id), by = {};
    for (const r of q.responses.all(a.id, 5000)) for (const id of JSON.parse(r.members || '[]')) by[id] = (by[id] || 0) + 1;
    return { action: out(a), stats: { responses: c.n || 0, optin: c.optin || 0, last: c.last || null, byMember: by } };
  }
  function save(cid, uid, b) {
    store.need(cid, uid, 'editor');
    const camp = store.q.campaign.get(cid);
    if (!store.plan(camp.org_id).features.actionCenter) throw new HttpError(402, 'The action center is part of the Team plan. Upgrade to use it.', { upgrade: true });
    const cur = q.byCampaign.get(cid), targets = JSON.stringify(readTargets(b.targets)), juris = readJuris(b.juris);
    const title = clean(b.title, 120) || camp.name, intro = String(b.intro || '').trim().slice(0, 3000), subject = clean(b.subject, 160), letter = String(b.letter || '').trim().slice(0, 6000), call = String(b.callScript || '').trim().slice(0, 2000);
    if (!letter) throw new HttpError(400, 'Write the letter supporters will send.');
    const active = b.active === undefined ? true : Boolean(b.active);
    if (cur) q.update.run(title, intro, subject, letter, call, juris ? JSON.stringify(juris) : null, targets, active ? 1 : 0, Date.now(), cur.id);
    else {
      const id = crypto.randomBytes(7).toString('base64url');
      q.insert.run(id, camp.org_id, cid, title, intro, subject, letter, call, juris ? JSON.stringify(juris) : null, targets, active ? 1 : 0, uid, Date.now(), Date.now());
      store.log(camp.org_id, uid, 'action.created', camp.name);
    }
    return get(cid, uid);
  }
  function responses(cid, uid) {
    store.need(cid, uid, 'editor');
    const a = q.byCampaign.get(cid); if (!a) return { responses: [] };
    const names = new Map(JSON.parse(a.targets).map((t) => [t.id, t.name]));
    return { responses: q.responses.all(a.id, 5000).map((r) => ({ at: r.at, name: r.name, email: r.optin ? r.email : '', address: r.address, state: r.state, members: JSON.parse(r.members || '[]').map((id) => names.get(id) || id), emailed: r.emailed, optin: Boolean(r.optin), edited: Boolean(r.edited) })) };
  }

  // ---------- public ----------
  function publicView(id) {
    const a = q.byId.get(String(id || ''));
    if (!a || !a.active) throw new HttpError(404, 'This action page is not available.');
    const org = store.q.org.get(a.org_id), juris = a.juris ? JSON.parse(a.juris) : null;
    return { title: a.title, intro: a.intro || '', subject: a.subject || '', letter: a.letter || '', callScript: a.call_script || '', org: org ? org.name : '', canEmail: mail.enabled,
      // The state to start the address form on, and the legislators to pick from if an address cannot be found
      state: juris && juris.level === 'state' ? juris.state || '' : '',
      members: JSON.parse(a.targets).map((t) => ({ id: t.id, name: t.name, title: t.title, district: t.district })) };
  }
  // Which districts an address is in, in words, for when none are on the campaign.
  function whereYouAre(a, d) {
    const juris = a.juris ? JSON.parse(a.juris) : null;
    if (juris && juris.level === 'us') return juris.chamber === 'upper' ? `${d.state}` : `${d.state} congressional district ${d.cd === 'AL' ? 'at large' : d.cd}`;
    if (juris && juris.level === 'state') return juris.chamber === 'lower' ? d.label.lower || (d.lower ? `House district ${d.lower}` : '') : d.label.upper || (d.upper ? `Senate district ${d.upper}` : '');
    return '';
  }
  function match(a, d) {
    const juris = a.juris ? JSON.parse(a.juris) : null, targets = JSON.parse(a.targets);
    const up = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
    if (juris && juris.level === 'us') {
      if (juris.chamber === 'upper') return targets.filter((t) => up(t.district) === d.state);
      return targets.filter((t) => { const m = /^([A-Z]{2})-?(\w+)$/.exec(up(t.district)); return m && m[1] === d.state && (m[2] === 'AL' || m[2] === '0' || m[2] === '00' ? 'AL' : String(Number(m[2]) || m[2])) === d.cd; });
    }
    if (juris && juris.level === 'state') {
      if (juris.state && juris.state !== d.state) return [];
      const want = new Set(juris.chamber === 'lower' ? d.lowerNames || [d.lower] : d.upperNames || [d.upper]);
      return want.size ? targets.filter((t) => want.has(normDistrict(t.district))) : [];
    }
    return [];
  }
  async function lookup(id, address) {
    const a = q.byId.get(String(id || ''));
    if (!a || !a.active) throw new HttpError(404, 'This action page is not available.');
    const d = await districtsFor(cfg, address), mine = match(a, d);
    return { address: d.matched, districts: d, where: mine.length ? '' : whereYouAre(a, d), members: mine.map((t) => ({ id: t.id, name: t.name, title: t.title, party: t.party, district: t.district, email: Boolean(t.email) && mail.enabled, phone: t.phone, form: t.form })) };
  }
  async function send(id, b) {
    const a = q.byId.get(String(id || ''));
    if (!a || !a.active) throw new HttpError(404, 'This action page is not available.');
    const name = clean(b.name, 120), email = clean(b.email, 160);
    if (!name || !isEmail(email)) throw new HttpError(400, 'Add your name and email address. Offices reply to constituents by email.');
    // If the address truly cannot be found, the person may pick their own
    // legislator; the office sees the address as they typed it and can check it.
    let d, mine, unverified = false;
    try { d = await districtsFor(cfg, b.address); mine = match(a, d); }
    catch (e) {
      if (!(e.extra && e.extra.notFound) || !b.memberId) throw e;
      const pick = JSON.parse(a.targets).find((t) => t.id === String(b.memberId));
      if (!pick) throw new HttpError(400, 'Choose your legislator from the list.');
      const typed = addressLine(b.address);
      if (typed.length < 8) throw new HttpError(400, 'Enter your home address, so the office knows you live in the district.');
      d = { matched: typed, state: (b.address && b.address.state) || '' }; mine = [pick]; unverified = true;
    }
    if (!mine.length) throw new HttpError(400, 'None of the legislators this campaign is asking to act represent that address.');
    const subject = clean(b.subject, 160) || a.subject || a.title, message = String(b.message || '').trim().slice(0, 6000) || a.letter;
    const edited = message !== a.letter;
    if (q.already.get(a.id, email.toLowerCase(), Date.now() - 864e5).n) throw new HttpError(409, 'You already sent this letter today. Thank you.');
    const org = store.q.org.get(a.org_id); let emailed = 0;
    for (const t of mine) {
      if (!t.email || !mail.enabled) continue;
      const salutation = `Dear ${t.title || (a.juris && JSON.parse(a.juris).chamber === 'upper' ? 'Senator' : 'Representative')} ${t.name.split(' ').slice(-1)[0]},`;
      const body = `${salutation}\n\n${message.replace(/^dear [^\n]*\n+/i, '')}\n\n${name}\n${d.matched}\n${email}\n\n--\n${unverified ? 'The address above is as the sender typed it; it could not be matched automatically.\n' : ''}Sent by a constituent through ${org ? org.name : 'an advocacy'} action page on Headcount. Reply to this email to reach ${name} directly.`;
      if (mail.queue({ to: t.email, kind: 'constituent', replyTo: email, subject, text: body, dedupe: `act:${a.id}:${t.id}:${email.toLowerCase()}:${new Date().toISOString().slice(0, 10)}` })) emailed++;
    }
    q.respond.run(a.id, a.org_id, Date.now(), name, email.toLowerCase(), d.matched, d.state, JSON.stringify(mine.map((t) => t.id)), emailed, b.optin ? 1 : 0, edited ? 1 : 0);
    return {
      emailed: mine.filter((t) => t.email && mail.enabled).map((t) => t.name),
      call: mine.filter((t) => t.phone).map((t) => ({ name: t.name, phone: t.phone })),
      forms: mine.filter((t) => !(t.email && mail.enabled) && t.form).map((t) => ({ name: t.name, url: t.form })),
    };
  }

  const exportOrg = (oid) => q.orgResponses.all(oid).map((r) => ({ action: r.action_title, at: new Date(r.at).toISOString(), name: r.name, email: r.optin ? r.email : '', state: r.state, optin: Boolean(r.optin) }));
  return { get, save, responses, publicView, lookup, send, exportOrg };
}
