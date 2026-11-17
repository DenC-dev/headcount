// All settings come from environment variables (see .env.example).
const env = process.env;
const list = (v, d) => String(v || d).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const firebase = {
  apiKey: env.FIREBASE_API_KEY || '',
  authDomain: env.FIREBASE_AUTH_DOMAIN || '',
  projectId: env.FIREBASE_PROJECT_ID || '',
};

let authMode = (env.AUTH_MODE || (firebase.projectId ? 'firebase' : 'none')).toLowerCase();
if (!['firebase', 'dev', 'none'].includes(authMode)) throw new Error(`AUTH_MODE must be firebase, dev or none, not "${authMode}"`);
if (authMode === 'firebase' && (!firebase.apiKey || !firebase.authDomain || !firebase.projectId)) {
  throw new Error('AUTH_MODE=firebase needs FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN and FIREBASE_PROJECT_ID');
}
if (authMode === 'dev' && env.NODE_ENV === 'production') throw new Error('AUTH_MODE=dev is for local testing and cannot run with NODE_ENV=production');

export const config = {
  port: Number(env.PORT) || 3000,
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR || './data',
  trustProxy: env.TRUST_PROXY === '1',
  production: env.NODE_ENV === 'production',
  authMode,
  firebase,
  firebaseJwksUrl: env.FIREBASE_JWKS_URL || 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  providers: list(env.SIGNIN_PROVIDERS, 'google,microsoft').filter((p) => p === 'google' || p === 'microsoft'),
  congressKey: env.CONGRESS_API_KEY || '',
  congressBase: (env.CONGRESS_API_BASE || 'https://api.congress.gov/v3').replace(/\/+$/, ''),
  openStatesKey: env.OPENSTATES_API_KEY || '',
  openStatesBase: (env.OPENSTATES_API_BASE || 'https://v3.openstates.org').replace(/\/+$/, ''),
  aiEnabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && env.AI_DRAFTING !== 'off',
  aiDailyLimit: Number(env.AI_DAILY_LIMIT) || 200,
  supportEmail: env.SUPPORT_EMAIL || '',
  // Billing turns on when Stripe is configured. Without it every workspace is unlimited,
  // which suits a firm running its own copy.
  stripeKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceTeam: env.STRIPE_PRICE_TEAM || '',
  stripePriceFirm: env.STRIPE_PRICE_FIRM || '',
  stripeBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
  priceLabelTeam: env.PRICE_LABEL_TEAM || '',
  priceLabelFirm: env.PRICE_LABEL_FIRM || '',
  salesEmail: env.SALES_EMAIL || '',
  trialDays: Number(env.TRIAL_DAYS) || 14,
  trialSeats: Number(env.TRIAL_SEATS) || 10,
};
config.billing = Boolean(config.stripeKey && config.stripeWebhookSecret && config.stripePriceTeam);
if (config.billing && !config.publicUrl) throw new Error('Billing needs PUBLIC_URL so Stripe can send people back to the app.');
