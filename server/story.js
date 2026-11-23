// A bill's story in plain language: every action restated for someone who has
// never read a legislative journal, each committee stop with how it ended and
// how members voted, where the bill is now and what happens next. Built from
// the official actions (Open States for the states, Congress.gov for
// Congress), so it is only as current as those are.

const HOUSE = { lower: 'House', upper: 'Senate', legislature: 'Legislature' };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const committeeName = (s) => clean(s).replace(/^(the\s+)?(house|senate|assembly)\s+(committee\s+on\s+)?/i, '').replace(/^committee\s+on\s+/i, '').replace(/\s+committee$/i, '').replace(/[.;,]+$/, '');
const AGENDA = /on (?:the )?committee agenda\s*-*\s*(.+?),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,\s*([0-9:]+\s*[ap]\.?\s?m\.?))?(?:,\s*(.+))?$/i;
const DATE_IN = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[^0-9]+([0-9]{1,2}:[0-9]{2}\s*[ap]\.?\s?m\.?))?/i;
const isoDay = (m, d, y) => `${String(y).length === 2 ? `20${y}` : y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// A committee meeting the bill is on the agenda for, from the notice in its history.
function hearingOf(a) {
  const m = AGENDA.exec(a.text);
  if (m) return { date: isoDay(m[2], m[3], m[4]), time: clean(m[5] || ''), committee: committeeName(m[1]), room: clean(m[6] || '').replace(/\.$/, ''), chamber: a.chamber, noticed: a.date };
  const d = DATE_IN.exec(a.text);
  if (d) return { date: isoDay(d[1], d[2], d[3]), time: clean(d[4] || ''), committee: '', room: '', chamber: a.chamber, noticed: a.date };
  return null;
}
const MINOR = new Set(['enrolled', 'messages', 'procedural', 'debate', 'floor-step', 'rule', 'proceed', 'calendar', 'reading-1', 'reading-2', 'reconsider', 'cloture-filed']);
const list = (xs) => (xs.length < 2 ? xs[0] || '' : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const theCmte = (name) => (/\bcommittee\b/i.test(name) ? `the ${name}` : `the ${name} committee`);
const yeas = (t) => { const m = /yeas\s+(\d+)\s+nays\s+(\d+)/i.exec(t); return m ? `, ${m[1]} to ${m[2]}` : ''; };
const tallyText = (t) => { const m = /(\d+)\s*-\s*(\d+)/.exec(t); return m ? ` (${m[1]} to ${m[2]})` : ''; };
// "Referred to the Committee on Financial Services, and in addition to the
// Committee on Agriculture, for a period to be subsequently determined..."
function referralNames(text) {
  const after = (/\b(?:referred|re-?referred|re-?committed|recommitted)\s+to\s+(.+)$/i.exec(String(text)) || [null, String(text)])[1];
  const t = after.split(/,?\s+for a period\b|,?\s+for consideration\b/i)[0];
  let names;
  if (/;/.test(t)) names = t.split(/\s*;\s*/).map((x) => committeeName(x));
  else if (/in addition to/i.test(t)) names = t.split(/,?\s+(?:and\s+)?in addition to\s+/i).map((part) => { const m = /committees?\s+on\s+(?:the\s+)?(.+?)(?:\.\s|\.$|;|$)/i.exec(part); return m ? committeeName(m[1]) : committeeName(part); });
  else { const m = /^(?:the\s+)?(?:(?:house|senate|assembly)\s+)?committee\s+on\s+(?:the\s+)?(.+?)(?:\.\s|\.$|;|$)/i.exec(t); names = [committeeName(m ? m[1] : t)]; }
  return [...new Set(names.filter((x) => x && !/^(calendar|special order)/i.test(x)))];
}
const REFERRAL = /\b(?:referred|re-?referred|re-?committed|recommitted|rereferred)\s+to\s+(?:the\s+)?(?:(?:house|senate|assembly)\s+)?(?:committee\s+on\s+)?(.+?)(?:\s+committee)?(?:\.|;|$)/i;

// What kind of step an action is, from Open States' classification or, when
// that is missing, from the wording legislatures commonly use.
function kindOf(a) {
  const k = new Set(a.kinds || []), t = a.text.toLowerCase();
  if (k.has('became-law') || /\bbecame (public )?law|\bchaptered\b|public law no|\bact no\.|\bchapter no\.?\s*\d|approved by governor.*chapter/.test(t)) return 'law';
  if (k.has('executive-veto') || /\bvetoed\b|\bveto message\b/.test(t)) return 'veto';
  if (k.has('veto-override-passage') || /veto overrid/.test(t)) return 'override';
  if (k.has('executive-signature') || /signed by (the )?(governor|president)|approved by (the )?governor/.test(t)) return 'signed';
  if (k.has('executive-receipt') || /presented to (the )?(governor|president)|sent to (the )?governor|to governor/.test(t)) return 'governor';
  if (/^(?:cs\/)*cs by .+ read (1st|first) time/.test(t)) return 'reading-1';
  if (/pending reference review|immediately certified|^withdrawn from further consideration$/.test(t)) return 'procedural';
  if (/^now in\s+/.test(t)) return 'now-in';
  if (/^in messages$|^received from the (house|senate)|^in (house|senate) messages/.test(t)) return 'messages';
  if (/ordered enrolled|^enrolled\b/.test(t)) return 'enrolled';
  if (/^(?:cs\/)*cs by\b|^favorable (with cs )?by\b/.test(t)) return 'cmte-passed';
  const amendmentItself = /^(h\.?\s?amdt|s\.?\s?amdt|amendment|an amendment)\b/.test(t) || /amendment (no\.|sa \d|ha \d)/.test(t);
  if (/cloture/.test(t)) return /reconsider/.test(t) ? 'reconsider' : /not invoked/.test(t) ? 'cloture-failed' : /\binvoked\b/.test(t) ? 'cloture' : 'cloture-filed';
  if (/motion to proceed/.test(t)) return 'proceed';
  if (/rules committee resolution|^rule provides|rule h\. ?res|^considered under the provisions of rule/.test(t)) return 'rule';
  if (k.has('passage') && /concur/.test(t)) return 'concur';
  if (k.has('passage') || /\bpassed\b|final passage.*(adopted|agreed|passed)|passed\/agreed to/.test(t) && !amendmentItself && !/committee/.test(t)) return 'passed';
  if (k.has('failure') || /\bfailed (of )?passage|\bdefeated\b/.test(t) && !/amendment/.test(t)) return 'failed';
  if (k.has('committee-failure') || /failed in committee|died in committee|held in committee|reported unfavorabl/.test(t)) return 'cmte-failed';
  if ([...k].some((x) => x.startsWith('committee-passage')) || /\breported\b(?! by the clerk)|favorable|do pass|ordered to be reported|re-reported/.test(t) && !/amendment (filed|offered)/.test(t)) return /^reported\b.*\bby (the )?(committee|senator)|\breported by senator/.test(t) && !/ordered/.test(t) ? 'cmte-report' : 'cmte-passed';
  if (k.has('referral-committee') || REFERRAL.test(a.text)) return 'referred';
  if (k.has('amendment-passage') || /amendment.*(adopted|agreed to)/.test(t)) return 'amend-adopted';
  if (k.has('amendment-failure') || /amendment.*(failed|rejected|not adopted)/.test(t)) return 'amend-failed';
  if (k.has('amendment-introduction') || /amendment.*(filed|offered|introduced|proposed)/.test(t)) return 'amend-filed';
  if (AGENDA.test(a.text) || /scheduled for (a )?(public )?hearing|set for (first |second )?hearing|hearing (is )?scheduled/.test(t)) return 'agenda';
  if (/motion to reconsider|previous question|postponed proceedings|unfinished business|^the (chair|speaker)|without objection/.test(t)) return 'procedural';
  if (/^debate\b|proceeded with .*debate/.test(t)) return 'debate';
  if (/^considered\b|consideration: cr|mark-?up session held/.test(t)) return 'floor-step';
  if (/removed from (the )?table|taken from (the )?table/.test(t)) return 'untabled';
  if (/laid on (the )?table|\btabled\b/.test(t)) return 'tabled';
  if (k.has('withdrawal') || /\bwithdrawn\b/.test(t)) return 'withdrawn';
  if (/indefinitely postponed|\bdied\b/.test(t)) return 'died';
  if (k.has('reading-3') || /third (reading|consideration)/.test(t)) return 'reading-3';
  if (k.has('reading-2') || /second (reading|consideration)/.test(t)) return 'reading-2';
  if (k.has('reading-1') || /first (reading|consideration)/.test(t)) return 'reading-1';
  if (/^filed\b|^prefiled\b/.test(t) || (k.has('filing') && !k.has('introduction'))) return 'filed';
  if (k.has('introduction') || /^introduced|introduced in (the )?(house|senate)/.test(t)) return 'introduced';
  if (/placed on .*calendar|calendar/.test(t)) return 'calendar';
  if (/hearing/.test(t)) return 'hearing';
  return 'other';
}

/**
 * actions: [{ date, chamber: 'upper'|'lower'|'legislature'|'', text, kinds: [] }]
 * votes:   [{ chamber, motion, date, stance, votes: [{ name, v }] }] (record votes)
 * names:   { lower: 'House', upper: 'Senate' } as this legislature calls them
 * opts:    { origin, unicameral, executive: 'governor'|'President' }
 */
export function billStory(actions, votes = [], names = {}, opts = {}) {
  const N = { ...HOUSE, ...names }, exec = opts.executive || 'governor';
  const acts = actions.map((a) => ({ date: String(a.date || '').slice(0, 10), chamber: a.chamber || '', text: clean(a.text), kinds: a.kinds || [] }))
    .filter((a) => a.text)
    .filter((a, i, all) => all.findIndex((b) => b.date === a.date && b.text.toLowerCase() === a.text.toLowerCase()) === i)
    .sort((x, y) => x.date.localeCompare(y.date));
  const origin = opts.origin || (acts.find((a) => a.chamber) || {}).chamber || 'lower';
  const other = origin === 'lower' ? 'upper' : 'lower', unicameral = Boolean(opts.unicameral) || origin === 'legislature';
  const tally = (v) => { const yes = v.votes.filter((x) => x.v === 'yes').length, no = v.votes.filter((x) => x.v === 'no').length; return { yes, no }; };
  const stops = [], passedIn = new Set(), hearings = [];
  let place = { where: 'filed', chamber: origin, since: (acts[0] || {}).date || '' }, ended = '';
  const namedStop = (text, chamber) => {
    const m = /\bby[-\s]+(?:the\s+)?(.+?)(?:;|,\s*yeas|\s+read\b|$)/i.exec(text) || /committee on (?:the )?(.+?)(?:\.\s|\.$|;|$)/i.exec(text) || /^now in\s+(.+)$/i.exec(text) || /^([A-Z][\w ,&'-]+?) committee\b/.exec(text);
    if (!m) return null; const n = committeeName(m[1]).toLowerCase(); if (!n) return null;
    const mine = [...stops].reverse().filter((x) => x.chamber === chamber);
    return mine.find((x) => x.committee.toLowerCase() === n) || mine.find((x) => x.committee.toLowerCase().endsWith(n) || n.endsWith(x.committee.toLowerCase())) || null;
  };
  const openStop = (chamber) => [...stops].reverse().find((s) => s.chamber === chamber && s.result === 'pending') || [...stops].reverse().find((s) => s.chamber === chamber && !s.result);
  const timeline = acts.map((a) => {
    const kind = kindOf(a), ch = a.chamber || place.chamber || origin, H = N[ch] || 'legislature';
    let plain = a.text;
    switch (kind) {
      case 'filed': plain = `Filed in the ${H}`; place = { where: 'committee-wait', chamber: ch, since: a.date }; break;
      case 'introduced': plain = `Introduced in the ${H}`; place = { where: 'committee-wait', chamber: ch, since: a.date }; break;
      case 'reading-1': plain = `First reading in the ${H}`; break;
      case 'referred': {
        const names = referralNames(a.text), again = names.some((name) => stops.some((x) => x.chamber === ch && x.committee.toLowerCase() === name.toLowerCase()));
        if (!names.length) { plain = `Placed on the ${H}'s calendar`; place = { where: 'floor', chamber: ch, since: a.date }; break; }
        plain = names.length > 1 ? `Sent to ${names.length} committees in the ${H}: ${names.join('; ')}` : `${again ? 'Sent back to' : 'Sent to'} ${theCmte(names[0])} in the ${H}`;
        names.forEach((name) => stops.push({ committee: name, chamber: ch, referred: a.date, result: 'pending', resultDate: '', vote: null }));
        place = { where: 'committee', chamber: ch, committee: names[0], since: a.date }; break;
      }
      case 'cmte-report': {
        const s = namedStop(a.text, ch) || openStop(ch);
        if (s && s.result === 'pending') { s.result = 'approved'; s.resultDate = a.date; }
        plain = s ? `${theCmte(s.committee).replace(/^the/, 'The')} sent its report to the full ${H}` : `Committee report sent to the full ${H}`;
        if (!stops.some((x) => x.chamber === ch && x.result === 'pending')) place = { where: 'floor', chamber: ch, since: a.date };
        break;
      }
      case 'cmte-passed': {
        const s = namedStop(a.text, ch) || openStop(ch); const unf = /unfavorabl/i.test(a.text);
        if (s) { s.result = unf ? 'unfavorable' : 'approved'; s.resultDate = a.date; }
        const changed = /amend|^(cs\/)*cs by|with cs/i.test(a.text);
        plain = `${s ? `${unf ? 'Reported unfavorably by' : 'Approved by'} ${theCmte(s.committee)}` : 'Approved in committee'}${changed ? ', with changes' : ''}${yeas(a.text)}`;
        if (!stops.some((x) => x.chamber === ch && x.result === 'pending')) place = { where: 'floor', chamber: ch, since: a.date }; break;
      }
      case 'cmte-failed': { const s = openStop(ch); if (s) { s.result = 'failed'; s.resultDate = a.date; } plain = s ? `Did not get out of ${theCmte(s.committee)}` : 'Did not get out of committee'; place = { where: 'stuck', chamber: ch, since: a.date }; break; }
      case 'reading-2': plain = `Second reading in the ${H}`; break;
      case 'reading-3': plain = `Third reading in the ${H}: the last step before the vote`; break;
      case 'calendar': plain = `Scheduled for a vote of the full ${H}`; place = { where: 'floor', chamber: ch, since: a.date }; break;
      case 'passed': {
        passedIn.add(ch);
        plain = `${unicameral ? `Passed the ${N.legislature || 'Legislature'}` : `Passed the full ${H}`}${yeas(a.text)}`;
        if (unicameral || (passedIn.has('lower') && passedIn.has('upper'))) place = { where: 'passed-both', chamber: ch, since: a.date };
        else place = { where: 'crossed', chamber: ch === 'lower' ? 'upper' : 'lower', since: a.date };
        break;
      }
      case 'concur': plain = `The ${H} agreed to the other chamber's changes`; passedIn.add('lower'); passedIn.add('upper'); place = { where: 'passed-both', chamber: ch, since: a.date }; break;
      case 'failed': plain = `Failed in the full ${H}`; place = { where: 'stuck', chamber: ch, since: a.date }; ended = 'failed'; break;
      case 'governor': plain = `Sent to the ${exec} to sign`; place = { where: 'executive', chamber: ch, since: a.date }; break;
      case 'signed': plain = `Signed by the ${exec}`; place = { where: 'law', chamber: ch, since: a.date }; ended = 'law'; break;
      case 'law': plain = /chapter/i.test(a.text) ? `Became law: ${a.text.replace(/\.$/, '')}` : 'Became law'; if (place.where !== 'law') place = { where: 'law', chamber: ch, since: a.date }; ended = 'law'; break;
      case 'veto': plain = `Vetoed by the ${exec}`; place = { where: 'vetoed', chamber: ch, since: a.date }; ended = 'vetoed'; break;
      case 'override': plain = `The ${H} voted to override the veto`; break;
      case 'amend-adopted': plain = 'An amendment was adopted'; break;
      case 'amend-failed': plain = 'An amendment was rejected'; break;
      case 'amend-filed': plain = 'An amendment was filed'; break;
      case 'tabled': plain = 'Set aside (tabled). It can be taken up again later'; break;
      case 'untabled': plain = 'Taken up again after being set aside'; break;
      case 'withdrawn': plain = 'Withdrawn'; ended = 'withdrawn'; break;
      case 'died': plain = 'Died without a final vote'; ended = 'died'; break;
      case 'hearing': plain = `Committee hearing in the ${H}`; break;
      case 'now-in': { const s = namedStop(a.text, ch); const name = s ? s.committee : committeeName(a.text.replace(/^now in\s+/i, '')); plain = `Now in ${theCmte(name)}`; place = { where: 'committee', chamber: ch, committee: name, since: a.date }; break; }
      case 'messages': { const to = ch && passedIn.size ? ch : (ch === 'lower' ? 'upper' : 'lower'); plain = `Sent to the ${N[to] || 'other chamber'}`; break; }
      case 'enrolled': plain = `Final version prepared for the ${exec}`; break;
      case 'agenda': {
        const h = hearingOf(a);
        if (h) {
          const s = h.committee ? namedStop(`committee on ${h.committee}`, ch) || [...stops].reverse().find((x) => x.chamber === ch && x.committee.toLowerCase().includes(h.committee.toLowerCase())) : openStop(ch);
          if (s && !h.committee) h.committee = s.committee;
          if (s) s.hearing = { date: h.date, time: h.time, room: h.room };
          hearings.push(h);
          plain = `On ${h.committee ? `${theCmte(h.committee)}'s` : 'a committee'} agenda for ${fmt(h.date)}${h.time ? ` at ${h.time}` : ''}${h.room ? `, ${h.room}` : ''}`;
        } else plain = `Scheduled for a committee hearing in the ${H}`;
        break;
      }
      case 'procedural': plain = /reconsider.*laid on the table/i.test(a.text) ? 'Procedural step that makes the vote final' : /postponed/i.test(a.text) ? 'Vote put off until later' : /reference review/i.test(a.text) ? 'Routine review of the committee\'s changes' : /certified/i.test(a.text) ? 'Sent on right away' : 'Procedural step'; break;
      case 'debate': plain = `Debated on the ${H} floor`; break;
      case 'floor-step': plain = /mark-?up/i.test(a.text) ? 'Committee meeting to amend and vote on it (markup)' : `Taken up on the ${H} floor`; break;
      case 'rule': plain = 'The Rules Committee set the terms for debating it'; break;
      case 'proceed': plain = `A motion was made to take it up on the ${H} floor`; break;
      case 'cloture-filed': plain = 'Senators filed to end debate and move to a vote (cloture)'; break;
      case 'cloture': plain = `The ${H} voted to end debate (cloture)${tallyText(a.text)}`; break;
      case 'cloture-failed': plain = `The ${H} fell short of the 60 votes needed to end debate${tallyText(a.text)}`; break;
      case 'reconsider': plain = 'A senator moved to reconsider, so the vote can be held again'; break;
      default: break;
    }
    return { date: a.date, chamber: ch, kind, text: a.text, plain, minor: MINOR.has(kind) || undefined };
  });
  // Congress records some steps twice on the same day ("Passed/agreed to in
  // House" and "On passage Passed"): keep the first.
  for (let i = timeline.length - 1; i > 0; i--) {
    const t = timeline[i];
    if (['passed', 'failed', 'cmte-passed', 'introduced', 'calendar', 'reading-1', 'reading-2', 'reading-3'].includes(t.kind) && timeline.slice(0, i).some((x) => x.date === t.date && x.chamber === t.chamber && x.kind === t.kind && x.plain === t.plain)) timeline.splice(i, 1);
  }
  // Committee votes: matched to their stop by the committee's name in the motion.
  for (const v of votes) {
    const m = /committee vote \(([^)]+)\)|^(.+?) committee\b/i.exec(v.motion || ''); if (!m) continue;
    const name = committeeName(m[1] || m[2]).toLowerCase();
    const s = [...stops].reverse().find((x) => x.chamber === v.chamber && x.committee.toLowerCase() === name && (!x.resultDate || !v.date || v.date <= x.resultDate || x.result === 'pending'));
    if (s && (!s.vote || /report|pass|favorab/i.test(v.motion))) s.vote = { motion: v.motion, date: v.date, ...tally(v), members: v.votes.map((x) => ({ name: x.name, v: x.v })) };
  }
  // Floor votes on the bill itself, for the passage lines.
  const floor = votes.filter((v) => v.stance === 'for' && !/committee/i.test(v.motion || '')).map((v) => ({ chamber: v.chamber, date: v.date, motion: v.motion, ...tally(v) }));
  for (const t of timeline) if ((t.kind === 'passed' || t.kind === 'failed') && !/\d+ to \d+$/.test(t.plain)) { const f = floor.find((v) => v.chamber === t.chamber && (!v.date || v.date === t.date)); if (f) t.plain += `, ${f.yes} to ${f.no}`; }
  const out = whereNow(place, ended, stops, N, exec, unicameral, origin, other, passedIn);
  const last = [...timeline].reverse().find((t) => !t.minor && t.kind !== 'other');
  if (last) out.stage.last = { date: last.date, plain: last.plain };
  return { timeline, stops, floor, hearings, ...out };
}

const fmt = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');

// The current step, in a sentence, and what has to happen next.
function whereNow(place, ended, stops, N, exec, unicameral, origin, other, passedIn) {
  const H = (c) => N[c] || 'legislature', since = place.since ? ` since ${fmt(place.since)}` : '', on = place.since ? ` on ${fmt(place.since)}` : '';
  const steps = unicameral ? ['Introduced', 'Committee', 'Full vote', exec === 'President' ? 'President' : 'Governor', 'Law']
    : ['Introduced', `${H(origin)} committee`, `${H(origin)} vote`, `${H(other)}`, exec === 'President' ? 'President' : 'Governor', 'Law'];
  let step = 0, now = '', next = '';
  const inFirst = !passedIn.has(origin);
  switch (place.where) {
    case 'filed': case 'committee-wait': step = 0; now = `Introduced in the ${H(place.chamber)}${on}.`; next = `It goes to a committee first. Committees decide which bills reach a vote of the full ${H(place.chamber)}.`; break;
    case 'committee': step = unicameral || inFirst ? 1 : 3; now = `In the ${place.committee} committee of the ${H(place.chamber)}${since}.`; next = `The committee has to vote to send it on before the full ${H(place.chamber)} can vote. Its members are the ones to see now.`; break;
    case 'floor': step = unicameral || inFirst ? 2 : 3; now = `Out of committee${since} and waiting for a vote of the full ${H(place.chamber)}.`; next = `The full ${H(place.chamber)} votes next. Count every member.`; break;
    case 'crossed': step = 3; now = `Passed the ${H(origin)}${on}. Now in the ${H(place.chamber)}.`; next = `The ${H(place.chamber)} repeats the steps: a committee, then a vote of the full ${H(place.chamber)}. If it changes the bill, the ${H(origin)} has to agree to the changes.`; break;
    case 'passed-both': step = unicameral ? 3 : 4; now = unicameral ? `Passed the ${H('legislature')}${on}.` : `Passed both the ${H('lower')} and the ${H('upper')}${on}.`; next = `It goes to the ${exec}, who can sign it or veto it.`; break;
    case 'executive': step = unicameral ? 3 : 4; now = `On the ${exec}'s desk${since}.`; next = `The ${exec} can sign it, veto it, or in many places let it become law without signing. A veto can be overridden by a large majority.`; break;
    case 'law': step = unicameral ? 4 : 5; now = `Became law${on}.`; next = ''; break;
    case 'vetoed': step = unicameral ? 3 : 4; now = `Vetoed by the ${exec}${on}.`; next = 'Lawmakers can override the veto, usually with a two-thirds vote in each chamber.'; break;
    case 'stuck': step = stops.length && !passedIn.size ? 1 : 2; now = ended === 'failed' ? `Failed a vote of the full ${H(place.chamber)}${on}.` : `Stopped in committee${on}.`; next = 'It can come back only if lawmakers bring it up again, often as a new bill.'; break;
    default: break;
  }
  if (ended === 'withdrawn') { now = 'Withdrawn by its sponsor.'; next = ''; }
  if (ended === 'died') { now = 'Died without a final vote.'; next = 'It would have to be filed again in a later session.'; }
  return { stage: { where: place.where, steps, step, done: ['law'].includes(place.where), stopped: ['vetoed', 'stuck'].includes(place.where) || ['withdrawn', 'died', 'failed'].includes(ended), now, next, chamber: place.chamber, committee: place.committee || '' } };
}
