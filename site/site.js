'use strict';
// The website's behavior: the House filling in as you scroll, a dotted
// progress line, the header changing when you leave the dark chamber, and
// the contact form.
document.documentElement.classList.add('js');

(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- the House, 435 seats ----------
  // An illustration, drawn the way the app draws a chamber: seats in rows,
  // ordered left to right. Each step of the story colours them a little more.
  const svg = $('#chamber');
  if (svg) {
    const NS = 'http://www.w3.org/2000/svg', N = 435, ROWS = 12, CX = 500, CY = 500, R0 = 190, R1 = 480;
    let seed = 7; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const radii = Array.from({ length: ROWS }, (_, k) => R0 + ((R1 - R0) * k) / (ROWS - 1));
    const sum = radii.reduce((a, b) => a + b, 0);
    const counts = radii.map((r) => Math.round((N * r) / sum));
    counts[ROWS - 1] += N - counts.reduce((a, b) => a + b, 0);
    const seats = [];
    radii.forEach((r, k) => {
      for (let j = 0; j < counts[k]; j++) {
        const a = Math.PI * (1 - j / (counts[k] - 1));
        seats.push({ a, x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) });
      }
    });
    seats.sort((p, q) => q.a - p.a);
    svg.setAttribute('viewBox', '0 0 1000 510');
    const dots = seats.map((s) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', s.x.toFixed(1)); c.setAttribute('cy', s.y.toFixed(1)); c.setAttribute('r', '7.6'); svg.appendChild(c); return c; });
    // Where each seat leans: mostly by side of the chamber, with some crossing over.
    const lean = seats.map((_, i) => i / N + (rnd() - 0.5) * 0.5);
    const order = lean.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]).map(([, i]) => i);
    const YES = 209, UND = 15, NEED = 218;
    const yes = new Set(order.slice(0, YES)), und = new Set(order.slice(YES, YES + UND));
    const cos = new Set([...yes].filter(() => rnd() < 0.13).slice(0, 26));
    const next = [...und].slice(0, 3);
    const read = $('#stRead'), big = read && $('b', read), small = read && $('span', read);
    const STEPS = [
      { cls: () => '', b: N, s: 'Seats in the House' },
      { cls: (i) => (cos.has(i) ? 'y' : ''), b: cos.size, s: `Yes so far · ${NEED} needed` },
      { cls: (i) => (yes.has(i) ? 'y' : und.has(i) ? 'u' : 'n'), b: YES, s: `Yes · ${N - YES - UND} no · ${UND} undecided` },
      { cls: (i) => (yes.has(i) ? 'y' : und.has(i) ? 'u glow' : 'n'), b: NEED - YES, s: `Votes short · ${UND} undecided to work`, focus: true },
    ];
    let cur = -1;
    const count = (to) => {
      if (!big) return;
      const from = +big.dataset.v || 0; big.dataset.v = to;
      if (reduced) { big.textContent = to; return; }
      const t0 = performance.now(), step = (t) => { const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3); big.textContent = Math.round(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    };
    const show = (n) => {
      if (n === cur) return; cur = n; const st = STEPS[n];
      dots.forEach((d, i) => d.setAttribute('class', `${st.cls(i)}${st.focus && next.includes(i) ? ' next' : ''}`.trim()));
      svg.classList.toggle('focus', Boolean(st.focus));
      count(st.b); if (small) small.textContent = st.s;
    };
    show(0);
    const steps = [...document.querySelectorAll('.step')];
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        if (!e.isIntersecting) return;
        steps.forEach((s) => s.classList.toggle('on', s === e.target));
        show(Math.min(STEPS.length - 1, +e.target.dataset.step || 0));
      }), { rootMargin: '-40% 0px -40% 0px' });
      steps.forEach((s) => io.observe(s));
    } else { steps.forEach((s) => s.classList.add('on')); show(STEPS.length - 1); }
  }

  // ---------- reading progress and the header ----------
  const bar = $('.progress i'), story = $('.story'), body = document.body;
  const onScroll = () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.width = `${h > 0 ? Math.min(100, (scrollY / h) * 100) : 0}%`;
    if (story && body.classList.contains('home')) body.classList.toggle('past', scrollY > story.offsetTop + story.offsetHeight - 70);
  };
  addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll); onScroll();
  if (!story) body.classList.add('past');

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
