// Fills the status page and the home page's data source column from the
// results the daily check publishes (status.json and history.json).
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const word = { ok: 'Passed', fail: 'Failed', skip: 'Skipped' };
  const cls = (st) => `st-${st}`; // not .skip: the website uses that for its skip link
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const source = (name) => name.split(':')[0].trim();
  const get = (f) => fetch(f, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  Promise.all([get('status.json'), get('history.json')]).then(([s, h]) => {
    const checks = (s && s.checks) || [];
    const failed = checks.filter((c) => c.status === 'fail'), passed = checks.filter((c) => c.status === 'ok');
    const state = !checks.length ? 'skip' : failed.length ? 'fail' : 'ok';
    const headline = !checks.length ? 'No results yet. The first daily check has not run.' : failed.length ? `${failed.length} of ${checks.length} checks failed` : `All ${passed.length} checks that ran passed`;
    const sum = $('#summary');
    if (sum) { sum.className = `summary ${cls(state)}`; sum.innerHTML = `<span class="dot"></span><span><b>${esc(headline)}</b>${s && s.ranAt ? ` · ${esc(when(s.ranAt))}` : ''}${s && s.run ? ` · <a href="${esc(s.run)}">View the run</a>` : ''}</span>`; }
    const rows = $('#checks');
    if (rows) rows.innerHTML = checks.map((c) => `<tr><th scope="row">${esc(c.name)}<div class="note phone">${esc(c.note)}</div></th><td><span class="chip ${cls(c.status)}">${word[c.status] || esc(c.status)}</span></td><td class="note wide">${esc(c.note)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">No results yet.</td></tr>';
    const hist = $('#history');
    if (hist) {
      const runs = (h || []).slice(-60), names = [...new Set(runs.flatMap((r) => r.checks.map((c) => c.name)).concat(checks.map((c) => c.name)))];
      hist.innerHTML = names.length ? names.map((n) => `<div class="hrow"><span class="hname">${esc(n)}</span><span class="hcells">${runs.map((r) => { const c = r.checks.find((x) => x.name === n), st = c ? c.status : 'none'; return `<i class="${cls(st)}" title="${esc(`${when(r.ranAt)}: ${word[st] || 'not run'}`)}"></i>`; }).join('')}</span></div>`).join('') : '<p class="note">History starts with the first daily check.</p>';
    }
    // Home page: one result per source
    document.querySelectorAll('[data-src]').forEach((td) => {
      const mine = checks.filter((c) => source(c.name) === td.dataset.src);
      const st = !mine.length ? '' : mine.some((c) => c.status === 'fail') ? 'fail' : mine.some((c) => c.status === 'ok') ? 'ok' : 'skip';
      td.innerHTML = st ? `<a class="chip ${cls(st)}" href="./status.html">${{ ok: 'Working', fail: 'Failing', skip: 'Not checked' }[st]}</a>` : '<span class="note">Not checked yet</span>';
    });
    const line = $('#srcLine');
    if (line && checks.length) line.innerHTML = `<a href="./status.html">Data sources: ${failed.length ? `${failed.length} failing` : `all working`}</a> · checked ${esc(when(s.ranAt))}`;
  });
})();
