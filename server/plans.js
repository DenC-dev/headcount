// What each plan allows. Prices live in Stripe; these are the limits the
// server enforces. Edit them to suit your pricing.
const INF = Number.POSITIVE_INFINITY;

export const PLANS = {
  free: {
    label: 'Free', seats: 2, campaigns: 3, watches: 2, guestsPerSeat: 0, guests: 3, draftsPerSeat: 0, drafts: 5,
    features: { activityReport: false, audit: false, domain: false, sso: false, actionCenter: false },
  },
  team: {
    label: 'Team', seats: null, campaigns: INF, watches: 25, guestsPerSeat: 5, guests: null, draftsPerSeat: 40, drafts: null,
    features: { activityReport: true, audit: true, domain: true, sso: false, actionCenter: true },
  },
  firm: {
    label: 'Firm', seats: null, campaigns: INF, watches: INF, guestsPerSeat: null, guests: INF, draftsPerSeat: 100, drafts: null,
    features: { activityReport: true, audit: true, domain: true, sso: true, actionCenter: true },
  },
  unlimited: {
    label: 'Unlimited', seats: INF, campaigns: INF, watches: INF, guests: INF, drafts: INF,
    features: { activityReport: true, audit: true, domain: true, sso: true, actionCenter: true },
  },
};

// The plan an organization is on right now, with its limits worked out.
export function effectivePlan(org, cfg, now = Date.now()) {
  if (!cfg.billing) return finish('unlimited', PLANS.unlimited, INF, org);
  const paid = org.stripe_subscription && ['active', 'trialing', 'past_due'].includes(org.status) && PLANS[org.plan];
  if (paid) return finish(org.plan, PLANS[org.plan], Math.max(1, org.seats || 1), org);
  if (org.trial_ends && org.trial_ends > now) return { ...finish('team', PLANS.team, cfg.trialSeats, org), key: 'trial', label: 'Team trial' };
  return finish('free', PLANS.free, PLANS.free.seats, org);
}

function finish(key, p, seats, org) {
  const n = seats === INF ? INF : seats;
  return {
    key, label: p.label, seats: n, campaigns: p.campaigns, watches: p.watches,
    guests: p.guests !== null && p.guests !== undefined ? p.guests : n * p.guestsPerSeat,
    drafts: p.drafts !== null && p.drafts !== undefined ? p.drafts : n * p.draftsPerSeat,
    features: p.features, status: org.status || 'free', trialEnds: org.trial_ends || null, periodEnd: org.period_end || null,
  };
}

// Infinity does not survive JSON; send null for "no limit".
export const forJson = (plan) => JSON.parse(JSON.stringify(plan, (k, v) => (v === INF ? null : v)));
