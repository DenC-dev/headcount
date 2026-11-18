import { htmlEmail, esc } from './mail.js';
import { CONTACT_TYPES } from './db.js';
import { describeItem } from './monitor.js';

// What Headcount emails people about, and the daily or weekly digest.

const POS = ['No', 'Lean no', 'Undecided', 'Lean yes', 'Yes'];
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (date) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function localParts(now, tz) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now); }
  catch (_) { parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}

export function makeNotifier(cfg, store, mail, monitor = null) {
  const app = `${cfg.publicUrl}/app`;
  const user = (id) => store.q.user.get(id);
  const footer = (uid, kind, what) => {
    const parts = [`You get this email because you use Headcount${what ? ` and ${what}` : ''}.`, `<a href="${esc(app)}#email">Email settings</a>`];
    if (uid && kind) parts.push(`<a href="${esc(`${cfg.publicUrl}/api/unsubscribe?t=${mail.unsubToken(uid, kind)}`)}">Unsubscribe</a>`);
    return parts.join(' · ');
  };
  const textFooter = (uid, kind) => `\n\n--\nEmail settings: ${app}#email${uid && kind ? `\nUnsubscribe: ${cfg.publicUrl}/api/unsubscribe?t=${mail.unsubToken(uid, kind)}` : ''}`;

  function handle(e) {
    try {
      if (e.type === 'task.assigned') return assigned(e);
      if (e.type === 'campaign.added') return added(e);
      if (e.type === 'billing.payment_failed') return paymentFailed(e.org);
    } catch (err) { console.error('Notification failed', e.type, err.message); }
  }

  function assigned({ cid, by, task }) {
    const to = user(task.assignee), from = user(by), c = store.q.campaign.get(cid);
    if (!to || !to.email || !c || !store.campaignRole(cid, to.id) || !store.getPrefs(to.id).notifyAssigned) return;
    const who = (from && from.name) || 'A teammate';
    const lines = [`${who} assigned you a follow-up on ${c.name}:`, task.text, task.due ? `Due ${fmtDay(task.due)}.` : ''].filter(Boolean);
    mail.queue({ to: to.email, userId: to.id, kind: 'assigned', unsubscribeKind: 'assigned', dedupe: `assigned:${cid}:${task.id}:${to.id}`,
      subject: `${who} assigned you a follow-up: ${String(task.text).slice(0, 70)}`, replyTo: from && from.email,
      text: `${lines.join('\n\n')}\n\nOpen Headcount: ${app}${textFooter(to.id, 'assigned')}`,
      html: htmlEmail({ heading: 'A follow-up for you', blocks: [{ p: `${who} assigned you a follow-up on ${c.name}:` }, { list: [task.text + (task.due ? ` (due ${fmtDay(task.due)})` : '')] }], action: { url: app, label: 'Open Headcount' }, footer: footer(to.id, 'assigned', 'a teammate assigned you a follow-up') }) });
  }

  function added({ cid, by, target, role }) {
    const to = user(target), from = user(by), c = store.q.campaign.get(cid);
    if (!to || !to.email || !c || !store.getPrefs(to.id).notifyAdded) return;
    const who = (from && from.name) || 'A teammate', what = role === 'viewer' ? 'see' : 'work on';
    mail.queue({ to: to.email, userId: to.id, kind: 'added', unsubscribeKind: 'added', dedupe: `added:${cid}:${to.id}`,
      subject: `${who} added you to ${c.name}`, replyTo: from && from.email,
      text: `${who} added you to ${c.name} on Headcount, so you can ${what} the vote count, meetings and bill brief.\n\nOpen Headcount: ${app}${textFooter(to.id, 'added')}`,
      html: htmlEmail({ heading: `You were added to ${c.name}`, blocks: [{ p: `${who} added you to ${c.name} on Headcount, so you can ${what} the vote count, meetings and bill brief.` }], action: { url: app, label: 'Open the campaign' }, footer: footer(to.id, 'added', 'a teammate added you to a campaign') }) });
  }

  function paymentFailed(org) {
    for (const a of store.q.admins.all(org.id)) {
      mail.queue({ to: a.email, userId: a.id, kind: 'billing', dedupe: `payfail:${org.id}:${new Date().toISOString().slice(0, 10)}:${a.id}`,
        subject: `Payment failed for ${org.name} on Headcount`,
        text: `The latest payment for ${org.name} did not go through. Update the card in Workspace, then Plan, to keep your plan.\n\n${app}`,
        html: htmlEmail({ heading: 'A payment did not go through', blocks: [{ p: `The latest payment for ${org.name} did not go through. Update the card to keep your plan.` }], action: { url: app, label: 'Update payment' }, footer: footer(null, null, `you manage ${org.name}`) }) });
    }
  }

  // Instant Monitor alerts, for people who asked for them.
  function monitorAlert({ org, items }) {
    if (!org || !items.length) return 0;
    let n = 0;
    for (const m of store.q.members.all(org.id)) {
      if (m.role === 'guest' || !m.email || store.getPrefs(m.id).monitor !== 'instant' || store.blocked(org, m.id, m.role)) continue;
      const fresh = items.filter((i) => i.state !== 'tracked'), moved = items.filter((i) => i.state === 'tracked');
      const lines = (list) => list.map((i) => `${describeItem(i)}${i.reason && i.state !== 'tracked' ? `. ${i.reason}` : ''}`);
      const blocks = [];
      if (fresh.length) blocks.push({ title: `New and relevant (${fresh.length})` }, { list: lines(fresh) });
      if (moved.length) blocks.push({ title: `Tracked items that moved (${moved.length})` }, { list: lines(moved) });
      const subject = fresh.length ? `${org.name} Monitor: ${fresh.length === 1 ? describeItem(fresh[0]).slice(0, 90) : `${fresh.length} new items worth a look`}` : `${org.name} Monitor: ${moved.length === 1 ? describeItem(moved[0]).slice(0, 90) : `${moved.length} tracked items moved`}`;
      mail.queue({ to: m.email, userId: m.id, kind: 'monitor', unsubscribeKind: 'monitor', dedupe: `monitor:${org.id}:${m.id}:${items.map((i) => `${i.id}.${i.changedAt || 0}`).join(',').slice(0, 150)}`,
        subject, text: `${blocks.map((b) => (b.title ? `\n${b.title}` : b.list.map((l) => `- ${l}`).join('\n'))).join('\n').trim()}\n\nOpen the Monitor: ${app}#monitor${textFooter(m.id, 'monitor')}`,
        html: htmlEmail({ heading: `New in the ${org.name} Monitor`, blocks, action: { url: `${app}#monitor`, label: 'Open the Monitor' }, footer: footer(m.id, 'monitor', 'you asked for instant Monitor alerts') }) });
      n++;
    }
    return n;
  }

  function orgInvite({ org, inviter, email, role, link }) {
    const who = (inviter && inviter.name) || 'A colleague', as = role === 'guest' ? 'a guest' : role === 'admin' ? 'an admin' : 'a member';
    return mail.queue({ to: email, kind: 'invite', replyTo: inviter && inviter.email, dedupe: `invite:${link}`,
      subject: `${who} invited you to ${org.name} on Headcount`,
      text: `${who} invited you to join ${org.name} on Headcount as ${as}. Headcount is where the team keeps its vote counts, meetings and bill briefs.\n\nAccept the invitation (it works for 14 days, only for ${email}):\n${link}`,
      html: htmlEmail({ heading: `Join ${org.name} on Headcount`, blocks: [{ p: `${who} invited you to join ${org.name} as ${as}. Headcount is where the team keeps its vote counts, meetings and bill briefs.` }, { p: `The invitation works for 14 days, only for ${email}.` }], action: { url: link, label: 'Accept the invitation' }, footer: `You get this email because ${esc(who)} invited ${esc(email)}.` }) });
  }

  function trialNotices(nowMs = Date.now()) {
    let n = 0;
    for (const o of store.q.trialEnding.all(nowMs + 2 * 864e5, nowMs + 3 * 864e5)) {
      for (const a of store.q.admins.all(o.id)) {
        mail.queue({ to: a.email, userId: a.id, kind: 'trial', dedupe: `trial:${o.id}:${a.id}`,
          subject: `${o.name}: your Headcount trial ends in 3 days`,
          text: `The Team trial for ${o.name} ends in 3 days. Choose a plan in Workspace to keep the Team features. Nothing is deleted if you do not: the workspace moves to the Free plan.\n\n${app}`,
          html: htmlEmail({ heading: 'Your trial ends in 3 days', blocks: [{ p: `The Team trial for ${o.name} ends in 3 days. Choose a plan to keep the Team features.` }, { p: 'Nothing is deleted if you do not: the workspace moves to the Free plan.' }], action: { url: app, label: 'See plans' }, footer: footer(null, null, `you manage ${o.name}`) }) });
        n++;
      }
      store.q.trialNoticed.run(o.id);
    }
    return n;
  }

  // ---------- digests ----------
  function digestFor(u, since, today, period) {
    const sections = []; const totals = { moves: 0, overdue: 0, contacts: 0, votes: 0 };
    for (const o of store.q.userOrgs.all(u.id)) {
      if (store.blocked(o, u.id, o.my_role)) continue;
      for (const c of store.q.orgCampaigns.all(o.id)) {
        if (c.archived || !store.campaignRole(c.id, u.id)) continue;
        const s = c.summary ? JSON.parse(c.summary) : {};
        const moves = []; let contacts = 0;
        for (const r of store.q.recordsOf.all(c.id, 'members')) {
          const m = JSON.parse(r.data);
          for (const h of m.history || []) {
            if (!(h.d >= since)) continue;
            if (h.from !== h.to && POS[h.from] && POS[h.to]) moves.push(`${m.name}: ${POS[h.from]} to ${POS[h.to]}`);
            if (CONTACT_TYPES.has(h.type)) contacts++;
          }
        }
        const tasks = store.q.recordsOf.all(c.id, 'tasks').map((r) => JSON.parse(r.data)).filter((t) => !t.done && (!t.assignee || t.assignee === u.id));
        const overdue = tasks.filter((t) => t.due && t.due < today), soon = tasks.filter((t) => t.due && t.due >= today && t.due <= addDays(today, 3));
        const votes = [['Committee vote', s.cmteDate], ['Floor vote', s.floorDate]].filter(([, d]) => d && d >= today && d <= addDays(today, 7));
        const meetings = (s.meetings || []).filter((m) => { const d = String(m.start).slice(0, 10); return d >= today && d <= addDays(today, 7); });
        const then = (s.trend || []).filter((t) => t.d <= since).slice(-1)[0];
        const delta = typeof s.odds === 'number' && then ? Math.round((s.odds - then.p) * 100) : 0;
        if (!moves.length && !contacts && !overdue.length && !soon.length && !votes.length && !meetings.length && !delta) continue;
        const lines = [];
        if (typeof s.odds === 'number') lines.push(`Odds ${s.side === 'defeat' ? 'of defeating it' : 'of passage'}: ${Math.round(s.odds * 100)}%${delta ? ` (${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'})` : ''}`);
        if (moves.length) lines.push(`Moved: ${moves.slice(0, 6).join('; ')}${moves.length > 6 ? `; and ${moves.length - 6} more` : ''}`);
        if (contacts) lines.push(`${plural(contacts, 'contact')} logged by the team`);
        votes.forEach(([k, d]) => lines.push(`${k} ${fmtDay(d)}`));
        meetings.forEach((m) => lines.push(`Meeting: ${m.title}, ${new Date(m.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: u.tz || 'UTC' })}`));
        overdue.forEach((t) => lines.push(`Overdue follow-up: ${t.text} (was due ${fmtDay(t.due)})`));
        soon.forEach((t) => lines.push(`Follow-up due ${fmtDay(t.due)}: ${t.text}`));
        totals.moves += moves.length; totals.overdue += overdue.length; totals.contacts += contacts; totals.votes += votes.length;
        sections.push({ title: c.name, sub: [store.clientName(c.client_id), o.name].filter(Boolean).join(' · '), lines });
      }
    }
    if (monitor && u.monitor !== 'off') {
      const sinceMs = Date.parse(`${since}T00:00:00Z`);
      for (const o of store.q.userOrgs.all(u.id)) {
        if (o.my_role === 'guest' || store.blocked(o, u.id, o.my_role)) continue;
        const found = monitor.forDigest(o.id, sinceMs);
        if (!found.length) continue;
        totals.monitor = (totals.monitor || 0) + found.length;
        sections.push({ title: `Monitor: ${o.name}`, sub: 'New bills, rules and contract notices that match your watches', lines: found.map((i) => `${describeItem(i)}${i.state !== 'tracked' && i.reason ? `. ${i.reason}` : ''}`) });
      }
    }
    if (!sections.length) return null;
    const bits = [totals.moves && plural(totals.moves, 'position change'), totals.monitor && plural(totals.monitor, 'new Monitor item'), totals.votes && plural(totals.votes, 'vote') + ' coming up', totals.overdue && plural(totals.overdue, 'overdue follow-up'), totals.contacts && plural(totals.contacts, 'contact')].filter(Boolean);
    const heading = period === 'daily' ? `Headcount for ${fmtDay(today)}` : `Your week in Headcount`;
    return {
      subject: `${heading}: ${bits.slice(0, 2).join(', ') || plural(sections.length, 'campaign') + ' to look at'}`,
      text: `${heading}\n\n${sections.map((x) => `${x.title}${x.sub ? ` (${x.sub})` : ''}\n${x.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')}\n\nOpen Headcount: ${app}${textFooter(u.id, 'digest')}`,
      html: htmlEmail({ heading, blocks: sections.flatMap((x) => [{ title: x.title, sub: x.sub }, { list: x.lines }]), action: { url: app, label: 'Open Headcount' }, footer: footer(u.id, 'digest', `you get a ${period} digest`) }),
    };
  }

  // Sends digests that are due: daily ones every day, weekly ones on Monday,
  // at each person's chosen hour in their own time zone.
  function digests(now = new Date()) {
    let sent = 0;
    for (const u of store.q.digestUsers.all()) {
      const loc = localParts(now, u.tz);
      if (loc.hour < u.digest_hour || u.last_digest === loc.date) continue;
      if (u.digest === 'weekly' && loc.weekday !== 'Mon') continue;
      const since = u.last_digest || addDays(loc.date, u.digest === 'daily' ? -1 : -7);
      const d = digestFor(u, since, loc.date, u.digest);
      store.q.setLastDigest.run(u.id, loc.date);
      if (d && mail.queue({ to: u.email, userId: u.id, kind: 'digest', unsubscribeKind: 'digest', dedupe: `digest:${u.id}:${loc.date}`, ...d })) sent++;
    }
    return sent;
  }

  function contact(lead) {
    if (!cfg.salesEmail) return false;
    return mail.queue({ to: cfg.salesEmail, kind: 'lead', replyTo: lead.email, subject: `Demo request: ${lead.firm || lead.name}`,
      text: `Name: ${lead.name}\nEmail: ${lead.email}\nOrganization: ${lead.firm}\nTeam size: ${lead.size}\n\n${lead.message}` });
  }

  return { handle, orgInvite, trialNotices, digests, digestFor, contact, monitorAlert };
}
