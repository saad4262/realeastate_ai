# E2E (PLATFORM-PLAN 4.1)

Playwright, five flows and four failures, on the **dev** database (the suite refuses production). It makes its own
world (two agencies, three sign-ins, a contact, a live and a draft listing) and removes it, and anything an earlier
run left, at the end (`E2E_KEEP=1` keeps it for a look).

| Flow | | Failure | |
|---|---|---|---|
| Sign in | ✓ | Cross-agency URL refused | ✓ |
| A buyer's enquiry reaches the agent | ✓ | A duplicate webhook stored and queued once | ✓ (needs `E2E_STRIPE_WEBHOOK_SECRET`) |
| Publish a listing | ✓ | A failed payment | pending: Stripe test mode (O-17) |
| An import | ✓ | A wrong MFA code | pending: MFA (1.3) |
| The assistant answers (fake model) | pending: a fake-model switch on the target | | |

**Locally:** the dev servers on the dev database (`pnpm dev`, the web app on :3000 and the console on :3001; give the
web app `STRIPE_WEBHOOK_SECRET=whsec_e2e_test` for the webhook test), then, with the dev env loaded,
`pnpm e2e` (`E2E_STRIPE_WEBHOOK_SECRET=whsec_e2e_test`). `npx playwright install chromium` once.
**In CI:** `.github/workflows/e2e.yml`, after a preview deploys, once the owner has set it up (O-27).
