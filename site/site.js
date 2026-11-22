'use strict';
// The website's behavior: a live example chamber in the hero, the product
// tour tabs, gentle reveals on scroll, and the demo request form.
document.documentElement.classList.add('js');

(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- the live chamber ----------
  // Runs the same model as the app: each position is a chance of a yes vote,
  // and the odds are the exact chance of reaching the votes needed. The
  // example is invented; the math is real.
  const stage = $('.stage');
  if (stage) {
    const svg = $('svg', stage), seats = [...svg.querySelectorAll('.seat')];
    const PROB = [0.03, 0.25, 0.5, 0.75, 0.97];
    const NAMES = ['Vega', 'Nakamura', 'Stanhope', 'Banerjee', 'Buckley', 'Tran', 'Castellanos', 'Abernathy', 'Holloway', 'Iversen', 'Marsh', 'Delacroix', 'Okafor', 'Lindqvist', 'Pruitt', 'Ferreira', 'Whitcomb', 'Achterberg', 'Thibodeaux', 'Hallstrom', 'Quist', 'Ramsay', 'Kowalczyk', 'Bellamy', 'Ostrowski', 'Garza', 'Fenwick', 'Mbeki', 'Calloway', 'Sandoval', 'Pemberton', 'Aldana', 'Rourke', 'Haddad', 'Lindgren', 'Moreau', 'Kincaid', 'Navarro', 'Ashworth', 'Duquesne', 'Varga'];
    const start = seats.map((s) => +(/p(\d)/.exec(s.getAttribute('class')) || [0, 2])[1]);
    let pos = start.slice(), target = -1, ticks = 0, timer = null, visible = true;
    const need = Math.floor(seats.length / 2) + 1;
    const odds = (p) => { let d = [1]; for (const v of p) { const q = PROB[v], n = new Array(d.length + 1).fill(0); d.forEach((x, k) => { n[k] += x * (1 - q); n[k + 1] += x * q; }); d = n; } return d.slice(need).reduce((a, b) => a + b, 0); };
    const count = (p) => p.filter((v) => v >= 3).length;
    const pct = (x) => Math.round(x * 100);

    // A dashed ring marks whoever the call sheet says to see next.
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('class', 'ring'); ring.setAttribute('r', '24'); svg.appendChild(ring);
    const hub = $('.hub', svg), oddsEl = $('#hOdds', stage), countEl = $('#hCount', stage), nextEl = $('#hNext', stage), meter = $('.meter', stage), mark = $('.need', stage);

    function bestMove() {
      const base = odds(pos); let best = -1, gain = 0;
      pos.forEach((v, i) => { if (v >= 4) return; const t = pos.slice(); t[i] = v + 1; const g = odds(t) - base; if (g > gain) { gain = g; best = i; } });
      return [best, gain];
    }
    function tween(el, to, fmt) {
      const from = +el.dataset.v || 0; el.dataset.v = to;
      if (reduced || from === to) { el.firstChild.textContent = fmt(to); return; }
      const t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3); el.firstChild.textContent = fmt(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
    function draw(moved, slipped) {
      seats.forEach((s, i) => { s.setAttribute('class', s.getAttribute('class').replace(/\bp\d\b/, `p${pos[i]}`).replace(/\s*\b(moved|slipped)\b/g, '')); });
      if (moved >= 0) { const s = seats[moved]; void s.getBBox(); s.classList.add(slipped ? 'slipped' : 'moved'); }
      const c = count(pos), o = odds(pos);
      if (hub && hub.firstChild) hub.firstChild.textContent = String(c);
      if (countEl) tween(countEl, c, String);
      if (oddsEl) tween(oddsEl, pct(o), (v) => `${v}%`);
      if (meter) {
        const n = [4, 3, 2, 1, 0].map((p) => pos.filter((v) => v === p).length);
        [...meter.children].forEach((span, k) => { span.style.flexBasis = `${(n[k] / seats.length) * 100}%`; });
        if (mark) mark.style.left = `${(need / seats.length) * 100}%`;
      }
      const [best, gain] = bestMove(); target = best;
      if (best >= 0) {
        const s = seats[best]; ring.setAttribute('cx', s.getAttribute('cx')); ring.setAttribute('cy', s.getAttribute('cy')); ring.classList.add('on');
        if (nextEl) nextEl.innerHTML = `Sen. ${NAMES[best % NAMES.length]} <em>+${Math.max(1, Math.round(gain * 100))} pts</em>`;
      } else ring.classList.remove('on');
    }
    function tick() {
      if (!visible || document.hidden) return;
      ticks++;
      if (count(pos) >= need + 4 || ticks > 16) { pos = start.slice(); ticks = 0; draw(-1); return; }
      // Most of the time the meeting works; now and then someone drifts the other way.
      if (ticks % 5 === 0) {
        const leaning = pos.map((v, i) => [v, i]).filter(([v]) => v === 3 || v === 2);
        if (leaning.length) { const [, i] = leaning[(ticks * 7) % leaning.length]; pos[i] -= 1; draw(i, true); return; }
      }
      if (target >= 0) { pos[target] += 1; draw(target, false); }
    }
    draw(-1);
    if (!reduced) {
      timer = setInterval(tick, 2600);
      if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(stage);
    }
  }

  // ---------- product tour tabs ----------
  document.querySelectorAll('[role=tablist]').forEach((list) => {
    const tabs = [...list.querySelectorAll('[role=tab]')];
    const pick = (t, focus) => {
      tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; const p = document.getElementById(x.getAttribute('aria-controls')); if (p) p.hidden = !on; });
      if (focus) t.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => pick(t));
      t.addEventListener('keydown', (e) => {
        const k = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
        if (k === undefined) return; e.preventDefault(); pick(tabs[(i + k + tabs.length) % tabs.length], true);
      });
    });
  });

  // ---------- reveal on scroll ----------
  const rs = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) rs.forEach((el) => el.classList.add('in'));
  else {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
    rs.forEach((el) => io.observe(el));
  }

  // ---------- demo request ----------
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.lead');
    if (!form) return;
    e.preventDefault();
    const status = form.querySelector('.status'), button = form.querySelector('button[type=submit]');
    const body = Object.fromEntries(new FormData(form).entries());
    button.disabled = true; status.textContent = 'Sending';
    try {
      const res = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'That did not go through. Try again in a minute.');
      form.reset(); status.textContent = 'Thank you. We have your request and will reply by email.';
    } catch (err) { status.textContent = err.message; }
    button.disabled = false;
  });
})();
