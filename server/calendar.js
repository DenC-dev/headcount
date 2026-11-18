import crypto from 'node:crypto';

// A calendar feed for each person: committee and floor votes, meetings they
// sent invitations for, and follow-ups due, as an iCalendar subscription that
// Outlook, Google Calendar and Apple Calendar refresh on their own.
//
// The link carries a signed token instead of a sign-in, because calendar apps
// cannot sign in. Nothing about it is stored except a version number; making
// a new link bumps the version, which ends every older link.

const DAY = 864e5;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const ymd = (d) => d.replace(/-/g, '');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
const text = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 bytes continue on the next line after a space,
// without splitting a character.
function fold(line) {
  let out = '', cur = '', len = 0, max = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (len + n > max) { out += cur + '\r\n '; cur = ''; len = 0; max = 74; }
    cur += ch; len += n;
  }
  return out + cur;
}

export function makeCalendar(cfg, store, { key }) {
  const version = (uid) => Number(store.setting('calv.' + uid)) || 1;
  const sign = (uid, v) => crypto.createHmac('sha256', key()).update(`calendar:${uid}:${v}`).digest('base64url').slice(0, 32);
  const token = (uid) => { const v = version(uid); return `${Buffer.from(uid).toString('base64url')}.${v}.${sign(uid, v)}`; };
  const base = () => cfg.publicUrl || `http://localhost:${cfg.port}`;
  const link = (uid) => `${base()}/api/calendar/${token(uid)}.ics`;
  function renew(uid) { store.putSetting('calv.' + uid, String(version(uid) + 1)); return link(uid); }
  function userFor(tok) {
    const m = /^([A-Za-z0-9_-]{2,300})\.(\d{1,7})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ''));
    if (!m) return null;
    const uid = Buffer.from(m[1], 'base64url').toString('utf8');
    if (Number(m[2]) !== version(uid)) return null;
    const ok = crypto.timingSafeEqual(Buffer.from(sign(uid, Number(m[2]))), Buffer.from(m[3]));
    return ok && store.q.user.get(uid) ? uid : null;
  }

  function events(uid, now = Date.now()) {
    const from = new Date(now - 60 * DAY).toISOString().slice(0, 10), to = new Date(now + 400 * DAY).toISOString().slice(0, 10);
    const inRange = (d) => isDay(d) && d >= from && d <= to;
    const out = [];
    for (const o of store.q.userOrgs.all(uid)) {
      if (store.blocked(o, uid, o.my_role)) continue;
      for (const c of store.q.orgCampaigns.all(o.id)) {
        if (c.archived || !store.campaignRole(c.id, uid)) continue;
        const s = c.summary ? JSON.parse(c.summary) : {};
        const name = c.name || s.bill || 'Campaign', where = [store.clientName(c.client_id), o.name].filter(Boolean).join(' · ');
        for (const [k, label, d] of [['cmte', 'Committee vote', s.cmteDate], ['floor', 'Floor vote', s.floorDate]]) {
          if (inRange(d)) out.push({ uid: `${c.id}.${k}`, day: d, title: `${label}: ${name}`, note: where });
        }
        for (const r of store.q.recordsOf.all(c.id, 'meetings')) {
          const mt = JSON.parse(r.data), start = Date.parse(mt.start);
          if (mt.status !== 'invited' || Number.isNaN(start) || !inRange(new Date(start).toISOString().slice(0, 10))) continue;
          out.push({ uid: `${c.id}.m.${mt.id || r.rid}`, start, end: start + (Number(mt.mins) || 30) * 60e3, title: mt.title || `Meeting: ${name}`, place: mt.where, note: `${name}${where ? ' · ' + where : ''}` });
        }
        for (const r of store.q.recordsOf.all(c.id, 'tasks')) {
          const t = JSON.parse(r.data);
          if (t.done || !inRange(t.due) || (t.assignee && t.assignee !== uid)) continue;
          out.push({ uid: `${c.id}.t.${t.id || r.rid}`, day: t.due, title: `Follow-up: ${t.text}`, note: `${name}${where ? ' · ' + where : ''}` });
        }
      }
    }
    return out;
  }

  function ics(uid, now = Date.now()) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Headcount//Calendar feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Headcount', 'X-WR-CALDESC:Votes\\, meetings and follow-ups from Headcount', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
    for (const e of events(uid, now)) {
      lines.push('BEGIN:VEVENT', `UID:${e.uid}@headcount`, `DTSTAMP:${stamp(now)}`);
      if (e.day) lines.push(`DTSTART;VALUE=DATE:${ymd(e.day)}`, `DTEND;VALUE=DATE:${ymd(nextDay(e.day))}`, 'TRANSP:TRANSPARENT');
      else lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
      lines.push(`SUMMARY:${text(e.title)}`);
      if (e.place) lines.push(`LOCATION:${text(e.place)}`);
      if (e.note) lines.push(`DESCRIPTION:${text(e.note)}`);
      lines.push(`URL:${base()}/app`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  return { link, renew, userFor, ics, events };
}
