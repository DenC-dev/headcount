'use strict';
// Sign-in, the Headcount server API, and each user's own calendar and email.
//
// Sign-in uses Google Cloud Identity Platform (Firebase Authentication) with
// Google and Microsoft accounts. Calendar and email access is requested only
// when someone first sends a meeting request or invitation, and the access
// token stays in this browser tab: the server never sees it.

(function () {
  const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.send'];
  const MS_SCOPES = ['Calendars.ReadWrite', 'Mail.Send'];
  const TOKEN_KEY = 'headcount.mailcal';
  const DEV_KEY = 'headcount.devuser';
  const SESSION_KEY = 'headcount.session';
  const lsRead = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
  const lsWrite = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } };

  const C = {
    config: null, user: null, ready: false, listeners: [],
    onChange(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach((fn) => { try { fn(this.user); } catch (e) { console.error(e); } }); },
  };
  let fb = null, auth = null;

  class CloudError extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status; }
  }
  C.CloudError = CloudError;

  // ---------- start-up ----------
  C.init = async function () {
    try { C.config = await (await fetch('/api/config')).json(); } catch (_) { C.config = { auth: 'none', providers: [], bills: {}, states: {}, ai: false }; }
    const cfg = C.config;
    if (cfg.auth === 'firebase') {
      try {
        const v = cfg.firebase.sdkVersion;
        const [appMod, authMod] = await Promise.all([
          import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
          import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
        ]);
        fb = authMod;
        const app = appMod.initializeApp({ apiKey: cfg.firebase.apiKey, authDomain: cfg.firebase.authDomain, projectId: cfg.firebase.projectId });
        auth = authMod.getAuth(app);
        await new Promise((resolve) => {
          let first = true;
          authMod.onAuthStateChanged(auth, (u) => {
            const p = u && u.providerData && u.providerData[0];
            const pid = p ? p.providerId : '';
            C.user = u ? { id: u.uid, name: u.displayName || u.email || 'Signed-in user', email: u.email || '', provider: pid === 'microsoft.com' ? 'microsoft' : pid === 'google.com' ? 'google' : pid, linked: (u.providerData || []).map((x) => x.providerId) } : null;
            if (!u) clearToken();
            if (first) { first = false; resolve(); } else C.emit();
          });
        });
      } catch (e) {
        console.error(e);
        cfg.auth = 'none'; cfg.authError = 'Sign-in could not load. Check your connection, then reload the page.';
      }
    } else if (cfg.auth === 'dev') {
      try { C.user = JSON.parse(localStorage.getItem(DEV_KEY) || 'null'); } catch (_) { C.user = null; }
    }
    if (cfg.auth === 'local' || (cfg.auth === 'dev' && !C.user)) {
      const s = lsRead(SESSION_KEY);
      if (s && s.token && s.user) { C.user = s.user; C.session = s.token; }
    }
    C.ready = true;
    return C.user;
  };

  C.providerName = (p) => (p === 'microsoft' ? 'Microsoft' : 'Google');
  C.mailName = (p) => (p === 'microsoft' ? 'Outlook' : 'Gmail');
  C.calName = (p) => (p === 'microsoft' ? 'Outlook Calendar' : 'Google Calendar');
  C.videoName = (p) => (p === 'microsoft' ? 'Microsoft Teams' : 'Google Meet');
  C.canSignIn = () => Boolean(C.config && (C.config.auth === 'local' || ((C.config.auth === 'firebase' || C.config.auth === 'dev') && C.config.providers.length > 0)));
  // Sending from Gmail or Outlook needs Google or Microsoft sign-in (Identity Platform).
  C.canConnect = () => Boolean(C.config && (C.config.auth === 'firebase' || C.config.auth === 'dev') && !C.session);
  C.local = () => Boolean(C.session);

  // ---------- built-in accounts ----------
  async function authPost(path, body) {
    let res;
    try { res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(C.session ? { Authorization: 'Bearer ' + C.session } : {}) }, body: JSON.stringify(body || {}) }); }
    catch (_) { throw new CloudError('offline', 'The Headcount server could not be reached. Check your connection.', 0); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new CloudError('auth', json.error || `Request failed (${res.status}).`, res.status);
    return json;
  }
  function startSession(r) { C.session = r.token; C.user = r.user; lsWrite(SESSION_KEY, { token: r.token, user: r.user }); C.emit(); return r; }
  C.signInLocal = async (email, password) => startSession(await authPost('/api/auth/login', { email, password }));
  C.signUpLocal = async (fields) => startSession(await authPost('/api/auth/signup', fields));
  C.resetRequest = (email) => authPost('/api/auth/reset-request', { email });
  C.resetPassword = async (token, password) => startSession(await authPost('/api/auth/reset', { token, password }));
  C.changePassword = (current, next) => authPost('/api/auth/password', { current, next });
  C.signOutEverywhere = async () => { try { await authPost('/api/auth/logout', { everywhere: true }); } catch (_) { /* already ended */ } C.session = null; C.user = null; lsWrite(SESSION_KEY, null); C.emit(); };

  function providerFor(name, withScopes, hint) {
    if (name === 'microsoft') {
      const p = new fb.OAuthProvider('microsoft.com');
      if (withScopes) MS_SCOPES.forEach((s) => p.addScope(s));
      p.setCustomParameters(hint ? { login_hint: hint } : { prompt: 'select_account' });
      return p;
    }
    const p = new fb.GoogleAuthProvider();
    if (withScopes) GOOGLE_SCOPES.forEach((s) => p.addScope(s));
    p.setCustomParameters(hint ? { login_hint: hint } : { prompt: 'select_account' });
    return p;
  }
  function authMessage(e) {
    const code = (e && e.code) || '';
    if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled.';
    if (code === 'auth/account-exists-with-different-credential') return 'That email already uses the other sign-in option. Sign in with that one instead.';
    if (code === 'auth/user-mismatch') return 'Choose the same account you signed in with.';
    if (code === 'auth/unauthorized-domain') return 'This web address is not authorised for sign-in yet. The site administrator needs to add it in Identity Platform.';
    if (code === 'auth/operation-not-allowed') return 'That sign-in option is not turned on for this site.';
    return 'Sign-in did not complete. Try again.';
  }

  // Must be called directly from a click, so the browser allows the pop-up.
  C.signIn = async function (name, devProfile) {
    if (C.config.auth === 'dev') {
      const d = devProfile || {};
      const id = String(d.id || d.email || 'tester').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'tester';
      C.user = { id, name: d.name || id, email: d.email || `${id}@example.org`, provider: name === 'microsoft' ? 'microsoft' : 'google' };
      localStorage.setItem(DEV_KEY, JSON.stringify(C.user));
      C.emit(); return C.user;
    }
    try { await fb.signInWithPopup(auth, providerFor(name, false)); }
    catch (e) { throw new CloudError('signin', authMessage(e)); }
    C.emit(); return C.user;
  };
  // Single sign-on through a firm's identity provider (SAML or OIDC in Identity Platform).
  C.signInSSO = async function (providerId, email) {
    if (C.config.auth === 'dev') {
      const id = String(email || 'sso-user').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'ssouser';
      C.user = { id, name: String(email || id).split('@')[0], email: String(email || '').toLowerCase(), provider: providerId };
      localStorage.setItem(DEV_KEY, JSON.stringify(C.user)); C.emit(); return C.user;
    }
    const p = providerId.startsWith('saml.') ? new fb.SAMLAuthProvider(providerId) : new fb.OAuthProvider(providerId);
    try { await fb.signInWithPopup(auth, p); } catch (e) { throw new CloudError('signin', authMessage(e)); }
    C.emit(); return C.user;
  };
  C.isSSO = () => Boolean(C.user && /^(saml|oidc)\./.test(C.user.provider || ''));
  C.signOut = async function () {
    clearToken();
    if (C.session) { try { await authPost('/api/auth/logout', {}); } catch (_) { /* already ended */ } C.session = null; C.user = null; lsWrite(SESSION_KEY, null); C.emit(); return; }
    if (C.config.auth === 'dev') { localStorage.removeItem(DEV_KEY); C.user = null; C.emit(); return; }
    if (auth) await fb.signOut(auth);
  };

  // ---------- server API ----------
  async function idToken() {
    if (!C.user) throw new CloudError('signin', 'Sign in to do that.', 401);
    if (C.session) return C.session;
    if (C.config.auth === 'dev') {
      const b = new TextEncoder().encode(JSON.stringify({ id: C.user.id, name: C.user.name, email: C.user.email, provider: C.user.provider }));
      return 'dev.' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return auth.currentUser.getIdToken();
  }
  C.api = async function (method, path, body) {
    const headers = { Authorization: 'Bearer ' + (await idToken()) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (_) { throw new CloudError('offline', 'The Headcount server could not be reached. Check your connection.', 0); }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && C.session) { C.session = null; C.user = null; lsWrite(SESSION_KEY, null); setTimeout(() => C.emit(), 0); }
    if (!res.ok) { const err = new CloudError(res.status === 401 ? 'signin' : 'api', json.error || `Request failed (${res.status}).`, res.status); err.upgrade = Boolean(json.upgrade); err.sso = Boolean(json.sso); err.workspace = json.workspace; throw err; }
    return json;
  };
  C.publicGet = async function (path) {
    const res = await fetch(path); const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new CloudError('api', json.error || `Request failed (${res.status}).`, res.status);
    return json;
  };

  // ---------- calendar and email access ----------
  function readToken() {
    try { const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); return t && C.user && t.user === C.user.id && t.exp > Date.now() ? t : null; } catch (_) { return null; }
  }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* nothing stored */ } }
  C.connected = () => Boolean(readToken());
  // Which mail and calendar account to use: the connected one, else the sign-in account if it is Google or Microsoft.
  C.provider = () => { const t = readToken(); if (t) return t.provider; return C.user && (C.user.provider === 'google' || C.user.provider === 'microsoft') ? C.user.provider : null; };

  // Asks the person to allow calendar and email access. Call it straight from a
  // click handler, before any await, or the browser may block the pop-up.
  // People who sign in with single sign-on choose Gmail or Outlook; the account is linked the first time.
  C.connect = async function (want) {
    if (!C.user) throw new CloudError('signin', 'Sign in first.');
    const have = readToken(); if (have && (!want || have.provider === want)) return have;
    const mp = want || C.provider();
    if (mp !== 'google' && mp !== 'microsoft') throw new CloudError('connect', 'Choose Gmail or Outlook to send from.');
    let access;
    if (C.config.auth === 'dev') access = 'dev-access-token';
    else {
      const own = mp === C.user.provider, cred = (r) => (mp === 'microsoft' ? fb.OAuthProvider.credentialFromResult(r) : fb.GoogleAuthProvider.credentialFromResult(r));
      const reauth = () => fb.reauthenticateWithPopup(auth.currentUser, providerFor(mp, true, own ? C.user.email : ''));
      try {
        let r;
        if (own) r = await reauth();
        else {
          try { r = await fb.linkWithPopup(auth.currentUser, providerFor(mp, true)); }
          catch (e) { if (e && e.code === 'auth/provider-already-linked') r = await reauth(); else throw e; }
        }
        const c = cred(r); access = c && c.accessToken;
      } catch (e) {
        if (e && e.code === 'auth/credential-already-in-use') throw new CloudError('connect', `That ${C.providerName(mp)} account already signs in to Headcount on its own. Choose a different account, or sign in with it instead.`);
        throw new CloudError('connect', authMessage(e));
      }
      if (!access) throw new CloudError('connect', `${C.providerName(mp)} did not grant access to your calendar and email.`);
    }
    const t = { user: C.user.id, provider: mp, access, exp: Date.now() + 50 * 60 * 1000 };
    try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch (_) { /* this tab only */ }
    return t;
  };

  async function call(method, url, body, extraHeaders) {
    const t = readToken();
    if (!t) throw new CloudError('connect', 'Connect your calendar and email first.');
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + t.access, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (_) { throw new CloudError('offline', `${C.providerName(t.provider)} could not be reached. Check your connection.`); }
    if (res.status === 401) { clearToken(); throw new CloudError('connect', 'Your calendar and email connection expired. Connect again to continue.'); }
    if (res.status === 403) throw new CloudError('scope', `${C.providerName(t.provider)} refused: allow calendar and email access when you connect.`, 403);
    if (res.status === 404 || res.status === 410) throw new CloudError('missing', 'That item was not found.', res.status);
    if (res.status === 429) throw new CloudError('busy', `${C.providerName(t.provider)} is busy. Try again in a minute.`, 429);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = (j.error && (j.error.message || j.error)) || '';
      throw new CloudError('failed', `${C.providerName(t.provider)} returned an error${msg ? `: ${String(msg).slice(0, 160)}` : ` (${res.status})`}.`, res.status);
    }
    if (res.status === 202 || res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // RFC 2822 message for Gmail. Headers are stripped of line breaks.
  const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const b64 = (str) => { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
  const encWord = (s) => (/[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${b64(s)}?=` : s);
  C.mime = function ({ to, cc, subject, body }) {
    const lines = [`To: ${to.map(oneLine).join(', ')}`];
    if (cc && cc.length) lines.push(`Cc: ${cc.map(oneLine).join(', ')}`);
    lines.push(`Subject: ${encWord(oneLine(subject))}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
    const msg = lines.join('\r\n') + '\r\n' + (b64(String(body).replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g) || []).join('\r\n');
    return b64(msg).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const G = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const MS = 'https://graph.microsoft.com/v1.0/me';
  const UTC = { Prefer: 'outlook.timezone="UTC"' };
  const msDate = (s) => (s ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z') : null);
  const msTime = (d) => d.toISOString().slice(0, 19);
  const RSVP = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', tentativelyAccepted: 'tentative', needsAction: 'waiting', none: 'waiting', notResponded: 'waiting', organizer: 'organizer' };

  C.mail = {
    async send({ to, cc, subject, body }) {
      if (C.provider() === 'microsoft') {
        await call('POST', `${MS}/sendMail`, { message: { subject: oneLine(subject), body: { contentType: 'Text', content: body }, toRecipients: to.map((a) => ({ emailAddress: { address: oneLine(a) } })), ccRecipients: (cc || []).map((a) => ({ emailAddress: { address: oneLine(a) } })) }, saveToSentItems: true });
      } else {
        await call('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw: C.mime({ to, cc, subject, body }) });
      }
    },
  };

  C.calendar = {
    // Busy periods between two dates, as [{start: Date, end: Date}].
    async busy(from, to) {
      if (C.provider() === 'microsoft') {
        const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $select: 'start,end,showAs,isCancelled', $top: '250' });
        const r = await call('GET', `${MS}/calendarView?${q}`, null, UTC);
        return (r.value || []).filter((e) => !e.isCancelled && e.showAs !== 'free' && e.showAs !== 'workingElsewhere').map((e) => ({ start: msDate(e.start.dateTime), end: msDate(e.end.dateTime) }));
      }
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', fields: 'items(start,end,transparency,status,attendees(self,responseStatus))' });
      const r = await call('GET', `${G}?${q}`);
      return (r.items || []).filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent' && !(e.attendees || []).some((a) => a.self && a.responseStatus === 'declined'))
        .map((e) => ({ start: new Date(e.start.dateTime || e.start.date + 'T00:00:00'), end: new Date(e.end.dateTime || e.end.date + 'T00:00:00') }));
    },
    // Creates the event and sends invitations to the attendees from the person's own account.
    async create({ title, description, start, end, location, attendees, video }) {
      if (C.provider() === 'microsoft') {
        const body = { subject: title, body: { contentType: 'text', content: description }, start: { dateTime: msTime(start), timeZone: 'UTC' }, end: { dateTime: msTime(end), timeZone: 'UTC' }, attendees: attendees.map((a) => ({ emailAddress: { address: a }, type: 'required' })), allowNewTimeProposals: true };
        if (location) body.location = { displayName: location };
        let ev;
        try { ev = await call('POST', `${MS}/events`, video ? { ...body, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : body); }
        catch (e) { if (video && e.status === 400) ev = await call('POST', `${MS}/events`, body); else throw e; } // personal accounts cannot add Teams links
        return { id: ev.id, link: ev.webLink || '', video: (ev.onlineMeeting && ev.onlineMeeting.joinUrl) || '' };
      }
      const body = { summary: title, description, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, attendees: attendees.map((a) => ({ email: a })), reminders: { useDefault: true } };
      if (location) body.location = location;
      if (video) body.conferenceData = { createRequest: { requestId: 'hc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      const ev = await call('POST', `${G}?sendUpdates=all&conferenceDataVersion=1`, body);
      return { id: ev.id, link: ev.htmlLink || '', video: ev.hangoutLink || '' };
    },
    async get(id) {
      if (C.provider() === 'microsoft') {
        try {
          const e = await call('GET', `${MS}/events/${encodeURIComponent(id)}?$select=start,end,isCancelled,location,webLink,attendees`, null, UTC);
          return { cancelled: Boolean(e.isCancelled), start: msDate(e.start.dateTime), end: msDate(e.end.dateTime), location: (e.location && e.location.displayName) || '', link: e.webLink || '',
            replies: Object.fromEntries((e.attendees || []).map((a) => [String(a.emailAddress.address).toLowerCase(), RSVP[a.status && a.status.response] || 'waiting'])) };
        } catch (err) { if (err.code === 'missing') return { cancelled: true }; throw err; }
      }
      try {
        const e = await call('GET', `${G}/${encodeURIComponent(id)}?fields=status,start,end,location,htmlLink,attendees(email,responseStatus)`);
        return { cancelled: e.status === 'cancelled', start: new Date(e.start.dateTime || e.start.date), end: new Date(e.end.dateTime || e.end.date), location: e.location || '', link: e.htmlLink || '',
          replies: Object.fromEntries((e.attendees || []).map((a) => [String(a.email).toLowerCase(), RSVP[a.responseStatus] || 'waiting'])) };
      } catch (err) { if (err.code === 'missing') return { cancelled: true }; throw err; }
    },
    // Cancels the event; attendees receive a cancellation notice.
    async cancel(id) {
      try {
        if (C.provider() === 'microsoft') await call('POST', `${MS}/events/${encodeURIComponent(id)}/cancel`, { comment: 'This meeting has been cancelled.' });
        else await call('DELETE', `${G}/${encodeURIComponent(id)}?sendUpdates=all`);
      } catch (err) { if (err.code !== 'missing') throw err; }
    },
  };

  // Up to `count` open slots on different working days, starting tomorrow.
  C.freeSlots = function (busy, { mins = 30, count = 3, days = 10, startHour = 9, endHour = 17, from = new Date() } = {}) {
    const out = [], step = 30;
    const day = new Date(from); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + 1);
    for (let i = 0; i < days && out.length < count; i++, day.setDate(day.getDate() + 1)) {
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      // Alternate morning and afternoon so the offers are not all at the same hour.
      const prefer = out.length % 2 ? 14 : 10;
      const cands = [];
      for (let m = startHour * 60; m + mins <= endHour * 60; m += step) cands.push(m);
      cands.sort((a, b) => Math.abs(a - prefer * 60) - Math.abs(b - prefer * 60));
      for (const m of cands) {
        const s = new Date(day); s.setMinutes(m); const e = new Date(s.getTime() + mins * 60000);
        if (!busy.some((b) => b.start < e && b.end > s)) { out.push(s); break; }
      }
    }
    return out;
  };

  // An .ics invitation for people who are not signed in.
  C.ics = function ({ uid, title, description, start, end, location, attendees, organizer }) {
    const t = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const fold = (line) => { const parts = []; let rest = line; while (rest.length > 74) { parts.push(rest.slice(0, 74)); rest = ' ' + rest.slice(74); } parts.push(rest); return parts.join('\r\n'); };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Headcount//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${uid}@headcount`, `DTSTAMP:${t(new Date())}`, `DTSTART:${t(start)}`, `DTEND:${t(end)}`, `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(description)}`];
    if (location) lines.push(`LOCATION:${esc(location)}`);
    if (organizer) lines.push(`ORGANIZER:mailto:${oneLine(organizer)}`);
    (attendees || []).forEach((a) => lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${oneLine(a)}`));
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  };

  window.CLOUD = C;
})();
