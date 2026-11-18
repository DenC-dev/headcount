import { HttpError } from './db.js';
import { form, STRIPE_VERSION } from './billing.js';

// Connects a Stripe account from one secret key, so the person running
// Headcount never has to create products, prices or webhooks by hand. It is
// safe to run again: it reuses what it made before, so running it to change a
// price adds a new price and leaves existing subscribers where they are.

export const HOOK_EVENTS = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
  'charge.refunded', 'charge.dispute.created', 'radar.early_fraud_warning.created',
];
// What a restricted key needs, by the part of Stripe each call touches.
const NEEDS = [['/v1/products', 'Products: Write'], ['/v1/prices', 'Prices: Write'], ['/v1/webhook_endpoints', 'Webhook Endpoints: Write'], ['/v1/billing_portal', 'Customer portal: Write'], ['/v1/tax/registrations', 'Tax Registrations: Read']];
export const KEY_PERMISSIONS = ['Products: Write', 'Prices: Write', 'Customers: Write', 'Checkout Sessions: Write', 'Subscriptions: Write', 'Customer portal: Write', 'Webhook Endpoints: Write', 'Charges: Read', 'Tax Registrations: Read (only to charge sales tax)'];
const PLAN_NAMES = { team: 'Headcount Team', firm: 'Headcount Firm' };
// Stripe's tax category for business software sold as a service. Checkout
// needs it when Stripe Tax or Managed Payments is on.
export const TAX_CODE = 'txcd_10103001';

export const priceLabel = (dollars) => `$${Number(dollars).toLocaleString('en-US', { maximumFractionDigits: 2 })} per person a month`;
export function readDollars(v, what, optional) {
  const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (!s) { if (optional) return null; throw new HttpError(400, `Enter a price for ${what}.`); }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n > 10000) throw new HttpError(400, `The ${what} price should be a number of dollars, between 1 and 10,000.`);
  return Math.round(n * 100) / 100;
}

export async function setupStripe({ base, key, publicUrl, team, firm, tax = false, fetchImpl = fetch }) {
  const k = String(key || '').trim();
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(k)) throw new HttpError(400, 'That does not look like a Stripe key. A restricted key starts with rk_test_ or rk_live_, and a secret key with sk_test_ or sk_live_.');
  const url = String(publicUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(url) || /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url)) throw new HttpError(400, 'Stripe needs to reach Headcount at its public web address (starting with https://). Set the web address first, under Web address.');

  async function call(method, path, params) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': STRIPE_VERSION }, body: params ? form(params).toString() : undefined });
    } catch (_) { throw new HttpError(502, 'Stripe could not be reached. Try again in a minute.'); }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw new HttpError(400, 'Stripe did not accept that key. In Stripe, open Developers, then API keys, and copy the Secret key again.');
    if (res.status === 403) {
      if (path === '/v1/account') return null; // restricted keys usually cannot read the account; that is fine
      const need = (NEEDS.find(([p]) => path.startsWith(p)) || [])[1];
      throw new HttpError(400, need ? `Your restricted key needs "${need}" turned on. In Stripe, open Developers, then API keys, edit the key, and allow it.` : 'That key is not allowed to do this. Use a restricted key with the permissions listed here, or your secret key.');
    }
    if (!res.ok) { console.error('Stripe setup error', method, path, res.status, json.error && json.error.message); throw new HttpError(502, `Stripe said: ${(json.error && json.error.message) || 'something went wrong'}. Try again, or check your Stripe account.`); }
    return json;
  }
  const list = async (path) => (await call('GET', path)).data || [];

  // 1. Whose account is this?
  const acct = (await call('GET', '/v1/account')) || {};
  const live = /_live_/.test(k);

  // Sales tax: Stripe calculates nothing until it knows where you are
  // registered, so refuse to turn it on before that.
  if (tax) {
    const regs = await list('/v1/tax/registrations?status=active&limit=1');
    if (!regs.length) throw new HttpError(400, 'Stripe Tax does not know where you collect sales tax yet. In Stripe, open Tax, then Registrations, add each state (or country) where you are registered, then turn this on again.');
  }
  const account = (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || (acct.business_profile && acct.business_profile.name) || acct.email || 'your Stripe account';

  // 2. A product and a monthly per-person price for each plan.
  const products = await list('/v1/products?limit=100&active=true');
  const prices = {};
  for (const [plan, dollars] of [['team', team], ['firm', firm]]) {
    if (dollars == null) continue;
    let prod = products.find((p) => p.metadata && p.metadata.headcount_plan === plan);
    if (!prod) prod = await call('POST', '/v1/products', { name: PLAN_NAMES[plan], description: plan === 'team' ? 'Headcount for a government affairs team, per person' : 'Headcount with single sign-on, per person', tax_code: TAX_CODE, metadata: { headcount_plan: plan } });
    else if (!prod.tax_code) prod = await call('POST', `/v1/products/${encodeURIComponent(prod.id)}`, { tax_code: TAX_CODE });
    const cents = Math.round(dollars * 100);
    const existing = (await list(`/v1/prices?product=${encodeURIComponent(prod.id)}&active=true&limit=100`))
      .find((p) => p.unit_amount === cents && p.currency === 'usd' && p.recurring && p.recurring.interval === 'month' && (p.recurring.usage_type || 'licensed') === 'licensed');
    const price = existing || await call('POST', '/v1/prices', { product: prod.id, unit_amount: cents, currency: 'usd', recurring: { interval: 'month' }, tax_behavior: 'exclusive', nickname: `${plan === 'team' ? 'Team' : 'Firm'}, per person per month`, metadata: { headcount_plan: plan } });
    // Sales tax is added on top of the price; older prices may not say so yet.
    if (tax && existing && (existing.tax_behavior || 'unspecified') === 'unspecified') await call('POST', `/v1/prices/${encodeURIComponent(existing.id)}`, { tax_behavior: 'exclusive' });
    prices[plan] = { id: price.id, dollars };
  }

  // 3. Stripe tells Headcount when someone pays, changes or cancels. Stripe
  // only reveals a webhook's signing secret when it is made, so replace ours.
  const hookUrl = `${url}/api/stripe/webhook`;
  for (const h of await list('/v1/webhook_endpoints?limit=100')) if (h.url === hookUrl) await call('DELETE', `/v1/webhook_endpoints/${encodeURIComponent(h.id)}`);
  const hook = await call('POST', '/v1/webhook_endpoints', { url: hookUrl, api_version: STRIPE_VERSION, enabled_events: Object.fromEntries(HOOK_EVENTS.map((e, i) => [i, e])), description: 'Headcount: keeps plans in step with payments', metadata: { headcount: '1' } });
  if (!hook.secret) throw new HttpError(502, 'Stripe did not return the webhook signing secret. Try again.');

  // 4. The page where customers update their card, see invoices and cancel.
  let portal = (await list('/v1/billing_portal/configurations?active=true&limit=100')).find((c) => c.metadata && c.metadata.headcount === '1');
  if (!portal) {
    portal = await call('POST', '/v1/billing_portal/configurations', {
      business_profile: { headline: 'Manage your Headcount plan', privacy_policy_url: `${url}/privacy`, terms_of_service_url: `${url}/terms` },
      features: {
        invoice_history: { enabled: 'true' }, payment_method_update: { enabled: 'true' },
        customer_update: { enabled: 'true', allowed_updates: { 0: 'email', 1: 'address', 2: 'name', 3: 'tax_id' } },
        subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
      },
      default_return_url: `${url}/app`, metadata: { headcount: '1' },
    });
  }

  return {
    account, live, detailsSubmitted: acct.details_submitted !== false, chargesEnabled: acct.charges_enabled !== false,
    settings: {
      stripeKey: k, stripeWebhookSecret: hook.secret, stripeWebhookId: hook.id, stripePortalConfig: portal.id,
      stripePriceTeam: prices.team ? prices.team.id : '', stripePriceFirm: prices.firm ? prices.firm.id : '',
      priceLabelTeam: prices.team ? priceLabel(prices.team.dollars) : '', priceLabelFirm: prices.firm ? priceLabel(prices.firm.dollars) : '',
      stripeAccount: `${account}${live ? '' : ' (test mode)'}`, stripeTax: tax ? 'on' : '',
    },
  };
}

// Takes the webhook away when payments are turned off; best effort.
export async function removeStripeHook({ base, key, id, fetchImpl = fetch }) {
  if (!key || !id) return;
  try { await fetchImpl(`${base}/v1/webhook_endpoints/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }); } catch (_) { /* Stripe stops retrying an endpoint that is gone */ }
}
