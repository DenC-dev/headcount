// Updates the chamber lists built into Headcount, and the staff that come with
// them, from the official sources (see server/officials.js). Run it with
// `npm run rosters`; a weekly GitHub Action runs it too, and a Headcount
// server refreshes its own copy every week.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshOfficials, staffFiles } from '../server/officials.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'public', 'rosters.json'), staffDir = path.join(ROOT, 'public', 'staff');
const bundled = JSON.parse(fs.readFileSync(file, 'utf8'));
const { presets, staff, report } = await refreshOfficials(bundled, { log: (m) => console.error(m) });
for (const key of ['flsenate', 'flhouse']) {
  const before = new Set((bundled.presets[key] || { members: [] }).members.map((m) => m.k)), after = new Set(presets[key].members.map((m) => m.k));
  const added = presets[key].members.filter((m) => !before.has(m.k)).map((m) => `${m.n} (${m.d})`), gone = (bundled.presets[key] || { members: [] }).members.filter((m) => !after.has(m.k)).map((m) => `${m.n} (${m.d})`);
  console.log(`${presets[key].label}: ${presets[key].members.length} members, ${added.length} new, ${gone.length} left`);
  if (added.length) console.log(`  new: ${added.join('; ')}`);
  if (gone.length) console.log(`  left: ${gone.join('; ')}`);
}
console.log(report.join('\n'));
if (report.some((r) => !/: ok$/.test(r))) process.exitCode = 1;
fs.writeFileSync(file, JSON.stringify({ ...bundled, presets }));
fs.mkdirSync(staffDir, { recursive: true });
for (const [key, data] of Object.entries(staffFiles(staff))) {
  fs.writeFileSync(path.join(staffDir, `${key}.json`), JSON.stringify(data));
  console.log(`staff/${key}.json: ${Object.keys(data.people).length} offices, ${Object.values(data.people).reduce((a, x) => a + x.length, 0)} people`);
}
