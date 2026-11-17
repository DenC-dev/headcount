import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { HttpError } from './db.js';

// Optional: drafts the analytical parts of a bill brief with Claude. Turned on
// by setting ANTHROPIC_API_KEY on the server. Drafts are clearly labelled in
// the app and must be checked against the bill before anyone relies on them.

const BriefDraft = z.object({
  plainSummary: z.string().describe('What the bill does, in plain English, 3 to 5 sentences.'),
  keyProvisions: z.array(z.string()).describe('The main provisions, one sentence each.'),
  whoItAffects: z.string().describe('Who is affected and how.'),
  fiscalImpact: z.string().describe('Costs, revenue or appropriations stated in the material, or that none are stated.'),
  talkingPoints: z.array(z.string()).describe('Points that support the advocate\'s stated position.'),
  objections: z.array(z.object({ objection: z.string(), response: z.string() })).describe('Likely objections from the other side and a response to each.'),
  needsChecking: z.array(z.string()).describe('Facts the advocate should verify or find before using the brief.'),
});

const SYSTEM = `You prepare legislative briefs for lobbyists and advocates who meet with legislators and their staff.

Work only from the bill material provided. Do not add facts, figures, dates, vote counts, quotes or claims about what other organizations think unless they appear in the material. When something a brief would normally cover is missing, say so in that field and add it to needsChecking.

The summary, provisions, affected parties and fiscal impact must be neutral and accurate. Talking points and responses to objections argue for the advocate's stated position, using only what the material supports. Write plainly and concisely, the way an experienced government affairs professional writes a leave-behind.`;

let client = null;
const getClient = () => (client ||= new Anthropic());

const clip = (s, n) => String(s || '').slice(0, n);

export async function draftBrief(input) {
  const bill = input.bill || {};
  const material = String(input.material || '');
  if (material.length > 600_000) throw new HttpError(413, 'That bill text is too long to draft from in one pass. Paste the summary or the sections that matter.');
  const facts = [
    `Bill: ${clip(bill.number, 40)} ${clip(bill.title, 600)}`.trim(),
    bill.jurisdiction ? `Jurisdiction: ${clip(bill.jurisdiction, 80)}${bill.session ? `, ${clip(bill.session, 40)}` : ''}` : '',
    bill.sponsors ? `Sponsors: ${clip(bill.sponsors, 400)}` : '',
    bill.status ? `Status: ${clip(bill.status, 400)}` : '',
    bill.committees ? `Committees: ${clip(bill.committees, 400)}` : '',
    bill.officialSummary ? `Official summary:\n${clip(bill.officialSummary, 40_000)}` : '',
    material ? `Additional material supplied by the advocate (bill text, analysis or notes):\n${material}` : '',
  ].filter(Boolean).join('\n\n');
  if (!bill.officialSummary && !material) throw new HttpError(400, 'Add the official summary or paste bill text first, so the draft has something to work from.');
  const side = input.side === 'defeat' ? 'oppose the bill' : 'support the bill';
  const ask = clip(input.ask, 300);

  let res;
  try {
    res = await getClient().beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(BriefDraft) },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `<bill_material>\n${facts}\n</bill_material>\n\nThe advocate's position: ${side}.${ask ? ` Their ask of legislators: ${ask}.` : ''}${input.client ? ` They represent: ${clip(input.client, 120)}.` : ''}\n\nDraft the brief.`,
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The drafting service is busy. Try again in a minute.');
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'This server\'s drafting key was rejected.');
    if (e instanceof Anthropic.BadRequestError) throw new HttpError(502, 'The drafting service could not handle that request.');
    if (e instanceof Anthropic.APIError) throw new HttpError(502, 'The drafting service returned an error. Try again shortly.');
    throw new HttpError(502, 'The drafting service could not be reached.');
  }
  if (res.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to draft this brief. Write it by hand, or try with different material.');
  if (res.stop_reason === 'max_tokens' || !res.parsed_output) throw new HttpError(502, 'The draft came back incomplete. Try again, or shorten the material.');
  return { ...res.parsed_output, model: res.model, draftedAt: new Date().toISOString() };
}

// ---------- Monitor: screening new bills, rules and contract notices ----------
const Scores = z.object({
  scores: z.array(z.object({
    id: z.string().describe('The item id exactly as given.'),
    score: z.number().describe('0 to 100: how much this item matters to the team, given its priorities.'),
    reason: z.string().describe('One short sentence on why it matters, or why it does not.'),
  })),
});
const SCREEN = `You screen new and updated legislation, regulations and federal contract notices for a government affairs team.

For each item, score how much it matters to the team on a scale of 0 to 100, using the team's stated priorities and the client it works for:
- 80 to 100: directly about the priorities; someone should read it today.
- 50 to 79: related and worth a look this week.
- 20 to 49: touches the topic only in passing.
- 0 to 19: a keyword match that is not about the priorities.

Judge only from the item text given. Do not guess at contents that are not shown. Keep each reason to one plain sentence that a busy lobbyist can scan.`;

export async function scoreItems({ watch, client, items }) {
  const lines = items.map((it) => `<item id="${it.id}">${clip([it.number, it.title].filter(Boolean).join(': '), 600)}${it.agency ? `\nAgency: ${clip(it.agency, 200)}` : ''}${it.juris ? `\nJurisdiction: ${it.juris}` : ''}${it.docType ? `\nType: ${clip(it.docType, 60)}` : ''}${it.status ? `\nLatest action: ${clip(it.status, 300)}` : ''}${it.summary ? `\nSummary: ${clip(it.summary, 1200)}` : ''}</item>`).join('\n');
  const res = await getClient().beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(Scores) },
    system: SCREEN,
    messages: [{ role: 'user', content: `Watch: ${clip(watch.name, 120)} (search terms: ${clip(watch.query, 300)})\nPriorities: ${clip(watch.priorities || watch.query, 2000)}${client ? `\nClient: ${clip(client, 120)}` : ''}\n\n${lines}\n\nScore every item.` }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return [];
  return res.parsed_output.scores.map((s) => ({ id: String(s.id), score: Math.max(0, Math.min(100, Math.round(Number(s.score) || 0))), reason: clip(s.reason, 300) }));
}
