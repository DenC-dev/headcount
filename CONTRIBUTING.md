# Contributing

Thank you for helping. Headcount is plain JavaScript with no build step: a small Node.js server (`server/`), the app (`public/`), the product website (`site/`) and the project website (`pages/`).

## Getting started

You need Node.js 22.13 or later.

```bash
npm install
npm run dev
```

Open http://localhost:3000. The development sign-in accepts any name and email.

## Before you open a pull request

```bash
npm test
```

```bash
npm run e2e
```

`npm test` runs the server tests against local stand-ins for every outside service. `npm run e2e` drives the whole app in Chromium and needs Playwright with Chromium installed. Both run on every push and pull request.

If you change how Headcount reads a public data source (`server/sources.js`), also run the checks against the real services:

```bash
npm run test:live
```

It skips any source whose key is not set; see the README for the free keys.

## Style

- Plain browser JavaScript and Node.js built-ins; add a dependency only when it saves real work.
- Write interface text in plain language, the way a busy government affairs professional would read it.
- Every dropdown uses the shared custom component (`public/select.js`); write a normal `<select>` and it is picked up automatically.
- Keep each change focused, with tests for new behavior.

## Reporting bugs and ideas

Open an issue with what you expected, what happened, and how to reproduce it. For security problems, follow [SECURITY.md](SECURITY.md) instead.
