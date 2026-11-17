// Public action page: find your legislators by address, then send a letter.
(function () {
  const $ = (s) => document.querySelector(s);
  const id = location.pathname.split('/').pop();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let page = null, found = null;
  async function call(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Something went wrong. Try again.');
    return json;
  }
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  call('GET', `/api/act/${encodeURIComponent(id)}`).then((p) => {
    page = p;
    document.title = `${p.title}${p.org ? ` · ${p.org}` : ''}`;
    $('#org').textContent = p.org ? `${p.org} · Take action` : 'Take action';
    $('#title').textContent = p.title;
    $('#intro').textContent = p.intro;
    $('#subject').value = p.subject || p.title;
    $('#message').value = p.letter;
  }).catch((e) => { $('#title').textContent = 'This page is not available'; $('#intro').textContent = e.message; $('#where').hidden = true; });

  $('#where').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button'), msg = $('#whereMsg');
    busy(btn, true, 'Looking up'); msg.textContent = '';
    try {
      found = await call('POST', `/api/act/${encodeURIComponent(id)}/lookup`, { address: $('#address').value });
      $('#who').hidden = false;
      if (!found.members.length) {
        $('#members').innerHTML = '<li>None of the legislators this campaign is asking to act represent your address. Thank you for checking: share this page with friends in other districts.</li>';
        $('#letter').hidden = true; return;
      }
      $('#members').innerHTML = found.members.map((m) => `<li><b>${esc(m.title ? m.title + ' ' : '')}${esc(m.name)}</b><span>${esc([m.party, m.district].filter(Boolean).join(', '))}${m.email ? ' · gets your letter by email' : m.phone ? ' · call their office' : ''}</span></li>`).join('');
      $('#letter').hidden = false; $('#name').focus();
    } catch (e) { msg.textContent = e.message; }
    finally { busy(btn, false, 'Find my legislators'); }
  });

  $('#letter').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#sendBtn'), msg = $('#sendMsg');
    busy(btn, true, 'Sending'); msg.textContent = '';
    try {
      const r = await call('POST', `/api/act/${encodeURIComponent(id)}/send`, { address: $('#address').value, name: $('#name').value, email: $('#email').value, subject: $('#subject').value, message: $('#message').value, optin: $('#optin').checked, website: $('#website').value });
      $('#where').hidden = true; $('#letter').hidden = true; $('#who').hidden = true; $('#done').hidden = false;
      $('#doneText').textContent = r.emailed.length ? `Your letter is on its way to ${r.emailed.join(' and ')}. Offices count every constituent letter.` : 'Your response is recorded. These offices take messages by phone or on their website:';
      $('#calls').innerHTML = (r.call.length ? `<h3>Make it count: call too</h3><p class="fine">${esc(page.callScript || 'Say you are a constituent, give your address, and ask for their support.')}</p><div class="calls">${r.call.map((c) => `<a href="tel:${esc(c.phone.replace(/[^0-9+]/g, ''))}">Call ${esc(c.name)}: ${esc(c.phone)}</a>`).join('')}</div>` : '')
        + (r.forms.length ? `<div class="calls">${r.forms.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">Write to ${esc(f.name)} on their website</a>`).join('')}</div>` : '');
      $('#done').scrollIntoView({ behavior: 'smooth' });
    } catch (e) { msg.textContent = e.message; }
    finally { busy(btn, false, 'Send my letter'); }
  });
})();
