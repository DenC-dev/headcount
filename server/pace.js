// Free data keys allow only so many requests a minute (Open States' free key
// is the tight one). Every outgoing call to a paced service waits for a slot
// instead of firing in a burst and getting refused; after a refusal (429) the
// service is left alone for a minute. Waiting callers queue in order.

const LIMITS = { 'openstates.org': Number(process.env.OPENSTATES_PER_MINUTE) || 9 };
const state = new Map(); // host -> { sent: [times], until: cooldown end, queue: Promise }
const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };
const limitFor = (host) => { for (const [h, n] of Object.entries(LIMITS)) if (host === h || host.endsWith(`.${h}`)) return [h, n]; return null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT = 25000;

export async function pacedFetch(url, opts = {}) {
  const lim = limitFor(hostOf(url));
  if (!lim) return fetch(url, opts);
  const [key, perMinute] = lim;
  if (!state.has(key)) state.set(key, { sent: [], until: 0, queue: Promise.resolve() });
  const s = state.get(key), started = Date.now();
  // One waiter at a time takes the next free slot
  const turn = s.queue.then(async () => {
    for (;;) {
      const now = Date.now();
      s.sent = s.sent.filter((t) => now - t < 60e3);
      const wait = Math.max(s.until - now, s.sent.length >= perMinute ? 60e3 - (now - s.sent[0]) + 50 : 0);
      if (wait <= 0) { s.sent.push(now); return true; }
      if (now - started + wait > MAX_WAIT) return false;
      await sleep(Math.min(wait, 5000));
    }
  });
  s.queue = turn.catch(() => {});
  if (!(await turn)) return new Response('{"detail":"busy"}', { status: 429, headers: { 'Content-Type': 'application/json' } });
  const res = await fetch(url, opts);
  if (res.status === 429) { const ra = Number(res.headers.get('retry-after')); s.until = Date.now() + (ra > 0 && ra < 600 ? ra * 1000 : 60e3); }
  return res;
}
export const paceState = () => Object.fromEntries([...state].map(([k, v]) => [k, { lastMinute: v.sent.filter((t) => Date.now() - t < 60e3).length, coolingFor: Math.max(0, v.until - Date.now()) }]));
