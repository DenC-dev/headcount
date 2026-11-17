# Headcount

Whip counts, meeting requests and bill briefs for lobbyists, advocates and anyone working a vote.

- **Vote count.** Seat-by-seat positions, live odds of passage (or defeat) through committee and the floor, and a ranked list of the members whose minds matter most. Preset rosters for the U.S. House, U.S. Senate, Florida House and Florida Senate, with office contact details.
- **Meeting requests that actually go out.** Ask a member's scheduler for a meeting from your own Gmail or Outlook, offering open times taken from your calendar. When they reply, send a real Google Calendar or Outlook invitation with a Meet or Teams link, check who accepted, and cancel if plans change. Without signing in, the same request opens in your email app and invitations download as an `.ics` file.
- **A brief for every bill.** Look up any federal bill (Congress.gov) or state bill (Open States) to fill in sponsors, status, committees and the official summary. Add your summary, talking points and likely objections by hand, or have Claude draft them from the bill material. Briefs print cleanly and feed every meeting brief and request.
- **Teams.** Sign in with Google or Microsoft, invite colleagues by link as editors or viewers, and work the same count together. Changes from teammates appear within a few seconds.

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

### 5. Hosting

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
- Each campaign is stored as small records (one per member, task and meeting, plus the brief and settings), so teammates editing different members never overwrite each other. If two people change the same member within a few seconds, the later change wins.

## Things to know

- The vote odds are a planning aid built from your own read of each member, not a forecast.
- The Florida rosters predate the November 3, 2026 election and include members who may have left office; check them against the official sites. The congressional rosters reflect the Congress sitting until January 3, 2027.
- Members of Congress do not publish direct email addresses; add schedulers and staff yourself.
- Teams links need a work or school Microsoft account; for personal accounts the invitation goes out without one.
- Pasted bill text and drafting requests are sent to Anthropic; bill numbers are sent to Congress.gov or Open States.
