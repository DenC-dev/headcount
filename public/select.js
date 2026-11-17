'use strict';
// Custom dropdowns. Every <select> is shown as a styled button and list (the
// ARIA "select-only combobox" pattern), while the real <select> stays in the
// page, hidden, holding the value and firing the usual input and change events.
// App code, forms and tests keep using .value and 'change' unchanged, and any
// <select> added later is picked up automatically. Opt out with data-native.
(function () {
  if (window.CustomSelect || !window.MutationObserver) return;
  const STATE = new WeakMap();
  let seq = 0, open = null;

  // Keep the button in step when code sets the value directly.
  const d = (proto, prop) => Object.getOwnPropertyDescriptor(proto, prop);
  const valueD = d(HTMLSelectElement.prototype, 'value'), indexD = d(HTMLSelectElement.prototype, 'selectedIndex'), selectedD = d(HTMLOptionElement.prototype, 'selected');
  Object.defineProperty(HTMLSelectElement.prototype, 'value', { configurable: true, enumerable: valueD.enumerable, get() { return valueD.get.call(this); }, set(v) { valueD.set.call(this, v); refresh(this); } });
  Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', { configurable: true, enumerable: indexD.enumerable, get() { return indexD.get.call(this); }, set(v) { indexD.set.call(this, v); refresh(this); } });
  Object.defineProperty(HTMLOptionElement.prototype, 'selected', { configurable: true, enumerable: selectedD.enumerable, get() { return selectedD.get.call(this); }, set(v) { selectedD.set.call(this, v); const s = this.parentElement && this.parentElement.closest('select'); if (s) refresh(s); } });

  const list = document.createElement('div');
  list.className = 'cs-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
  const label = (o) => (o.label || o.textContent || '').replace(/\s+/g, ' ').trim();
  const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text || ' '; return s; };
  const enabled = (sel, i) => { const o = sel.options[i]; return o && !o.disabled && !o.hidden && !(o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled); };

  function nameOf(sel) {
    const a = sel.getAttribute('aria-label'); if (a) return a;
    const l = sel.labels && sel.labels[0];
    if (l) { const c = l.cloneNode(true); c.querySelectorAll('.cs, select, button, input, textarea, datalist').forEach((n) => n.remove()); const t = c.textContent.replace(/\s+/g, ' ').trim(); if (t) return t; }
    return sel.title || '';
  }

  function enhance(sel) {
    if (STATE.has(sel) || sel.multiple || sel.size > 1 || sel.hasAttribute('data-native') || !sel.parentNode) return;
    const id = `cs${++seq}`, btn = document.createElement('button'), face = document.createElement('span');
    // Code that replaces a select in place (outerHTML) leaves it inside the old wrapper: reuse that wrapper.
    const reuse = sel.parentElement && sel.parentElement.classList.contains('cs') ? sel.parentElement : null;
    const wrap = reuse || document.createElement('span');
    if (reuse) [...reuse.children].forEach((c) => { if (c !== sel) c.remove(); });
    wrap.className = `cs ${sel.className || ''}`.trim();
    btn.type = 'button'; btn.className = 'cs-trigger'; btn.id = sel.id ? `${sel.id}-cs` : id;
    btn.setAttribute('role', 'combobox'); btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', `${id}-list`);
    face.className = 'cs-face'; btn.appendChild(face);
    if (!reuse) sel.parentNode.insertBefore(wrap, sel);
    wrap.append(sel, btn); // the select comes first, so clicking its <label> lands on it and moves on to the button
    sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    STATE.set(sel, { id, wrap, btn, face, key: '' });
    btn.addEventListener('click', () => (open && open.sel === sel ? close() : show(sel)));
    btn.addEventListener('keydown', (e) => key(e, sel));
    sel.addEventListener('focus', () => btn.focus());
    refresh(sel);
  }

  function refresh(sel) {
    const st = STATE.get(sel); if (!st) return;
    const opts = [...sel.options].filter((o) => !o.hidden), cur = sel.options[sel.selectedIndex];
    // Every option sits invisibly under the current one, so the button keeps the width of the longest, like a native select.
    const ghosts = opts.slice(0, 80).map(label), now = cur ? label(cur) : '', sig = `${ghosts.join('\u0001')}\u0002${now}`;
    if (st.key !== sig) { st.key = sig; st.face.replaceChildren(...ghosts.map((t) => span('cs-ghost', t)), span('cs-value', now)); }
    st.btn.disabled = sel.disabled; st.wrap.hidden = sel.hidden;
    const n = nameOf(sel); if (n) st.btn.setAttribute('aria-label', n); else st.btn.removeAttribute('aria-label');
    if (open && open.sel === sel) draw();
  }

  // ---------- the list ----------
  function draw() {
    const { sel } = open, st = STATE.get(sel);
    list.id = `${st.id}-list`; list.setAttribute('aria-label', nameOf(sel) || 'Options');
    const make = (o) => {
      const el = document.createElement('div'), i = o.index;
      el.className = 'cs-opt'; el.id = `${st.id}-o${i}`; el.dataset.i = i; el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === sel.selectedIndex));
      if (!enabled(sel, i)) el.setAttribute('aria-disabled', 'true');
      el.textContent = label(o) || ' ';
      open.els[i] = el; return el;
    };
    open.els = [];
    const kids = [];
    for (const c of sel.children) {
      if (c.tagName === 'OPTION' && !c.hidden) kids.push(make(c));
      else if (c.tagName === 'OPTGROUP') {
        const g = document.createElement('div'), h = document.createElement('div');
        g.setAttribute('role', 'group'); h.className = 'cs-group'; h.id = `${st.id}-g${kids.length}`; h.textContent = c.label;
        h.setAttribute('role', 'presentation'); g.setAttribute('aria-labelledby', h.id); g.append(h, ...[...c.children].filter((o) => o.tagName === 'OPTION' && !o.hidden).map(make));
        kids.push(g);
      }
    }
    list.replaceChildren(...kids);
    activate(open.active, false);
  }
  function show(sel, where) {
    if (sel.disabled) return;
    if (open) close(false);
    if (!list.isConnected) document.body.appendChild(list);
    const st = STATE.get(sel), n = sel.options.length;
    const first = [...Array(n).keys()].find((i) => enabled(sel, i)), last = [...Array(n).keys()].reverse().find((i) => enabled(sel, i));
    open = { sel, active: where === 'first' ? first : where === 'last' ? last : sel.selectedIndex >= 0 ? sel.selectedIndex : first, typed: '', at: 0, els: [] };
    draw();
    list.hidden = false; st.btn.setAttribute('aria-expanded', 'true'); st.wrap.classList.add('open');
    place(); activate(open.active, true);
  }
  function close(focus) {
    if (!open) return;
    const st = STATE.get(open.sel);
    list.hidden = true; list.replaceChildren();
    if (st) { st.btn.setAttribute('aria-expanded', 'false'); st.btn.removeAttribute('aria-activedescendant'); st.wrap.classList.remove('open'); if (focus) st.btn.focus(); }
    open = null;
  }
  function activate(i, scroll) {
    if (!open) return;
    const prev = open.els[open.active]; if (prev) prev.classList.remove('active');
    const el = open.els[i]; if (!el) return;
    open.active = i; el.classList.add('active');
    STATE.get(open.sel).btn.setAttribute('aria-activedescendant', el.id);
    if (scroll) { const top = el.offsetTop, bottom = top + el.offsetHeight; if (top < list.scrollTop) list.scrollTop = top - 4; else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4; }
  }
  function choose(i, focus = true) {
    if (!open) return;
    const sel = open.sel;
    if (i === undefined || i < 0 || !enabled(sel, i)) { close(focus); return; }
    const changed = i !== sel.selectedIndex;
    indexD.set.call(sel, i); close(focus); refresh(sel);
    if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function step(by) {
    const sel = open.sel, n = sel.options.length; let i = open.active === undefined ? -1 : open.active, moved = i;
    for (let k = 0; k < Math.abs(by); k++) { let j = moved; do { j += Math.sign(by); } while (j >= 0 && j < n && !enabled(sel, j)); if (j < 0 || j >= n) break; moved = j; }
    if (moved !== i && moved >= 0) activate(moved, true);
  }
  function typeahead(ch) {
    const sel = open.sel, now = Date.now();
    open.typed = (now - open.at < 700 ? open.typed : '') + ch.toLowerCase(); open.at = now;
    const n = sel.options.length, same = open.typed.split('').every((c) => c === open.typed[0]), want = same ? open.typed[0] : open.typed;
    const from = same || open.typed.length === 1 ? (open.active || 0) + 1 : open.active || 0;
    for (let k = 0; k < n; k++) { const i = (from + k) % n; if (enabled(sel, i) && label(sel.options[i]).toLowerCase().startsWith(want)) { activate(i, true); return; } }
  }
  function place() {
    if (!open) return;
    const r = STATE.get(open.sel).btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh || (!r.width && !r.height)) { close(false); return; }
    list.style.minWidth = `${Math.min(r.width, vw - 16)}px`; list.style.maxWidth = `${Math.min(480, vw - 16)}px`; list.style.maxHeight = 'none';
    const natural = Math.min(list.scrollHeight, 320), below = vh - r.bottom - 10, above = r.top - 10, up = below < Math.min(natural, 220) && above > below;
    const h = Math.max(96, Math.min(natural, up ? above : below));
    list.style.maxHeight = `${h}px`;
    list.style.top = `${up ? r.top - Math.min(natural, h) - 4 : r.bottom + 4}px`;
    list.style.left = `${Math.max(8, Math.min(r.left, vw - list.offsetWidth - 8))}px`;
  }

  // ---------- keyboard ----------
  function key(e, sel) {
    const k = e.key, isOpen = open && open.sel === sel, printable = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) { e.preventDefault(); show(sel); }
      else if (k === 'Home' || k === 'End') { e.preventDefault(); show(sel, k === 'Home' ? 'first' : 'last'); }
      else if (printable) { e.preventDefault(); show(sel); typeahead(k); }
      return;
    }
    switch (k) {
      case 'ArrowDown': e.preventDefault(); if (e.altKey) choose(open.active); else step(1); break;
      case 'ArrowUp': e.preventDefault(); if (e.altKey) choose(open.active); else step(-1); break;
      case 'PageDown': e.preventDefault(); step(10); break;
      case 'PageUp': e.preventDefault(); step(-10); break;
      case 'Home': case 'End': {
        e.preventDefault();
        const idx = [...Array(sel.options.length).keys()].filter((i) => enabled(sel, i));
        if (idx.length) activate(k === 'Home' ? idx[0] : idx[idx.length - 1], true);
        break;
      }
      case 'Enter': e.preventDefault(); choose(open.active); break;
      case ' ': e.preventDefault(); if (open.typed && Date.now() - open.at < 700) typeahead(' '); else choose(open.active); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break; // closes the list, not the drawer around it
      case 'Tab': choose(open.active, false); break;
      default: if (printable) { e.preventDefault(); typeahead(k); }
    }
  }

  // ---------- pointer and page events ----------
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
  list.addEventListener('click', (e) => { const o = e.target.closest('.cs-opt'); if (o && open) choose(Number(o.dataset.i)); });
  list.addEventListener('mousemove', (e) => { const o = e.target.closest('.cs-opt'); if (o && open && Number(o.dataset.i) !== open.active && o.getAttribute('aria-disabled') !== 'true') activate(Number(o.dataset.i), false); });
  document.addEventListener('pointerdown', (e) => { if (open && !list.contains(e.target) && !STATE.get(open.sel).btn.contains(e.target)) close(false); }, true);
  window.addEventListener('resize', () => place());
  document.addEventListener('scroll', (e) => { if (open && e.target !== list) place(); }, true);
  window.addEventListener('blur', () => close(false));
  for (const ev of ['change', 'input']) document.addEventListener(ev, (e) => { if (e.target && e.target.tagName === 'SELECT') refresh(e.target); }, true);
  document.addEventListener('reset', (e) => setTimeout(() => e.target.querySelectorAll('select').forEach(refresh)), true);

  // ---------- new and changed selects ----------
  const inside = (n) => n === list || list.contains(n) || (n.closest && n.closest('.cs-trigger'));
  new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target;
      if (inside(t)) continue;
      const sel = t.tagName === 'SELECT' ? t : t.closest && t.closest('select');
      if (sel) { refresh(sel); continue; }
      if (m.type !== 'childList') continue;
      // A select removed on its own leaves its button behind; take the wrapper away too.
      if (t.classList && t.classList.contains('cs') && !t.querySelector(':scope > select')) { t.remove(); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.tagName === 'SELECT') enhance(n); else if (n.firstElementChild) n.querySelectorAll('select').forEach(enhance); }
    }
    if (open && !open.sel.isConnected) close(false);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-label', 'label'] });
  const start = () => document.querySelectorAll('select').forEach(enhance);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.CustomSelect = { enhance, refresh, close };
})();
