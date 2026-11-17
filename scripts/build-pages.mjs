// Builds the project website for GitHub Pages into _site/: the pages in
// pages/, the shared website styles and screenshots, and the data-source
// status from the latest live checks (LIVE_JSON) with a rolling history.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '_site');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const REPO_URL = process.env.REPO_URL || 'https://github.com/DenC-dev/headcount';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });

// Latest results, and the history kept on the published site itself.
let latest = null;
try { latest = JSON.parse(fs.readFileSync(process.env.LIVE_JSON || '', 'utf8')); } catch (_) { /* no run yet */ }
let history = [];
if (SITE_URL) {
  try { const res = await fetch(`${SITE_URL}/history.json`, { signal: AbortSignal.timeout(15000) }); if (res.ok) history = await res.json(); } catch (_) { /* first publish */ }
}
if (!Array.isArray(history)) history = [];
if (latest) history.push({ ranAt: latest.ranAt, run: latest.run, checks: latest.checks.map((c) => ({ name: c.name, status: c.status })) });
history = history.filter((h) => h && h.ranAt).sort((a, b) => a.ranAt.localeCompare(b.ranAt)).slice(-60);
fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(latest || { ranAt: null, checks: [] }, null, 2));
fs.writeFileSync(path.join(OUT, 'history.json'), JSON.stringify(history));

const vars = { repo: REPO_URL, year: String(new Date().getFullYear()), hemicycle: read('site/_hemicycle.svg'), header: read('pages/_header.html'), footer: read('pages/_footer.html') };
const fill = (html) => html.replace(/\{\{(header|footer|hemicycle)\}\}/g, (_, k) => vars[k]).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
for (const f of fs.readdirSync(path.join(ROOT, 'pages'))) {
  if (f.startsWith('_')) continue;
  const src = path.join(ROOT, 'pages', f);
  if (f.endsWith('.html')) fs.writeFileSync(path.join(OUT, f), fill(fs.readFileSync(src, 'utf8')));
  else fs.copyFileSync(src, path.join(OUT, f));
}
fs.copyFileSync(path.join(ROOT, 'site', 'site.css'), path.join(OUT, 'site.css'));
fs.copyFileSync(path.join(ROOT, 'public', 'icon.svg'), path.join(OUT, 'icon.svg'));
for (const f of fs.readdirSync(path.join(ROOT, 'site', 'img'))) fs.copyFileSync(path.join(ROOT, 'site', 'img', f), path.join(OUT, 'img', f));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`Built _site with ${history.length} status runs${latest ? `; latest: ${latest.passed} passed, ${latest.failed} failed, ${latest.skipped} skipped` : ''}.`);
