// All settings come from environment variables (see .env.example).
const env = process.env;
const list = (v, d) => String(v || d).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const firebase = {
  apiKey: env.FIREBASE_API_KEY || '',
  authDomain: env.FIREBASE_AUTH_DOMAIN || '',
  projectId: env.FIREBASE_PROJECT_ID || '',
};

// Built-in email and password accounts unless Google Cloud Identity Platform is configured.
let authMode = (env.AUTH_MODE || (firebase.projectId ? 'firebase' : 'local')).toLowerCase();
if (!['firebase', 'local', 'dev', 'none'].includes(authMode)) throw new Error(`AUTH_MODE must be firebase, local, dev or none, not "${authMode}"`);
if (authMode === 'firebase' && (!firebase.apiKey || !firebase.authDomain || !firebase.projectId)) {
  throw new Error('AUTH_MODE=firebase needs FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN and FIREBASE_PROJECT_ID');
}
if (authMode === 'dev' && env.NODE_ENV === 'production') throw new Error('AUTH_MODE=dev is for local testing and cannot run with NODE_ENV=production');

export const config = {
  port: Number(env.PORT) || 3000,
  // Hosts such as Render announce the address themselves.
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
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
  operatorEmail: String(env.OPERATOR_EMAIL || '').trim().toLowerCase(),
  // Billing turns on when Stripe is configured. Without it every workspace is unlimited,
  // which suits a firm running its own copy.
  stripeKey: env.STRIPE_SECRET_KEY || '',
  // managed (Stripe is the seller of record), stripe_tax, or none; empty leaves it to the Stripe account
  stripeTax: ['managed', 'stripe_tax', 'none'].includes(env.STRIPE_TAX_MODE) ? env.STRIPE_TAX_MODE : '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceTeam: env.STRIPE_PRICE_TEAM || '',
  stripePriceFirm: env.STRIPE_PRICE_FIRM || '',
  stripeBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
  priceLabelTeam: env.PRICE_LABEL_TEAM || '',
  priceLabelFirm: env.PRICE_LABEL_FIRM || '',
  salesEmail: env.SALES_EMAIL || '',
  leadsEmail: env.LEADS_EMAIL || '', // where contact form messages go; never shown on the website
  trialDays: Number(env.TRIAL_DAYS) || 14,
  trialSeats: Number(env.TRIAL_SEATS) || 10,
};
// Email: any SMTP service. EMAIL_MODE=outbox keeps messages in the database
// without sending them (the default for local testing).
config.smtpUrl = env.SMTP_URL || '';
config.emailFrom = env.EMAIL_FROM || '';
config.emailMode = (env.EMAIL_MODE || (config.smtpUrl ? 'smtp' : authMode === 'dev' ? 'outbox' : 'off')).toLowerCase();
config.appSecret = env.APP_SECRET || '';
config.digestEvery = Number(env.DIGEST_INTERVAL_MS) || 10 * 60 * 1000;
if (config.smtpUrl && !config.emailFrom) throw new Error('SMTP_URL needs EMAIL_FROM, for example "Headcount <notifications@yourdomain.com>".');
if ((config.smtpUrl || config.emailMode === 'outbox') && !config.publicUrl) config.publicUrl = `http://localhost:${config.port}`;
config.siteOff = env.SITE === 'off';
config.billing = Boolean(config.stripeKey && config.stripeWebhookSecret && config.stripePriceTeam);
if (config.billing && !config.publicUrl) throw new Error('Billing needs PUBLIC_URL so Stripe can send people back to the app.');
// Public data sources for the Monitor, intelligence and the action center.
// None needs a key except SAM.gov (contract opportunities); Congress.gov and
// Open States keys are set above. The *_BASE settings exist for testing.
config.samKey = env.SAM_API_KEY || '';
config.samBase = (env.SAM_API_BASE || 'https://api.sam.gov').replace(/\/+$/, '');
config.fedRegBase = (env.FEDREG_API_BASE || 'https://www.federalregister.gov/api/v1').replace(/\/+$/, '');
config.ldaKey = env.LDA_API_KEY || '';
config.ldaBase = (env.LDA_API_BASE || 'https://lda.gov/api/v1').replace(/\/+$/, '');
config.usaSpendingBase = (env.USASPENDING_API_BASE || 'https://api.usaspending.gov/api/v2').replace(/\/+$/, '');
config.geocoderBase = (env.GEOCODER_BASE || 'https://geocoding.geo.census.gov/geocoder').replace(/\/+$/, '');
config.monitorEvery = Number(env.MONITOR_INTERVAL_MS) || 6 * 3600 * 1000;
// SAM.gov allows 10 requests a day for accounts without a SAM.gov role, so contract watches check once a day.
config.samEvery = Number(env.SAM_INTERVAL_MS) || 24 * 3600 * 1000;
config.monitorOff = env.MONITOR === 'off';
// Weekly refresh of the Florida lists and official staff (off for tests and local development)
config.officialsOff = env.OFFICIALS_REFRESH === 'off' || env.NODE_ENV === 'test' || config.authMode === 'dev';
