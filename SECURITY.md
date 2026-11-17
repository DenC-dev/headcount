# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You should hear back within a few days. Once a fix is ready, it is released and the report is credited, unless you would rather stay anonymous.

## What is in scope

- The Headcount server (`server/`), the app (`public/`), the website (`site/`) and the project website (`pages/`).
- How Headcount handles sign-in tokens, permissions between workspaces, campaigns and guests, Stripe webhooks, unsubscribe links, public action pages and the data it sends to outside services.

Problems in Google Cloud Identity Platform, Stripe, Anthropic or the public data services themselves should go to those providers.

## Running your own copy

If you host Headcount, keep it behind HTTPS, set `APP_SECRET`, keep `.env` out of version control, and never run `AUTH_MODE=dev` in production (the server refuses to). The README's "Things to know" section lists what is sent to which outside service.
