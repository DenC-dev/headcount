# Headcount

Whip counts, meeting requests and bill briefs for lobbying firms, government affairs teams and advocacy groups, sold per seat.

- **Vote count.** Seat-by-seat positions, live odds of passage (or defeat) through committee and the floor, and a ranked list of the members whose minds matter most. Preset rosters for the U.S. House, U.S. Senate, Florida House and Florida Senate, with office contact details.
- **Meeting requests that actually go out.** Ask a member's scheduler for a meeting from your own Gmail or Outlook, offering open times taken from your calendar. When they reply, send a real Google Calendar or Outlook invitation with a Meet or Teams link, check who accepted, and cancel if plans change. Without signing in, the same request opens in your email app and invitations download as an `.ics` file.
- **A brief for every bill.** Look up any federal bill (Congress.gov) or state bill (Open States) to fill in sponsors, status, committees and the official summary. Add your summary, talking points and likely objections by hand, or have Claude draft them from the bill material. Briefs print cleanly and feed every meeting brief and request.
- **Workspaces for firms.** Each firm, team or organization gets a workspace with owners, admins, members and guests. Campaigns are open to the whole workspace or closed to the people added. Clients and coalition partners join as guests and see only their campaigns. Changes from teammates appear within a few seconds.
- **Portfolio.** Every campaign in the workspace on one page: client, odds and their weekly change, the count against the number needed, the next vote, meetings booked and requested, and overdue follow-ups.
- **Clients.** Keep the organizations you represent, assign each campaign to one, and filter the portfolio and reports by client.
- **Lobbying activity report.** Every contact the team logged in a quarter, grouped by client and issue, with chambers contacted and who made the contact, plus a CSV of every contact. A worksheet to help prepare disclosure reports such as the LD-2.
- **Administration.** An activity log of who did what, invitations by email or link, joining by verified email domain, full data export, and account and workspace deletion.
- **Plans and billing.** A trial, a free tier and paid per-seat plans through Stripe Checkout and the Stripe customer portal. Self-hosted copies without Stripe run with no limits.

Anyone can use it without an account; campaigns are then saved in that browser only.

## Run it locally

Needs Node.js 22.13 or later.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. `npm run dev` uses a local test sign-in that accepts any name and email, so you can try teams and invitations without setting anything up. It refuses to start when `NODE_ENV=production`.

## Tests

```bash
npm test
```

Runs the server tests: sign-in token checks, permissions, invitations, account deletion, bill lookup and brief drafting, against local stand-ins for Google, Congress.gov, Open States and the Claude API.

```bash
npm run e2e
```

Drives the whole app in Chromium with three people (Google, Microsoft and a view-only teammate) and stand-ins for Gmail, Google Calendar, Outlook and Microsoft Graph. Needs Playwright with Chromium installed.

## Set it up for real users

Copy `.env.example` to `.env` and fill it in as you go. `npm start` reads it.

### 1. Sign-in: Google Cloud Identity Platform

1. In a Google Cloud project, turn on **Identity Platform** and open **Providers**.
2. Add **Google**.
3. Add **Microsoft**. This needs an app registration in the Microsoft Entra admin center:
   - Supported account types: accounts in any organizational directory and personal Microsoft accounts.
   - Redirect URI (Web): `https://<your auth domain>/__/auth/handler`, using the auth domain Identity Platform shows.
   - Create a client secret, then paste the application (client) ID and secret into the Microsoft provider in Identity Platform.
   - Under **API permissions**, add Microsoft Graph delegated permissions `Calendars.ReadWrite` and `Mail.Send`.
4. Under Identity Platform **Settings > Security**, add your site's domain to the authorized domains.
5. From **Application setup details**, copy `apiKey`, `authDomain` and `projectId` into `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN` and `FIREBASE_PROJECT_ID`.

The server checks every request's Identity Platform token against Google's published keys.

### 2. Calendar and email access

Headcount asks for calendar and email access only when someone first sends a meeting request or invitation. The access token stays in that browser tab and is never sent to the Headcount server.

**Google:** in the same project, enable the **Google Calendar API** and **Gmail API**. On the OAuth consent screen, add the scopes `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/gmail.send`. Both are sensitive scopes: until Google verifies the app, only test users you list (up to 100) can connect, and they see an "unverified app" warning. Verification asks for your home page, the privacy policy at `/privacy`, and a short video of the app using each scope.

**Microsoft:** the permissions from step 1.3 cover it. Some organizations only allow apps an administrator has approved. Microsoft also recommends publisher verification for apps used outside your own organization.

Access tokens last about an hour. After that, Headcount asks the person to connect again the next time they send something.

### 3. Bill lookup (optional)

- Federal bills: request a free key at https://api.congress.gov/sign-up/ and set `CONGRESS_API_KEY`.
- State bills: request a free Open States API key at https://open.pluralpolicy.com/ and set `OPENSTATES_API_KEY`.

Without these, people can still write briefs by hand.

### 4. Drafting briefs with Claude (optional)

Set `ANTHROPIC_API_KEY`. Drafting uses `claude-opus-5-5` with structured output, and asks for the server-side refusal fallback (`fallbacks: "default"`), so a request the model declines is retried on a fallback model in the same call. Drafts work only from the bill material and any text the person pastes, and are labelled in the app as drafts to check. `AI_DAILY_LIMIT` caps drafts per day across the server (each person gets a tenth of it); the default is 200.

### 5. Plans and billing (optional)

Without Stripe settings every workspace is unlimited, which suits a firm running its own copy. To sell Headcount:

1. In Stripe, create a product with a recurring per-seat price for the Team plan (and optionally a second one for Firm). Put the price IDs in `STRIPE_PRICE_TEAM` and `STRIPE_PRICE_FIRM`, and your secret key in `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint at `https://<your domain>/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Turn on the customer portal in Stripe, with seat changes and cancellation allowed.
4. Set `PUBLIC_URL` so Stripe can send people back to the app.

New workspaces start with a Team trial (`TRIAL_DAYS`, default 14, with `TRIAL_SEATS`, default 10). When a trial ends without a subscription the workspace moves to Free; nothing is deleted, but new campaigns and people beyond the Free limits need a paid plan. `PRICE_LABEL_TEAM` and `PRICE_LABEL_FIRM` set the price text shown on the buttons; Stripe Checkout always shows the real price.

What each plan allows lives in `server/plans.js`:

| | Free | Team | Firm |
|---|---|---|---|
| People using seats | 2 | as many as you pay for | as many as you pay for |
| Active campaigns | 3 | unlimited | unlimited |
| Guests | 3 | 5 per seat | unlimited |
| Briefs drafted with Claude, per month | 5 | 40 per seat | 100 per seat |
| Activity report, activity log, email-domain joining | no | yes | yes |

These limits are a starting point, not a recommendation: change them to fit your pricing.

### 6. Joining by email domain

On Team and Firm, a workspace admin can add the firm's email domain and verify it with a DNS TXT record. People who then sign in with a verified address at that domain can join as members without an invitation (each uses a seat). Public email services such as gmail.com cannot be claimed. Microsoft accounts often do not report a verified email address, so colleagues signing in that way may still need an invitation.

### 7. Hosting

- Run `npm start` (or the Dockerfile) behind HTTPS. Set `PUBLIC_URL`, and `TRUST_PROXY=1` when a proxy or load balancer sits in front.
- Data lives in one SQLite file under `DATA_DIR`, so the host needs a persistent disk: a small VM, or a platform with attached volumes. Cloud Run's own filesystem is not persistent. Back up the file regularly.
- Finish `public/privacy.html`: it is a template, and needs your organization's name, contact details and a lawyer's review before launch.

```bash
docker build -t headcount .
```

```bash
docker run -p 3000:3000 -v headcount-data:/data --env-file .env headcount
```

## How it works

- `server/` is a small Node.js server with no web framework: Identity Platform token checks (`auth.js`), SQLite storage and permissions (`db.js`), bill lookup (`bills.js`) and drafting (`ai.js`).
- `public/` is plain HTML, CSS and JavaScript with no build step. `cloud.js` handles sign-in, the server API, and the Google and Microsoft calendar and email calls; `app.js` is the app.
- Workspaces, roles, clients, invitations, the activity log and plan limits are in `server/db.js` and `server/plans.js`; Stripe calls and webhook checks are in `server/billing.js`.
- Each campaign is stored as small records (one per member, task and meeting, plus the brief and settings), so teammates editing different members never overwrite each other. If two people change the same member within a few seconds, the later change wins.

## Things to know

- The vote odds are a planning aid built from your own read of each member, not a forecast.
- The lobbying activity report lists what people logged in Headcount. It is not a filing: disclosure laws define lobbying contacts in their own terms, and work done outside the app is not in it. Check it against your records and with counsel.
- A database created by the first version of Headcount is moved into workspaces automatically on start: each owner gets a workspace, and the people they had shared campaigns with become guests on those campaigns.
- The Florida rosters predate the November 3, 2026 election and include members who may have left office; check them against the official sites. The congressional rosters reflect the Congress sitting until January 3, 2027.
- Members of Congress do not publish direct email addresses; add schedulers and staff yourself.
- Teams links need a work or school Microsoft account; for personal accounts the invitation goes out without one.
- Pasted bill text and drafting requests are sent to Anthropic; bill numbers are sent to Congress.gov or Open States.
