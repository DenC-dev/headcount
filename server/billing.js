import crypto from 'node:crypto';
import { HttpError } from './db.js';

// Stripe subscriptions, one per workspace, priced per seat. Uses Stripe's REST
// API directly: Checkout to subscribe, the customer portal to manage cards,
// invoices and cancellation, and webhooks to keep the plan in step.

export function form(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function stripe(cfg, method, path, params) {
  let res;
  try {
    res = await fetch(`${cfg.stripeBase}${path}`, {
      method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${cfg.stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params ? form(params).toString() : undefined,
    });
  } catch (_) { throw new HttpError(502, 'The payment service could not be reached. Try again shortly.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe error', res.status, json.error && json.error.message);
    throw new HttpError(502, 'The payment service returned an error. Try again, or contact support.');
  }
  return json;
}

// Prices made by Headcount's Stripe setup say which plan they are for, so a
// subscriber stays on the right plan after the operator changes prices.
export const planForPrice = (cfg, price) => {
  const tag = price && price.metadata && price.metadata.headcount_plan;
  if (tag === 'firm' || tag === 'team') return tag;
  return price && price.id && price.id === cfg.stripePriceFirm ? 'firm' : 'team';
};

export function makeBilling(cfg, store) {

  async function customerFor(org, user) {
    if (org.stripe_customer) return org.stripe_customer;
    const c = await stripe(cfg, 'POST', '/v1/customers', { name: org.name, email: user.email || undefined, metadata: { org_id: org.id } });
    store.setCustomer(org.id, c.id);
    return c.id;
  }

  async function checkout(oid, user, { seats, plan }) {
    const org = store.billingOrg(oid, user.id);
    if (org.stripe_subscription && ['active', 'trialing', 'past_due'].includes(org.status)) throw new HttpError(409, 'This workspace already has a subscription. Change seats or open billing instead.');
    const price = plan === 'firm' && cfg.stripePriceFirm ? cfg.stripePriceFirm : cfg.stripePriceTeam;
    const n = Math.max(1, Math.min(1000, Math.floor(Number(seats) || 0)));
    const used = store.orgInfo(oid, user.id).usage.seats;
    if (n < used) throw new HttpError(400, `This workspace has ${used} people using seats, so buy at least ${used}.`);
    const customer = await customerFor(org, user);
    const s = await stripe(cfg, 'POST', '/v1/checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: oid,
      line_items: { 0: { price, quantity: n } },
      subscription_data: { metadata: { org_id: oid } },
      allow_promotion_codes: 'true',
      success_url: `${cfg.publicUrl}/app?billing=done`, cancel_url: `${cfg.publicUrl}/app?billing=cancelled`,
    });
    store.log(oid, user.id, 'billing.checkout_started', null, { seats: n });
    return { url: s.url };
  }

  async function portal(oid, user) {
    const org = store.billingOrg(oid, user.id);
    if (!org.stripe_customer) throw new HttpError(400, 'This workspace has no billing account yet. Choose a plan first.');
    const s = await stripe(cfg, 'POST', '/v1/billing_portal/sessions', { customer: org.stripe_customer, return_url: `${cfg.publicUrl}/app?billing=back`, configuration: cfg.stripePortalConfig || undefined });
    return { url: s.url };
  }

  async function setSeats(oid, user, seats) {
    const org = store.billingOrg(oid, user.id);
    if (!org.stripe_subscription || !org.stripe_item) throw new HttpError(400, 'Choose a plan first.');
    const n = Math.max(1, Math.min(1000, Math.floor(Number(seats) || 0)));
    const used = store.orgInfo(oid, user.id).usage.seats;
    if (n < used) throw new HttpError(400, `${used} people are using seats. Remove people before going below ${used}.`);
    const sub = await stripe(cfg, 'POST', `/v1/subscriptions/${encodeURIComponent(org.stripe_subscription)}`, { items: { 0: { id: org.stripe_item, quantity: n } }, proration_behavior: 'create_prorations' });
    sync(sub, org);
    store.log(oid, user.id, 'billing.seats_changed', null, { seats: n });
    return { seats: n };
  }

  function sync(sub, known) {
    const org = known || store.orgForStripe(sub.metadata && sub.metadata.org_id, sub.customer);
    if (!org) return;
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return store.endSubscription(org);
    const item = sub.items && sub.items.data && sub.items.data[0];
    store.applySubscription(org, {
      plan: planForPrice(cfg, item && item.price), status: sub.status, seats: (item && item.quantity) || 1,
      periodEnd: ((sub.current_period_end || (item && item.current_period_end)) || 0) * 1000 || null,
      customer: sub.customer, subscription: sub.id, item: item && item.id,
    });
  }

  // Stripe signs each webhook: "t=<time>,v1=<hmac>". Reject anything unsigned,
  // forged or older than five minutes.
  function verify(raw, header) {
    const parts = Object.create(null);
    for (const kv of String(header || '').split(',')) { const [k, v] = kv.split('='); if (k && v) (parts[k.trim()] ||= []).push(v.trim()); }
    const t = Number((parts.t || [])[0]);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
    const want = crypto.createHmac('sha256', cfg.stripeWebhookSecret).update(`${t}.${raw}`).digest();
    return (parts.v1 || []).some((sig) => { const got = Buffer.from(sig, 'hex'); return got.length === want.length && crypto.timingSafeEqual(got, want); });
  }

  async function webhook(raw, signature) {
    if (!verify(raw, signature)) throw new HttpError(400, 'Invalid signature.');
    const event = JSON.parse(raw);
    if (!store.firstSeen(event.id)) return { duplicate: true };
    const obj = event.data && event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const org = store.orgForStripe(obj.client_reference_id, obj.customer);
        if (org && obj.subscription) {
          if (!org.stripe_customer) store.setCustomer(org.id, obj.customer);
          try { sync(await stripe(cfg, 'GET', `/v1/subscriptions/${encodeURIComponent(obj.subscription)}`), store.orgForStripe(org.id)); }
          catch (e) { console.error('Could not fetch subscription after checkout', e.message); }
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        sync(obj); break;
      case 'invoice.payment_failed': {
        const org = store.orgForStripe(null, obj.customer);
        if (org) { store.log(org.id, null, 'billing.payment_failed'); store.notify({ type: 'billing.payment_failed', org }); }
        break;
      }
      default: break;
    }
    return { received: true };
  }

  async function cancel(subscriptionId) {
    try { await stripe(cfg, 'DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`); } catch (e) { console.error('Could not cancel subscription', subscriptionId, e.message); }
  }

  return { checkout, portal, setSeats, webhook, cancel, verify };
}
