// Turns the live check results (LIVE_JSON) into the Markdown used for the
// GitHub issue that alerts the team when a data source breaks.
import fs from 'node:fs';

let r;
try { r = JSON.parse(fs.readFileSync(process.env.LIVE_JSON, 'utf8')); }
catch (_) { console.log('The live checks did not produce results. Open the workflow run to see why.'); process.exit(0); }
const icon = { ok: 'Passed', fail: '**Failed**', skip: 'Skipped' };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
console.log(`${r.failed ? `${r.failed} of ${r.checks.length} checks failed` : `All ${r.passed} checks passed`} on ${r.ranAt.slice(0, 16).replace('T', ' ')} UTC${r.run ? ` ([run](${r.run}))` : ''}.`);
console.log('\n| Check | Result | Details |\n|---|---|---|');
for (const c of r.checks) console.log(`| ${cell(c.name)} | ${icon[c.status] || c.status} | ${cell(c.note)} |`);
if (r.failed) console.log('\nA failure usually means a service changed its format or address, rejected a key, or was down. Run `npm run test:live` locally to see it again, and check `server/sources.js`.');
