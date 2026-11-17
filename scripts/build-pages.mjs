// Builds the project website for GitHub Pages into _site/: the pages in
// pages/, the shared website styles and screenshots, and the data-source
// status from the latest live checks (LIVE_JSON) with a rolling history.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

const vars = { trialDays: process.env.TRIAL_DAYS || '14', repo: REPO_URL, year: String(new Date().getFullYear()), hemicycle: read('site/_hemicycle.svg'), header: read('pages/_header.html'), footer: read('pages/_footer.html'), logo: read('site/_logo.svg'), icons: read('site/_icons.svg') };
const fill = (html) => html.replace(/\{\{(header|footer|hemicycle)\}\}/g, (_, k) => vars[k]).replace(/\{\{logo\}\}/g, vars.logo).replace(/\{\{icons\}\}/g, vars.icons).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
for (const f of fs.readdirSync(path.join(ROOT, 'pages'))) {
  if (f.startsWith('_')) continue;
  const src = path.join(ROOT, 'pages', f);
  if (f.endsWith('.html')) fs.writeFileSync(path.join(OUT, f), fill(fs.readFileSync(src, 'utf8')));
  else fs.copyFileSync(src, path.join(OUT, f));
}
fs.copyFileSync(path.join(ROOT, 'site', 'site.css'), path.join(OUT, 'site.css'));
fs.copyFileSync(path.join(ROOT, 'site', 'site.js'), path.join(OUT, 'site.js'));
fs.copyFileSync(path.join(ROOT, 'public', 'icon.svg'), path.join(OUT, 'icon.svg'));
for (const f of fs.readdirSync(path.join(ROOT, 'site', 'img'))) fs.copyFileSync(path.join(ROOT, 'site', 'img', f), path.join(OUT, 'img', f));
// The free version of the app, running entirely in the browser: no account and
// no server, so campaigns stay in that browser. Sign in needs a Headcount server.
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
fs.mkdirSync(path.join(OUT, 'app'), { recursive: true });
for (const f of ['app.js', 'cloud.js', 'intel.js', 'admin.js', 'select.js', 'select.css', 'styles.css', 'rosters.json', 'icon.svg', 'icon-192.png']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, 'app', f));
fs.writeFileSync(path.join(OUT, 'app', 'app.js'), fs.readFileSync(path.join(OUT, 'app', 'app.js'), 'utf8').replace("fetch('/rosters.json')", "fetch('rosters.json')"));
let appHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace(/<link rel="manifest"[^>]*>\n?/, '').replace(/(href|src)="\/([\w.-]+\.(?:css|js|svg|png))"/g, '$1="$2"')
  .replace('<a class="brand" href="/">', '<a class="brand" href="../">')
  .replace(/href="\/(privacy|terms|security)?"/g, 'href="../"')
  .replace('<div class="wrap">', `<div class="wrap"><div class="demo-note"><b>Free version.</b> Everything you do stays in this browser, with no account. <a href="${APP_URL ? `${APP_URL}/app` : '../#accounts'}">Sign in</a> for team workspaces, the Monitor, contacts and alerts.</div>`);
fs.writeFileSync(path.join(OUT, 'app', 'index.html'), appHtml.replace('</head>', '<style>.demo-note{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px}</style>\n</head>'));
vars.signin = APP_URL ? `${APP_URL}/app` : './#accounts';
for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.html'))) fs.writeFileSync(path.join(OUT, f), fs.readFileSync(path.join(OUT, f), 'utf8').replace(/\{\{signin\}\}/g, vars.signin));
// Version each stylesheet and script link by its content, so a browser never
// mixes a cached old file with a new page after an update.
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
for (const f of ['index.html', 'status.html', 'app/index.html'].filter((x) => fs.existsSync(path.join(OUT, x)))) {
  const file = path.join(OUT, f);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(href|src)="((?:\.\/)?[\w./-]+\.(?:css|js))"/g, (m, attr, ref) => {
    const target = path.join(path.dirname(file), ref.replace(/^\.\//, ''));
    return fs.existsSync(target) ? `${attr}="${ref}?v=${hash(target)}"` : m;
  }));
}
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`Built _site with ${history.length} status runs${latest ? `; latest: ${latest.passed} passed, ${latest.failed} failed, ${latest.skipped} skipped` : ''}.`);
