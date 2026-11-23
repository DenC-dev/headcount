import crypto from 'node:crypto';
import { HttpError, CONTACT_TYPES } from './db.js';

// Legislators across every campaign: where each one stands on each of the
// team's bills, a score for how often they are with you, the last time anyone
// talked to them, and their whole history with the team. Built from the
// campaigns' own records, so it is as current as the counts are.

const POS = ['No', 'Lean no', 'Undecided', 'Lean yes', 'Yes'];
const normName = (s) => String(s || '').toLowerCase().replace(/\b(sen|rep|del|asm)\.?\s+/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

export function makePeople(store) {
  // History notes who did it by user id; show their name.
  const names = new Map();
  const who = (id) => { if (!id) return ''; if (!names.has(id)) { const u = store.q.user.get(id); names.set(id, u ? u.name || u.email || '' : /^[a-z]+:/i.test(id) ? '' : String(id)); } return names.get(id); };
  const meta = (cid) => { const r = store.q.record.get(cid, 'meta', 'meta'); try { return r ? JSON.parse(r.data) : {}; } catch (_) { return {}; } };

  function gather(oid, uid) {
    store.needOrg(oid, uid, 'member');
    const people = new Map();
    for (const c of store.listOrgCampaigns(oid, uid)) {
      if (c.archived) continue;
      const m0 = meta(c.id), camp = m0.campaign || {}, side = camp.side === 'defeat' ? 'defeat' : 'pass', chamber = camp.chamber || '';
      for (const r of store.q.recordsOf.all(c.id, 'members')) {
        let m; try { m = JSON.parse(r.data); } catch (_) { continue; }
        if (!m || !m.name || m.draft) continue;
        // The same person in two campaigns: the official list's id, else name, party and district
        const key = m.ref ? `r_${String(m.ref).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80)}` : `n_${crypto.createHash('sha1').update(`${normName(m.name)}|${m.party || ''}|${String(m.district || '').replace(/^0+/, '')}`).digest('hex').slice(0, 16)}`;
        if (!people.has(key)) people.set(key, { key, name: m.name, party: m.party || '', district: m.district || '', chamber, positions: [], history: [], staff: [], phone: '', email: '', office: '', committees: new Set() });
        const p = people.get(key);
        const pos = typeof m.pos === 'number' ? m.pos : 2, withUs = side === 'pass' ? pos >= 3 : pos <= 1, against = side === 'pass' ? pos <= 1 : pos >= 3;
        p.positions.push({ campaignId: c.id, campaign: c.name, client: c.client || '', side, pos, word: POS[pos] || 'Undecided', withUs, against, movable: m.mov || 3, committee: Boolean(m.cmte), role: m.role || '' });
        if (m.cmte && camp.committee) p.committees.add(`${camp.committee}${m.role ? ` (${m.role})` : ''}`);
        for (const h of m.history || []) p.history.push({ d: h.d, type: h.type, note: h.note || '', by: who(h.by), campaign: c.name, campaignId: c.id });
        if (!p.staff.length && Array.isArray(m.staffers)) p.staff = m.staffers.slice(0, 12).map((s) => ({ name: s.name, title: s.title || '', email: s.email || '', phone: s.phone || '' }));
        const cc = m.c || {};
        p.phone = p.phone || m.phone || cc.ph || ''; p.email = p.email || m.email || cc.em || ''; p.office = p.office || cc.of || '';
        if (!p.chamber && chamber) p.chamber = chamber;
      }
    }
    return people;
  }

  const summary = (p) => {
    const contacts = p.history.filter((h) => CONTACT_TYPES.has(h.type)).sort((a, b) => String(b.d).localeCompare(String(a.d)));
    const firm = p.positions.filter((x) => x.pos !== 2), withUs = p.positions.filter((x) => x.withUs).length, against = p.positions.filter((x) => x.against).length;
    return { key: p.key, name: p.name, party: p.party, district: p.district, chamber: p.chamber, bills: p.positions.length, withUs, against,
      score: firm.length ? Math.round((withUs / p.positions.length) * 100) : null, lastContact: contacts[0] ? contacts[0].d : '', contacts: contacts.length,
      positions: p.positions.map(({ campaignId, campaign, word, withUs: w, against: a, side }) => ({ campaignId, campaign, word, withUs: w, against: a, side })) };
  };

  function list(oid, uid) {
    const people = [...gather(oid, uid).values()].map(summary);
    people.sort((a, b) => b.bills - a.bills || String(a.name).localeCompare(String(b.name)));
    return { people };
  }

  function profile(oid, uid, key) {
    const p = gather(oid, uid).get(String(key || ''));
    if (!p) throw new HttpError(404, 'That legislator is not in any of your campaigns.');
    return { ...summary(p), phone: p.phone, email: p.email, office: p.office, staff: p.staff, committees: [...p.committees],
      positions: p.positions, history: p.history.sort((a, b) => String(b.d).localeCompare(String(a.d))).slice(0, 80) };
  }
  return { list, profile };
}
