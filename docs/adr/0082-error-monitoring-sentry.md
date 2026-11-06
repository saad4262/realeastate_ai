# ADR 0082: Error monitoring with Sentry

**Status:** accepted 2026-11-06 (the user chose Sentry).

**Context.** No error tracking existed; a crash was visible only in Vercel's logs, and many paths catch and log so the page can carry on.

**Decision.** `@sentry/nextjs` in both apps, one Sentry project, tagged `app: web | console`. Errors only: no tracing, no session
replay, `sendDefaultPii` off. Logged errors on the server are captured too, because catch-and-log is how this app handles failures.
`scrubSentryEvent` (`packages/core/src/observability`, unit-tested) runs last: it removes the user, cookies, body, query strings,
all headers but two, and emails, phone numbers, connection strings and keys from error text. Buyer and agency data stays on the platform.

**Late in the browser.** Imported at the top, the SDK added 37 kB to every public page's first load. `browserMonitoring` loads it when the
page goes idle, or at once when an error comes first, and never without a DSN. An error thrown before it loads is handed over by hand.

**Switch.** `NEXT_PUBLIC_SENTRY_DSN` unset means off. Build-time `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` give readable
stacks; source maps are uploaded and then deleted, never served.

**Not done.** No tunnel route: an ad blocker can drop browser errors, and server errors are unaffected. Adding one means excluding
its path from both middlewares.
