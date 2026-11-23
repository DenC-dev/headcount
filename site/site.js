'use strict';
// The website's motion: the hero letters spreading out, the House filling in
// and then ticking over like a live count, things easing in as you scroll,
// callouts drawing onto the screenshot, the carousel and the rotating tabs.
document.documentElement.classList.add('js');

(function () {
  const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const body = document.body;

  // ---------- announcement ----------
  const ann = $('#announce');
  if (ann) {
    let off = false; try { off = localStorage.getItem('hc.announce') === ann.dataset.v; } catch (_) { /* private mode */ }
    if (off) ann.classList.add('gone');
    $('button', ann)?.addEventListener('click', () => { ann.classList.add('gone'); try { localStorage.setItem('hc.announce', ann.dataset.v); } catch (_) { /* fine */ } });
  }

  // ---------- header: light once you leave the dark hero ----------
  const hero = $('.hero');
  const onScroll = () => { if (hero) body.classList.toggle('past', scrollY > hero.offsetHeight - 80); };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  if (!hero) body.classList.add('past');

  // ---------- the House: 435 seats ----------
  const svg = $('#chamber');
  if (svg) {
    const NS = 'http://www.w3.org/2000/svg', N = 435, ROWS = 12, CX = 500, CY = 500, R0 = 190, R1 = 480;
    let seed = 11; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const radii = Array.from({ length: ROWS }, (_, k) => R0 + ((R1 - R0) * k) / (ROWS - 1)), sum = radii.reduce((a, b) => a + b, 0);
    const counts = radii.map((r) => Math.round((N * r) / sum)); counts[ROWS - 1] += N - counts.reduce((a, b) => a + b, 0);
    const seats = [];
    radii.forEach((r, k) => { for (let j = 0; j < counts[k]; j++) { const a = Math.PI * (1 - j / (counts[k] - 1)); seats.push({ a, x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) }); } });
    seats.sort((p, q) => q.a - p.a);
    svg.setAttribute('viewBox', '0 0 1000 510');
    const dots = seats.map((s) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', s.x.toFixed(1)); c.setAttribute('cy', s.y.toFixed(1)); c.setAttribute('r', '7.4'); svg.appendChild(c); return c; });
    const lean = seats.map((_, i) => i / N + (rnd() - 0.5) * 0.45), order = lean.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]).map(([, i]) => i);
    const state = new Array(N).fill('');
    order.forEach((i, k) => { state[i] = k < 212 ? 'y' : k < 232 ? 'u' : 'n'; });
    const paint = (i) => dots[i].setAttribute('class', state[i]);
    const start = () => {
      hero && hero.classList.add('ready');
      if (reduced) { dots.forEach((_, i) => paint(i)); return; }
      // fill in a sweep from left to right, then tick over like a live count
      dots.forEach((_, i) => setTimeout(() => paint(i), 700 + i * 4));
      setTimeout(() => {
        setInterval(() => {
          if (document.hidden) return;
          const i = order[200 + Math.floor(rnd() * 45)], d = dots[i];
          d.setAttribute('class', 'flash');
          setTimeout(() => { state[i] = state[i] === 'u' ? (rnd() < 0.6 ? 'y' : 'n') : 'u'; paint(i); }, 180);
        }, 900);
      }, 700 + N * 4 + 400);
    };
    if (document.readyState === 'complete') start(); else addEventListener('load', start);
  } else if (hero) hero.classList.add('ready');

  // ---------- ease in on scroll ----------
  const io = 'IntersectionObserver' in window && !reduced ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' }) : null;
  $$('[data-in], .callouts, .closing').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));

  // ---------- carousel ----------
  $$('.carousel').forEach((car) => {
    const slides = $$('.slide', car), bar = car.nextElementSibling, dots = bar ? $$('.dots i', bar) : [], num = bar && $('.num', bar), line = $('.progress-line', car);
    let k = 0, timer = null; const T = 5200;
    const show = (n) => {
      k = (n + slides.length) % slides.length;
      slides.forEach((s, i) => s.classList.toggle('on', i === k)); dots.forEach((d, i) => d.classList.toggle('on', i === k));
      if (num) num.textContent = `${String(k + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
      if (line && !reduced) { line.style.transition = 'none'; line.style.width = '0'; void line.offsetWidth; line.style.transition = `width ${T}ms linear`; line.style.width = '100%'; }
      clearTimeout(timer); if (!reduced) timer = setTimeout(() => show(k + 1), T);
    };
    bar && $('[data-dir="-1"]', bar)?.addEventListener('click', () => show(k - 1));
    bar && $('[data-dir="1"]', bar)?.addEventListener('click', () => show(k + 1));
    show(0);
  });

  // ---------- rotating feature tabs ----------
  $$('.stagebox').forEach((box) => {
    const tabs = $$('.tabbar [role=tab]', box), panes = $$('.pane', box), glow = $('.glow', box), bar = $('.tabbar', box);
    const T = 6500; let k = 0, timer = null, hover = false;
    box.style.setProperty('--t', `${T}ms`);
    const pick = (n, user) => {
      k = (n + tabs.length) % tabs.length;
      tabs.forEach((t, i) => { t.setAttribute('aria-selected', String(i === k)); t.tabIndex = i === k ? 0 : -1; const ii = $('i', t); if (ii) { ii.style.animation = 'none'; void ii.offsetWidth; ii.style.animation = ''; } });
      panes.forEach((p, i) => p.classList.toggle('on', i === k));
      const p = panes[k]; if (glow && p) { glow.style.setProperty('--gx', p.dataset.gx || '30%'); glow.style.setProperty('--gy', p.dataset.gy || '60%'); glow.style.setProperty('--gc', p.dataset.gc || 'rgba(19,102,214,.45)'); }
      clearTimeout(timer); if (!reduced && !user) timer = setTimeout(() => { if (!hover) pick(k + 1); else pick(k); }, T);
      if (user) { bar.classList.add('paused'); timer = setTimeout(() => { bar.classList.remove('paused'); pick(k + 1); }, T * 1.6); }
    };
    tabs.forEach((t, i) => t.addEventListener('click', () => pick(i, true)));
    box.addEventListener('mouseenter', () => { hover = true; }); box.addEventListener('mouseleave', () => { hover = false; });
    pick(0);
  });

  // ---------- contact form ----------
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.lead');
    if (!form) return;
    e.preventDefault();
    const status = form.querySelector('.status'), button = form.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(form).entries());
    button.disabled = true; status.textContent = 'Sending';
    try {
      const res = await fetch(form.dataset.action || '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'That did not go through. Try again in a minute.');
      form.reset(); status.textContent = 'Thanks. Your message was sent, and we\'ll reply by email.';
    } catch (err) { status.textContent = err.message; }
    button.disabled = false;
  });
})();
