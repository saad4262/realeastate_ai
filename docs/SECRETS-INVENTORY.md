# Secrets inventory (PLATFORM-PLAN 5.4)

Every secret the platform uses: **names only, never values**. Values live in the password manager (the master copy)
and in Vercel or GitHub. The boss keeps the "Expires" and "Last rotated" columns current in the password manager's
copy of this list; runbook 3 in `RUNBOOKS.md` says what to do when one leaks.

Projects: **W** web (`realestate-ai-users`), **C** console (`realeastate-ai-agent`, `realeastate-ai-agencyy`,
`realeastate-ai-admin`), **GH** GitHub Actions secrets. "Ours" = a random value we generate
(`openssl rand -base64 32`); it never expires, rotate yearly or on a leak.

| Secret | Where used | Made at | Expires | Rotation note |
|---|---|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` (database password) | W, C | Supabase → Database → reset password | never | Also update `BACKUP_DATABASE_URL` (GH) |
| `SUPABASE_SERVICE_ROLE_KEY` | W, C | Supabase → API keys | never | Full database access: treat as the database password |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | W, C | Supabase → API keys | never | Public by design (RLS + no browser grants) |
| `SESSION_HEADER_SECRET` | W, C | Ours | never | Signs the forwarded identity (1.2) |
| `CRON_SECRET` | W | Ours | never | Vercel cron sends it |
| `REVALIDATE_SECRET` | W, C | Ours | never | |
| `ALERT_UNSUBSCRIBE_SECRET` | W | Ours | never | Rotating breaks old unsubscribe links |
| `MAIL_REPLY_SECRET` | W, C | Ours | never | Rotating breaks replies to old emails |
| `INTEGRATION_TOKEN_KEY` (+ `_PREVIOUS`) | C | Ours | never | `DEPLOY.md` → "Rotating the key". It also encrypts agencies' own Twilio keys: losing it = every Google/Zoom/Outlook connection and every connected Twilio account must be re-entered |
| `ANTHROPIC_API_KEY` | W, C | console.anthropic.com → API keys | never | Spend limit set there too (O-12) |
| `VOYAGE_API_KEY` | W, C | Voyage dashboard | never | |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | W, C | Resend → API keys / Webhooks | never | |
| `TWILIO_MASTER_API_KEY_SID`, `TWILIO_MASTER_API_KEY_SECRET` | W, C | Twilio → API keys | never | Agencies' own Twilio keys are stored per agency, encrypted with `INTEGRATION_TOKEN_KEY` |
| `RETELL_API_KEY` | W, C | Retell dashboard | never | |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | W, C | Stripe → Developers (O-17) | never | Test and live keys are different values |
| `GOOGLE_OAUTH_CLIENT_SECRET` | C | Google Cloud → Credentials | never (Google may disable an unused client) | |
| `GOOGLE_MAPS_API_KEY`, `GOOGLE_PICKER_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | W, C | Google Cloud → Credentials | never | Browser key restricted by referrer |
| `MICROSOFT_CLIENT_SECRET` | C | Microsoft Entra → App registrations → Certificates & secrets | **yes: chosen at creation, at most 24 months** | **Write the date here and a calendar reminder a month before**: on expiry every Outlook connection stops |
| `ZOOM_OAUTH_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN` | C, W | Zoom Marketplace → the app | never | |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | W, C | Cloudflare → R2 → API tokens | as set when made | Only if R2 is in use |
| `SENTRY_AUTH_TOKEN` | build | Sentry → Auth tokens | as set when made | Build-time only |
| `HEALTHCHECK_TICK_URL`, `BACKUP_HEALTHCHECK_URL`, `FILES_HEALTHCHECK_URL` | W, GH | healthchecks.io | never | A URL, but anyone holding it can silence an alarm |
| `BACKUP_AWS_ROLE_ARN` | GH | AWS IAM (OIDC role) | never | No stored AWS keys by design |
| `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY` | GH | Supabase → Storage → S3 connection | never | |
| `BACKUP_DATABASE_URL` | GH | = the production database password | never | |
| age private key (backups) | password manager only | `age-keygen` | never | **Without it no backup can be read.** Never on a server |
| local backup key (`backup-key.txt`) | the private backups folder only | `openssl rand` | never | Same: losing it loses those backups |
| `PLATFORM_ADMIN_EMAIL` / password | admin site | Supabase Auth | never | A person's sign-in; 2FA (1.3) |
| Account logins: Vercel, Supabase, GitHub, AWS, Stripe, Twilio, Resend, Anthropic, Google, Microsoft, Zoom, domain registrar | — | each provider | — | In the business's name, 2FA, two owners (5.9); recovery codes in the password manager |

A new secret in code (`.env.example`) gets a row here in the same pull request.
