// Public action page: find your legislators by address, then send a letter.
(function () {
  const $ = (s) => document.querySelector(s);
  const id = location.pathname.split('/').pop();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let page = null, found = null, picked = null;
  const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
  $('#state').insertAdjacentHTML('beforeend', Object.entries(STATES).map(([k, n]) => `<option value="${k}">${n}</option>`).join(''));
  const addr = () => ({ street: $('#street').value, city: $('#city').value, state: $('#state').value, zip: $('#zip').value });
  const memberLine = (m) => `<li><b>${esc(m.title ? m.title + ' ' : '')}${esc(m.name)}</b><span>${esc([m.party, m.district].filter(Boolean).join(', '))}${m.email ? ' · gets your letter by email' : m.phone ? ' · call their office' : ''}</span></li>`;
  async function call(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(json.error || 'Something went wrong. Try again.'); err.notFound = Boolean(json.notFound); throw err; }
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
    if (p.state && STATES[p.state]) $('#state').value = p.state;
    $('#pickMember').innerHTML = '<option value="">Choose</option>' + (p.members || []).map((m) => `<option value="${esc(m.id)}">${esc([m.title, m.name].filter(Boolean).join(' '))}${m.district ? ` (district ${esc(m.district)})` : ''}</option>`).join('');
  }).catch((e) => { $('#title').textContent = 'This page is not available'; $('#intro').textContent = e.message; $('#where').hidden = true; });

  $('#where').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button'), msg = $('#whereMsg');
    busy(btn, true, 'Looking up'); msg.textContent = ''; picked = null; $('#pick').hidden = true;
    try {
      found = await call('POST', `/api/act/${encodeURIComponent(id)}/lookup`, { address: addr() });
      $('#who').hidden = false;
      // Show the address that was found, so a wrong match is easy to spot and fix
      $('#matched').innerHTML = `We found <b>${esc(found.address)}</b>. Not your address? Correct it above and look again.`;
      if (!found.members.length) {
        $('#members').innerHTML = `<li>${found.where ? `Your address is in <b>${esc(found.where)}</b>. ` : ''}This campaign is asking other legislators to act, so there is no letter for yours. Thank you for checking: share this page with friends in other districts.</li>`;
        $('#letter').hidden = true; return;
      }
      $('#members').innerHTML = found.members.map(memberLine).join('');
      $('#letter').hidden = false; $('#name').focus();
    } catch (e) {
      msg.textContent = e.message;
      // Formatting should never be why someone is turned away: let them pick
      if (e.notFound && page && (page.members || []).length) { $('#pick').hidden = false; $('#who').hidden = true; $('#letter').hidden = true; }
    }
    finally { busy(btn, false, 'Find my legislators'); }
  });

  $('#pickGo').addEventListener('click', () => {
    const m = (page.members || []).find((x) => x.id === $('#pickMember').value);
    if (!m) { $('#whereMsg').textContent = 'Choose your legislator from the list.'; return; }
    picked = m.id; $('#who').hidden = false;
    $('#matched').textContent = 'Your letter will include your address as you typed it, so the office can check it.';
    $('#members').innerHTML = memberLine(m);
    $('#letter').hidden = false; $('#name').focus();
  });

  $('#letter').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#sendBtn'), msg = $('#sendMsg');
    busy(btn, true, 'Sending'); msg.textContent = '';
    try {
      const r = await call('POST', `/api/act/${encodeURIComponent(id)}/send`, { address: addr(), memberId: picked || undefined, name: $('#name').value, email: $('#email').value, subject: $('#subject').value, message: $('#message').value, optin: $('#optin').checked, website: $('#website').value });
      $('#where').hidden = true; $('#letter').hidden = true; $('#who').hidden = true; $('#done').hidden = false;
      $('#doneText').textContent = r.emailed.length ? `Your letter is on its way to ${r.emailed.join(' and ')}. Offices count every constituent letter.` : 'Your response is recorded. These offices take messages by phone or on their website:';
      $('#calls').innerHTML = (r.call.length ? `<h3>Make it count: call too</h3><p class="fine">${esc(page.callScript || 'Say you are a constituent, give your address, and ask for their support.')}</p><div class="calls">${r.call.map((c) => `<a href="tel:${esc(c.phone.replace(/[^0-9+]/g, ''))}">Call ${esc(c.name)}: ${esc(c.phone)}</a>`).join('')}</div>` : '')
        + (r.forms.length ? `<div class="calls">${r.forms.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">Write to ${esc(f.name)} on their website</a>`).join('')}</div>` : '');
      $('#done').scrollIntoView({ behavior: 'smooth' });
    } catch (e) { msg.textContent = e.message; }
    finally { busy(btn, false, 'Send my letter'); }
  });
})();
