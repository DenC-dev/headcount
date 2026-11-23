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

const KIND_WORD = { bill: 'Bill', reg: 'Rule', contract: 'Contract' };
// One Monitor item in an email: what it is, where, why it matters.
function monitorItem(i) {
  const where = i.kind === 'bill' ? (i.juris === 'US' ? 'Congress' : i.juris) : i.agency;
  const moved = i.state === 'tracked' && i.changedAt;
  return { chip: moved ? { text: 'Moved', tone: 'warn' } : typeof i.score === 'number' ? { text: `${KIND_WORD[i.kind] || 'Item'} · ${i.score} match`, tone: i.score >= 80 ? 'good' : 'info' } : { text: KIND_WORD[i.kind] || 'Item', tone: 'info' },
    title: [i.number, i.title].filter(Boolean).join(': '), url: i.url || '',
    meta: [where, moved ? `now "${i.status}"` : i.status, i.deadline ? `${i.kind === 'reg' ? 'comments due' : 'responses due'} ${i.deadline}` : ''].filter(Boolean).join(' · '),
    note: !moved && i.reason ? i.reason : '' };
}

export function makeNotifier(cfg, store, mail, monitor = null, tracker = null) {
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
      if (e.type === 'billing.risk') return riskAlert(e);
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
      html: htmlEmail({ eyebrow: 'Follow-up', heading: 'A follow-up for you', preheader: `${who}: ${task.text}`,
        blocks: [{ p: `${who} assigned you a follow-up on ${c.name}.` }, { quote: task.text, by: task.due ? `Due ${fmtDay(task.due)}` : 'No due date' }],
        action: { url: `${app}#open=${encodeURIComponent(cid)}`, label: 'Open the campaign' }, footer: footer(to.id, 'assigned', 'a teammate assigned you a follow-up') }) });
  }

  // The campaign at a glance: its odds and where its bill stands.
  function campaignCard(c) {
    const s = c.summary ? JSON.parse(c.summary) : null; if (!s) return [];
    const stage = tracker ? tracker.stageFor(s) : null;
    return [{ card: { title: c.name, sub: [store.clientName(c.client_id), s.bill].filter(Boolean).join(' · '),
      odds: typeof s.odds === 'number' ? { pct: Math.round(s.odds * 100), label: s.side === 'defeat' ? 'odds of defeating it' : 'odds of passage' } : null,
      rows: [stage && stage.now ? { label: 'The bill', text: stage.now } : null, s.cmteDate ? { label: 'Committee', text: fmtDay(s.cmteDate), tone: 'info' } : null, s.floorDate ? { label: 'Floor vote', text: fmtDay(s.floorDate), tone: 'info' } : null].filter(Boolean) } }];
  }

  function added({ cid, by, target, role }) {
    const to = user(target), from = user(by), c = store.q.campaign.get(cid);
    if (!to || !to.email || !c || !store.getPrefs(to.id).notifyAdded) return;
    const who = (from && from.name) || 'A teammate', what = role === 'viewer' ? 'see' : 'work on';
    mail.queue({ to: to.email, userId: to.id, kind: 'added', unsubscribeKind: 'added', dedupe: `added:${cid}:${to.id}`,
      subject: `${who} added you to ${c.name}`, replyTo: from && from.email,
      text: `${who} added you to ${c.name} on Headcount, so you can ${what} the vote count, meetings and bill brief.\n\nOpen Headcount: ${app}${textFooter(to.id, 'added')}`,
      html: htmlEmail({ eyebrow: 'Campaign', heading: `You're on ${c.name}`, preheader: `${who} added you to ${c.name}.`,
        blocks: [{ lead: `${who} added you to ${c.name}, so you can ${what} the vote count, the meetings and the bill brief.` }, ...campaignCard(c)],
        action: { url: `${app}#open=${encodeURIComponent(cid)}`, label: 'Open the campaign' }, footer: footer(to.id, 'added', 'a teammate added you to a campaign') }) });
  }

  function paymentFailed(org) {
    for (const a of store.q.admins.all(org.id)) {
      mail.queue({ to: a.email, userId: a.id, kind: 'billing', dedupe: `payfail:${org.id}:${new Date().toISOString().slice(0, 10)}:${a.id}`,
        subject: `Payment failed for ${org.name} on Headcount`,
        text: `The latest payment for ${org.name} did not go through. Update the card in Workspace, then Plan, to keep your plan.\n\n${app}`,
        html: htmlEmail({ eyebrow: 'Billing', heading: 'A payment did not go through', blocks: [{ lead: `The latest payment for ${org.name} did not go through.` }, { p: 'Update the card in Workspace, then Plan, to keep your plan.' }, { callout: 'Nothing is deleted. If the card is not updated, the workspace moves to the Free plan.', tone: 'warn' }], action: { url: app, label: 'Update payment' }, footer: footer(null, null, `you manage ${org.name}`) }) });
    }
  }

  // Disputes, refunds and fraud warnings go to whoever runs Headcount (and the
  // support address), because the money is theirs. They act on it in Stripe.
  function riskAlert({ kind, org, amount, currency, charge, reason }) {
    const op = store.setting('operator') ? store.q.user.get(store.setting('operator')) : null;
    const to = [...new Set([op && op.email, cfg.supportEmail].filter(Boolean).map((x) => String(x).toLowerCase()))];
    const money = typeof amount === 'number' ? `${(amount / 100).toLocaleString('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase() })} ` : '';
    const who = org ? org.name : 'a customer';
    const what = { disputed: [`A customer disputed a payment`, `${who} disputed a ${money}payment${reason ? ` (reason given: ${String(reason).replace(/_/g, ' ')})` : ''}. Respond in Stripe before the deadline it shows, with any evidence you have, or the money goes back to them.`],
      refunded: [`A payment was refunded`, `A ${money}payment from ${who} was refunded. If this was not you, check your Stripe account.`],
      fraud_warning: [`Stripe flagged a payment as possible fraud`, `Stripe's card networks flagged a ${money}payment from ${who} as possibly fraudulent${reason ? ` (${String(reason).replace(/_/g, ' ')})` : ''}. Consider refunding it in Stripe now; a refund avoids a dispute and its fee.`] }[kind];
    if (!what || !to.length) return;
    const link = charge ? `https://dashboard.stripe.com/payments/${encodeURIComponent(charge)}` : 'https://dashboard.stripe.com/payments';
    for (const addr of to) {
      mail.queue({ to: addr, kind: 'billing', dedupe: `risk:${kind}:${charge || org && org.id || 'x'}:${addr}`,
        subject: `${what[0]} (${who})`, text: `${what[1]}\n\nOpen it in Stripe: ${link}`,
        html: htmlEmail({ eyebrow: 'Payments', heading: what[0], blocks: [{ callout: what[1], tone: kind === 'refunded' ? 'info' : 'bad' }], action: { url: link, label: 'Open in Stripe' }, footer: footer(null, null, 'you run this Headcount') }) });
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
      const blocks = [], textBlocks = [];
      if (fresh.length) { blocks.push({ title: `New and relevant (${fresh.length})` }, { items: fresh.map(monitorItem) }); textBlocks.push({ title: `New and relevant (${fresh.length})` }, { list: lines(fresh) }); }
      if (moved.length) { blocks.push({ title: `Tracked items that moved (${moved.length})` }, { items: moved.map(monitorItem) }); textBlocks.push({ title: `Tracked items that moved (${moved.length})` }, { list: lines(moved) }); }
      const subject = fresh.length ? `${org.name} Monitor: ${fresh.length === 1 ? describeItem(fresh[0]).slice(0, 90) : `${fresh.length} new items worth a look`}` : `${org.name} Monitor: ${moved.length === 1 ? describeItem(moved[0]).slice(0, 90) : `${moved.length} tracked items moved`}`;
      mail.queue({ to: m.email, userId: m.id, kind: 'monitor', unsubscribeKind: 'monitor', dedupe: `monitor:${org.id}:${m.id}:${items.map((i) => `${i.id}.${i.changedAt || 0}`).join(',').slice(0, 150)}`,
        subject, text: `${textBlocks.map((b) => (b.title ? `\n${b.title}` : b.list.map((l) => `- ${l}`).join('\n'))).join('\n').trim()}\n\nOpen the Monitor: ${app}#monitor${textFooter(m.id, 'monitor')}`,
        html: htmlEmail({ eyebrow: 'Monitor alert', heading: `New in the ${org.name} Monitor`, preheader: subject, blocks: [{ stats: [[String(fresh.length), 'new and relevant', fresh.length ? 'good' : ''], [String(moved.length), 'tracked items moved', moved.length ? 'warn' : '']] }, ...blocks], action: { url: `${app}#monitor`, label: 'Open the Monitor' }, footer: footer(m.id, 'monitor', 'you asked for instant Monitor alerts') }) });
      n++;
    }
    return n;
  }

  function orgInvite({ org, inviter, email, role, link }) {
    const who = (inviter && inviter.name) || 'A colleague', as = role === 'guest' ? 'a guest' : role === 'admin' ? 'an admin' : 'a member';
    return mail.queue({ to: email, kind: 'invite', replyTo: inviter && inviter.email, dedupe: `invite:${link}`,
      subject: `${who} invited you to ${org.name} on Headcount`,
      text: `${who} invited you to join ${org.name} on Headcount as ${as}. Headcount is where the team keeps its vote counts, meetings and bill briefs.\n\nAccept the invitation (it works for 14 days, only for ${email}):\n${link}`,
      html: htmlEmail({ eyebrow: 'Invitation', heading: `Join ${org.name} on Headcount`, preheader: `${who} invited you to join ${org.name}.`,
        blocks: [{ lead: `${who} invited you to join ${org.name} as ${as}.` }, { p: 'Headcount is where the team keeps its work on each bill:' },
          { list: ['The whip count: where every member stands, and the odds it passes', 'Meeting requests to the right staffer, and every contact logged', 'Each bill followed as it moves, with hearings and votes in plain words'] },
          { kv: [['Workspace', org.name], ['Your role', as.replace(/^an? /, '').replace(/^\w/, (x) => x.toUpperCase())], ['Invited by', who]] }],
        action: { url: link, label: 'Accept the invitation' }, after: [{ link }, { small: `The invitation works for 14 days, only for ${email}.` }], footer: `You get this email because ${esc(who)} invited ${esc(email)}.` }) });
  }

  function trialNotices(nowMs = Date.now()) {
    let n = 0;
    for (const o of store.q.trialEnding.all(nowMs + 2 * 864e5, nowMs + 3 * 864e5)) {
      for (const a of store.q.admins.all(o.id)) {
        mail.queue({ to: a.email, userId: a.id, kind: 'trial', dedupe: `trial:${o.id}:${a.id}`,
          subject: `${o.name}: your Headcount trial ends in 3 days`,
          text: `The Team trial for ${o.name} ends in 3 days. Choose a plan in Workspace to keep the Team features. Nothing is deleted if you do not: the workspace moves to the Free plan.\n\n${app}`,
          html: htmlEmail({ eyebrow: 'Trial', heading: 'Your trial ends in 3 days', blocks: [{ lead: `The Team trial for ${o.name} ends in 3 days.` }, { p: 'Choose a plan to keep supporter pages, client guests, unlimited campaigns and the quarterly activity report.' }, { callout: 'Nothing is deleted if you do not: the workspace moves to the Free plan.', tone: 'info' }], action: { url: app, label: 'See plans' }, footer: footer(null, null, `you manage ${o.name}`) }) });
        n++;
      }
      store.q.trialNoticed.run(o.id);
    }
    return n;
  }

  // ---------- digests ----------
  function digestFor(u, since, today, period) {
    const sections = [], cards = []; const totals = { moves: 0, overdue: 0, contacts: 0, votes: 0, bills: 0 };
    const sinceMs = Date.parse(`${since}T00:00:00Z`);
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
        const moved = tracker ? tracker.newsFor(s, sinceMs) : [];
        const stage = tracker ? tracker.stageFor(s) : null;
        const delta = typeof s.odds === 'number' && then ? Math.round((s.odds - then.p) * 100) : 0;
        if (!moves.length && !contacts && !overdue.length && !soon.length && !votes.length && !meetings.length && !delta && !moved.length) continue;
        const when = (m) => new Date(m.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: u.tz || 'UTC' });
        const lines = [];
        if (typeof s.odds === 'number') lines.push(`Odds ${s.side === 'defeat' ? 'of defeating it' : 'of passage'}: ${Math.round(s.odds * 100)}%${delta ? ` (${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'})` : ''}`);
        moved.forEach((x) => lines.push(`The bill: ${x.plain}${x.date ? ` (${fmtDay(x.date)})` : ''}`));
        if (moves.length) lines.push(`Moved: ${moves.slice(0, 6).join('; ')}${moves.length > 6 ? `; and ${moves.length - 6} more` : ''}`);
        if (contacts) lines.push(`${plural(contacts, 'contact')} logged by the team`);
        votes.forEach(([k, d]) => lines.push(`${k} ${fmtDay(d)}`));
        meetings.forEach((m) => lines.push(`Meeting: ${m.title}, ${when(m)}`));
        overdue.forEach((t) => lines.push(`Overdue follow-up: ${t.text} (was due ${fmtDay(t.due)})`));
        soon.forEach((t) => lines.push(`Follow-up due ${fmtDay(t.due)}: ${t.text}`));
        totals.bills += moved.length; totals.moves += moves.length; totals.overdue += overdue.length; totals.contacts += contacts; totals.votes += votes.length;
        const sub = [store.clientName(c.client_id), o.name].filter(Boolean).join(' · ');
        sections.push({ title: c.name, sub, lines });
        // The same, laid out as a card for the HTML email
        // counts run Yes, Lean yes, Undecided, Lean no, No
        const cnt = s.counts || [0, 0, 0, 0, 0], haveFor = s.side === 'defeat' ? cnt[3] + cnt[4] : cnt[0] + cnt[1], have = s.side === 'defeat' ? cnt[0] + cnt[1] : cnt[3] + cnt[4];
        const need = s.side === 'defeat' ? (s.n || 0) - (s.needF || 0) + 1 : s.needF;
        cards.push({ card: {
          title: c.name, sub, url: `${app}#open=${encodeURIComponent(c.id)}`,
          chip: overdue.length ? { text: `${overdue.length} overdue`, tone: 'bad' } : moved.length ? { text: 'Bill moved', tone: 'warn' } : null,
          odds: typeof s.odds === 'number' ? { pct: Math.round(s.odds * 100), text: s.odds >= 0.995 ? '>99%' : s.odds < 0.005 ? '<1%' : `${Math.round(s.odds * 100)}%`, label: s.side === 'defeat' ? 'odds of defeating it' : 'odds of passage', delta, period: period === 'daily' ? 'day' : 'week' } : null,
          bar: need ? { have: haveFor, need, text: `${haveFor >= need ? `${haveFor} votes: ${haveFor - need} more than the ${need} ${s.side === 'defeat' ? 'needed to block it' : 'needed to pass'}` : `${haveFor} of the ${need} votes ${s.side === 'defeat' ? 'needed to block it' : 'needed to pass'}`}${have ? ` · ${have} against` : ''}` } : null,
          rows: [
            stage && stage.now ? { label: 'The bill', text: stage.now } : null,
            ...moved.map((x) => ({ label: x.date ? fmtDay(x.date) : 'Moved', text: x.plain, tone: 'warn' })),
            moves.length ? { label: 'Positions', text: `${moves.slice(0, 4).join('; ')}${moves.length > 4 ? `; and ${moves.length - 4} more` : ''}` } : null,
            contacts ? { label: 'Contacts', text: `${plural(contacts, 'contact')} logged by the team` } : null,
            ...votes.map(([k, d]) => ({ label: 'Coming up', text: `${k}, ${fmtDay(d)}`, tone: 'info' })),
            ...meetings.map((m) => ({ label: 'Meeting', text: `${m.title}, ${when(m)}`, tone: 'info' })),
            ...overdue.map((t) => ({ label: 'Overdue', text: `${t.text} (was due ${fmtDay(t.due)})`, tone: 'bad' })),
            ...soon.map((t) => ({ label: 'Due soon', text: `${t.text} (${fmtDay(t.due)})` })),
          ].filter(Boolean),
          action: { url: `${app}#open=${encodeURIComponent(c.id)}`, label: 'Open the count' },
        } });
      }
    }
    const monitorBlocks = [];
    if (monitor && u.monitor !== 'off') {
      for (const o of store.q.userOrgs.all(u.id)) {
        if (o.my_role === 'guest' || store.blocked(o, u.id, o.my_role)) continue;
        const found = monitor.forDigest(o.id, sinceMs);
        if (!found.length) continue;
        totals.monitor = (totals.monitor || 0) + found.length;
        sections.push({ title: `Monitor: ${o.name}`, sub: 'New bills, rules and contract notices that match your watches', lines: found.map((i) => `${describeItem(i)}${i.state !== 'tracked' && i.reason ? `. ${i.reason}` : ''}`) });
        monitorBlocks.push({ title: `Monitor: ${o.name}`, sub: 'New bills, rules and contract notices that match your watches' }, { items: found.map(monitorItem) });
      }
    }
    if (!sections.length) return null;
    const bits = [totals.bills && plural(totals.bills, 'bill update'), totals.moves && plural(totals.moves, 'position change'), totals.monitor && plural(totals.monitor, 'new Monitor item'), totals.votes && plural(totals.votes, 'vote') + ' coming up', totals.overdue && plural(totals.overdue, 'overdue follow-up'), totals.contacts && plural(totals.contacts, 'contact') + ' logged'].filter(Boolean);
    const heading = period === 'daily' ? `Headcount for ${fmtDay(today)}` : `Your week in Headcount`;
    const stats = [[String(cards.length), plural(cards.length, 'campaign').replace(/^\d+ /, '') + ' to look at'], [String(totals.bills + totals.moves), 'bill and position moves', totals.bills + totals.moves ? 'warn' : ''], [String(totals.votes + totals.overdue), totals.overdue ? 'votes and overdue items' : 'votes coming up', totals.overdue ? 'bad' : '']];
    return {
      subject: `${heading}: ${bits.slice(0, 2).join(', ') || plural(sections.length, 'campaign') + ' to look at'}`,
      text: `${heading}\n\n${sections.map((x) => `${x.title}${x.sub ? ` (${x.sub})` : ''}\n${x.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')}\n\nOpen Headcount: ${app}${textFooter(u.id, 'digest')}`,
      html: htmlEmail({ eyebrow: period === 'daily' ? 'Daily digest' : 'Weekly digest', heading, preheader: bits.join(', ') || 'Your campaigns at a glance',
        blocks: [...(cards.length ? [{ stats }] : []), ...cards, ...monitorBlocks], action: { url: app, label: 'Open Headcount' }, footer: footer(u.id, 'digest', `you get a ${period} digest`) }),
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

  // Messages from the website's contact form go to the inbox set for them,
  // else the sales address, else whoever runs this Headcount.
  function contactInbox() {
    if (cfg.leadsEmail) return cfg.leadsEmail;
    if (cfg.salesEmail) return cfg.salesEmail;
    const op = store.setting('operator') ? store.q.user.get(store.setting('operator')) : null;
    return (op && op.email) || cfg.supportEmail || '';
  }
  function contact(lead) {
    const to = contactInbox(); if (!to) return false;
    return mail.queue({ to, kind: 'lead', replyTo: lead.email, subject: `Question from the Headcount website: ${lead.name}${lead.firm ? `, ${lead.firm}` : ''}`,
      text: `${lead.message || '(No message)'}\n\nName: ${lead.name}\nEmail: ${lead.email}\nOrganization: ${lead.firm || ''}\nTeam size: ${lead.size || ''}\n\nReply to this email to answer them.` });
  }

  return { handle, orgInvite, trialNotices, digests, digestFor, contact, contactInbox, monitorAlert };
}
