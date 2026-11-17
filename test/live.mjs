// Live checks against the real public data services, through the same code the
// server uses (server/sources.js). Run with `npm run test:live`. It reads keys
// from the environment or .env; a source whose key is missing is skipped, not
// failed. Congress.gov falls back to the public DEMO_KEY (a few calls an hour).
// Set LIVE_AI=1 to also score three real items with Claude (billed, a few cents).
import { spawnSync } from 'node:child_process';

// Behind an outbound proxy, Node's fetch needs NODE_USE_ENV_PROXY (Node 22.21 or later).
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}
const { config } = await import('../server/config.js');
const src = await import('../server/sources.js');
const { lookupBill } = await import('../server/bills.js');

// LIVE_NO_DEMO=1 (set in CI, where the shared demo key is always used up) skips Congress.gov without a key.
const cfg = { ...config, congressKey: config.congressKey || (process.env.LIVE_NO_DEMO ? '' : 'DEMO_KEY') };
const congress = { name: 'CONGRESS_API_KEY', value: cfg.congressKey };
const days = (n) => new Date(Date.now() - n * 864e5);
const results = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

async function run(name, needs, fn) {
  if (needs && !needs.value) { results.push([name, 'skip', `set ${needs.name} to check it`, 0]); return; }
  const t = Date.now();
  try { const note = await fn(); results.push([name, 'ok', `${note || ''} (${((Date.now() - t) / 1000).toFixed(1)}s)`, Date.now() - t]); }
  catch (e) { results.push([name, 'FAIL', e.message, Date.now() - t]); }
}

await run('Congress.gov: bills updated this week', congress, async () => {
  const bills = await src.congressUpdated(cfg, days(3), 1);
  check(bills.length > 0, 'no bills came back');
  for (const b of bills) {
    check(/^(H\.R\.|S\.|H\.Res\.|S\.Res\.|H\.J\.Res\.|S\.J\.Res\.|H\.Con\.Res\.|S\.Con\.Res\.) \d+$/.test(b.number), `odd bill number ${b.number}`);
    check(b.url.startsWith('https://www.congress.gov/bill/'), `odd link ${b.url}`);
    check(b.title && /^\d{4}-\d{2}-\d{2}$/.test(b.date), `missing title or date on ${b.number}`);
  }
  return `${bills.length} bills, e.g. ${bills[0].number}: ${bills[0].title.slice(0, 50)}`;
});
await run('Congress.gov: bill lookup for briefs', congress, async () => {
  const b = await lookupBill(cfg, { jurisdiction: 'US', number: 'H.R. 1', session: '119' });
  check(b.title && b.sponsors.length && b.latestAction, 'title, sponsor or latest action missing');
  return `${b.number}: ${b.title.slice(0, 60)}`;
});
await run('Open States: state bill search', { name: 'OPENSTATES_API_KEY', value: cfg.openStatesKey }, async () => {
  const bills = await src.stateBills(cfg, { states: ['FL', 'TX'], q: 'insurance', since: days(365) });
  check(bills.length > 0, 'no bills came back for "insurance" in Florida and Texas over a year');
  check(bills.every((b) => ['FL', 'TX'].includes(b.juris) && b.number && b.title), 'a bill is missing its state, number or title');
  return `${bills.length} bills, e.g. ${bills[0].juris} ${bills[0].number}`;
});
await run('Open States: Florida Senate roster', { name: 'OPENSTATES_API_KEY', value: cfg.openStatesKey }, async () => {
  const r = await src.stateRoster(cfg, 'FL', 'upper');
  check(r.members.length >= 30, `only ${r.members.length} senators`);
  check(r.members.every((m) => m.n && m.d), 'a member is missing a name or district');
  check(r.members.some((m) => m.em) && r.members.some((m) => m.ph), 'no emails or phone numbers at all');
  return `${r.members.length} senators, ${r.members.filter((m) => m.em).length} with email`;
});
await run('Federal Register: rules and notices', null, async () => {
  const docs = await src.federalRegister(cfg, { q: 'broadband', since: days(120) });
  check(docs.length > 0, 'nothing found for "broadband" in 120 days');
  const types = new Set(['Proposed rule', 'Final rule', 'Notice', 'Presidential document']);
  check(docs.every((d) => types.has(d.docType)), `unexpected document type: ${[...new Set(docs.map((d) => d.docType))].join(', ')}`);
  check(docs.every((d) => d.url.startsWith('https://www.federalregister.gov/') && d.agency), 'a document is missing its link or agency');
  const open = docs.filter((d) => d.deadline);
  return `${docs.length} documents, ${open.length} with a comment deadline`;
});
await run('SAM.gov: contract opportunities', { name: 'SAM_API_KEY', value: cfg.samKey }, async () => {
  const opps = await src.samOpportunities(cfg, { q: 'services', since: days(7) });
  check(Array.isArray(opps), 'no list came back');
  check(opps.every((o) => o.title && o.url && o.agency), 'an opportunity is missing its title, link or agency');
  return `${opps.length} opportunities${opps[0] ? `, e.g. ${opps[0].agency}` : ''}`;
});
await run('LDA.gov: who is lobbying on H.R. 1', null, async () => {
  const r = await src.lobbyingOn(cfg, { number: 'H.R. 1' });
  check(r.filings.length > 0, 'no filings name H.R. 1');
  const re = src.billPattern('H.R. 1');
  check(r.filings.every((f) => re.test(f.issue)), 'a filing does not actually mention the bill');
  check(r.clients.every((c) => c.client), 'a client has no name');
  return `${r.filings.length} filings, ${r.clients.length} clients, top: ${r.clients[0].client}`;
});
await run('USAspending: who wins the work', null, async () => {
  const r = await src.incumbents(cfg, { agency: 'Agriculture, Department of', naics: '517111' });
  check(r.scope.startsWith('Department of Agriculture'), `fell back to "${r.scope}" instead of searching the agency`);
  check(r.recipients.length > 0 && r.total > 0, 'no awards');
  return `${r.recipients.length} companies, top: ${r.recipients[0].name}`;
});
await run('Census: districts for a Florida address', null, async () => {
  const d = await src.districtsFor(cfg, '400 S Monroe St, Tallahassee, FL 32399');
  check(d.state === 'FL', `state came back as "${d.state}"`);
  check(/^\d+$/.test(d.cd) && /^\d+$/.test(d.upper) && /^\d+$/.test(d.lower), `districts incomplete: ${JSON.stringify(d)}`);
  return `FL congressional ${d.cd}, senate ${d.upper}, house ${d.lower}`;
});
await run('Census: an at-large district', null, async () => {
  const d = await src.districtsFor(cfg, '1600 Pennsylvania Ave NW, Washington, DC 20500');
  check(d.state === 'DC' && d.cd === 'AL', `expected DC at-large, got ${JSON.stringify(d)}`);
  return 'DC, at-large';
});
await run('Claude: scoring three real items', process.env.LIVE_AI === '1' ? { name: 'ANTHROPIC_API_KEY', value: config.aiEnabled } : { name: 'LIVE_AI=1 and ANTHROPIC_API_KEY', value: false }, async () => {
  const { scoreItems } = await import('../server/ai.js');
  const docs = (await src.federalRegister(cfg, { q: 'broadband', since: days(120) })).slice(0, 3).map((d, i) => ({ ...d, id: String(i + 1) }));
  const scores = await scoreItems({ watch: { name: 'Broadband', query: 'broadband', priorities: 'Federal grants for rural broadband deployment' }, client: '', items: docs });
  check(scores.length === docs.length && scores.every((s) => s.score >= 0 && s.score <= 100 && s.reason), 'scores missing or malformed');
  return scores.map((s) => s.score).join(', ');
});

const w = Math.max(...results.map((r) => r[0].length));
for (const [name, status, note] of results) console.log(`${status.padEnd(4)}  ${name.padEnd(w)}  ${note}`);
const failed = results.filter((r) => r[1] === 'FAIL').length, skipped = results.filter((r) => r[1] === 'skip').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
// LIVE_JSON=path also writes the results for the status page and alerts.
if (process.env.LIVE_JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.LIVE_JSON, JSON.stringify({
    ranAt: new Date().toISOString(), run: process.env.LIVE_RUN_URL || '',
    passed: results.length - failed - skipped, failed, skipped,
    checks: results.map(([name, status, note, ms]) => ({ name, status: status === 'FAIL' ? 'fail' : status, note: String(note).slice(0, 300), ms })),
  }, null, 2));
}
process.exitCode = failed ? 1 : 0;
