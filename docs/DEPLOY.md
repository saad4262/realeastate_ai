# Deploying

One repository, one database, and — eventually — three domains across two
Vercel projects. This is the order to do it in and the things that bite.

## What is deployed today

| App            | Vercel project | Status                                      |
| -------------- | -------------- | ------------------------------------------- |
| `apps/web`     | one project    | deploys now, on a `*.vercel.app` URL        |
| `apps/console` | one project    | **blocked on a custom domain** — see below  |

### Why the console cannot go up on `*.vercel.app`

Not a configuration gap; the surface model rules it out.

`resolveSurface()` in `apps/console/middleware.ts` decides agency-vs-agent by
reading the **host**: a hostname starting with `agency.` is the agency, and
everything else falls through to the agent. A Vercel project has one
`*.vercel.app` hostname, and it does not start with `agency.` — so the whole
agency surface is unreachable, and the app silently serves the agent surface
at every URL. Nothing errors. It just quietly is not the product.

Cookie sharing is the same story from the other side. `COOKIE_DOMAIN` exists
so one sign-in covers `agents.*` and `agency.*` (ADR 0003), and `.vercel.app`
is on the Public Suffix List, so no cookie may claim it. `cookieDomainFor()`
already handles this gracefully — a host that does not belong to the
configured domain gets an ordinary host-only cookie instead of a silently
discarded one — but graceful degradation is not the feature.

**So: the console waits for a real domain.** Non-negotiable #9 still holds —
`agents.*` and `agency.*` are the same app and the same Vercel project, with
two domains pointed at it. Never fork them into two projects.

## Go-live checklist (do every line; tick it in the PR that goes live)

Nothing below is optional for production. Each line names what proves it is done.

**Domain and hosting**
- [ ] **Domain** bought and on Vercel: apex/`www` → `apps/web`; `agents.` and `agency.` →
      `apps/console` (one project, two hosts). `NEXT_PUBLIC_AGENT_URL`, `NEXT_PUBLIC_AGENCY_URL`,
      `COOKIE_DOMAIN=.<domain>` set; signing in on one host is signed in on the other.
      Step by step, with Cloudflare DNS and every service that knows the domain: `docs/DNS-CUTOVER.md`.
- [ ] **Admin console** (ADR 0049): `admin.` → the same console project (or, while hosts are
      `*.vercel.app`, one more console project with `CONSOLE_SURFACE_OVERRIDE=admin`);
      `NEXT_PUBLIC_ADMIN_URL` set; migration 0057 applied; the first admin made with
      `PLATFORM_ADMIN_EMAIL=… PLATFORM_ADMIN_PASSWORD=… pnpm --filter @repo/db db:platform-admin` — an address
      the platform owns and a strong password (that account reads every agency). Proven by: signing in on
      admin.* lands on /platform; an agency owner signing in there is refused.
- [ ] **Vercel Pro** on both projects (console needs it; the web cron needs it). Proven by:
      the plan page.
- [ ] **5-minute cron**: `*/5 * * * *` on `/api/cron/alerts` (replaces the Hobby daily floor and
      the GitHub Actions pinger), `CRON_SECRET` set. Proven by: the cron log shows a tick every
      5 minutes with `ok: true`. Only then set `ASSISTANT_SCHEDULING=1` (ADR 0025 decision 8).
- [ ] `INTEGRATION_OAUTH_RETURN_BASE` = the agency console's https URL (no localhost hop in
      production) and `ZOOM_OAUTH_RETURN_BASE` unset (no tunnel).
- [ ] **Microsoft Entra app** (ADR 0076): production redirect URI registered, `MICROSOFT_CLIENT_ID/_SECRET`
      on console and web, the secret's expiry in the calendar, **publisher verification** done. Proven by:
      connecting a Microsoft 365 account and an Outlook.com account, each without an "unverified" warning.

**Database**
- [ ] A **separate Supabase project in Sydney** (`ap-southeast-2`) for production — never the
      dev project (dev is Seoul and holds test data). PostGIS and pgvector enabled.
- [ ] All migrations applied (`pnpm --filter @repo/db db:migrate` against the production
      `DIRECT_URL`); the smoke "Database" group green against it (no grants, RLS on every
      table).
- [ ] Point-in-time recovery / backups on; the restore procedure tried once.

**Email**
- [ ] **Resend domain** verified for the production domain with **SPF, DKIM and DMARC** records
      (DMARC at least `p=quarantine` once reports are clean). Sender identity and postal
      address set (`ALERT_*`/sender variables).
- [ ] **Inbound**: MX for `MAIL_INBOUND_DOMAIN` pointing at Resend Inbound, `MAIL_REPLY_SECRET`
      set; a reply to a console email lands back in its thread.
- [ ] **Documents** (ADR 0053): migration 0061 applied, the private `documents` bucket made as in
      "Documents and the knowledge base" below, `/api/cron/documents` answering 200 to the cron.
- [ ] **Opportunities** (ADR 0054): migration 0062 applied; `/api/cron/opportunities` (hourly, in
      `apps/web/vercel.json`) answering 200 with `failed: []`.
- [ ] `EMAIL_DEV_ALLOWLIST` is **ignored** in production (it is) — and `NODE_ENV=production`
      is really set, which is what makes it ignored.
- [ ] `EMAIL_REPEAT_DAYS` is **7 or more** in production (or unset = 7). `0` is a testing
      switch only; production ignores anything below 7 and uses 7 (ADR 0022) — still, do not
      copy a dev `.env.local` that has it.

**Secrets — all fresh for production**
- [ ] **Every secret is newly generated for production**, never copied from `.env.local`:
      `INTEGRATION_TOKEN_KEY`, `MAIL_REPLY_SECRET`, `ALERT_UNSUBSCRIBE_SECRET`, `CRON_SECRET`,
      the verify-email secret, Supabase service key, Resend key, Anthropic key, Google and Zoom
      client secrets.
- [ ] **Any secret that has ever appeared in a screenshot, a chat, a log, a ticket or a commit
      is rotated** — including in dev — before go-live. (Dev keys have been shown in chats
      during development: rotate them.)
- [ ] `ANTHROPIC_API_KEY` for production has a **spend limit set in the Anthropic console**
      (the hard backstop behind `AI_DAILY_BUDGET_USD` and the assistant caps).
- [ ] Production `INTEGRATION_TOKEN_KEY` stored in the password manager; losing it means every
      agency reconnects every account.

**Integrations**
- [ ] **`INTEGRATIONS_STUB` is NOT set in production.** The console refuses to start if it is
      (instrumentation check) — confirm by reading the production env list, not by assuming.
- [ ] **Google OAuth verification** submitted and approved for the ONE Google app: homepage and
      privacy policy on the real domain, authorised domains, the scopes in use with
      justifications and a demo video (Calendar `calendar.events.owned`; Gmail `gmail.send` —
      sensitive, ADR 0026; Sheets `drive.file`; Business Profile `business.manage`, which also
      needs Google's separate API-access approval, ADR 0028). Until approved the app is in
      Testing: test users only, tokens expire in ~7 days.
- [ ] Google Cloud: production redirect URI (`https://agency.<domain>/api/integrations/oauth/return`)
      registered; the dev `localhost` URI removed from the production client (use a separate
      dev client).
- [ ] **Zoom Marketplace**: the app published (or approved for the accounts that will use it),
      production redirect URL and OAuth allow list on the real domain.
      Deauthorization Notification Endpoint URL `https://<domain>/api/zoom/webhook` (App listing →
      Links & Support) and `ZOOM_WEBHOOK_SECRET_TOKEN` (the production app's Secret Token) on the
      **web** project; Privacy policy `https://<domain>/privacy-policy`, Terms
      `https://<domain>/terms-of-service`, with the placeholders in `apps/web/app/(legal)/legal.ts`
      filled and the text reviewed (ADR 0037). Proven by: "Validate" on the endpoint goes green.
- [ ] `GOOGLE_MAPS_API_KEY` restricted by IP / API; browser key restricted by HTTP referrer to
      the production domains.
- [ ] **Places API (New)** enabled in the Google Cloud project of `GOOGLE_MAPS_API_KEY` (and
      allowed in the key's API restrictions). Google reviews (ADR 0028) uses only it — Text
      Search and Place Details with `reviews`, no fallback — while address suggestions fall
      back to the old "Places API" and Geocoding API, so working suggestions do not prove it is
      on. Place Details with reviews is a higher-priced SKU: set a billing alert.

**Legal and product pages**
- [ ] **Privacy policy** and **terms of use** published on the domain (needed by Google
      verification, Zoom publishing, the Spam Act sender requirements and APP 1), linked from
      every page footer and the sign-up screens.
- [ ] Unsubscribe link and sender postal address on every marketing email (already enforced in
      code — confirm with one real send).

**Last checks**
- [ ] `pnpm smoke` green against production (read-only groups) and TEST-PLAN's go-live
      sections walked once in a browser on the real domain.
- [ ] Tenant isolation smoke group (ADR 0030) green before the second agency is let in.

## apps/web — project settings

| Setting                          | Value                     |
| -------------------------------- | ------------------------- |
| Root Directory                   | `apps/web`                |
| Include files outside root dir   | **on** (needs `packages/`)|
| Framework Preset                 | Next.js                   |
| Install / Build / Output command | leave as detected         |
| Function region                  | `syd1` — from `vercel.json` (both apps) |

Nothing needs a custom build command. The workspace packages export raw
TypeScript (`"." : "./src/index.ts"`, no `dist`) and `next.config.ts` lists
every one of them in `transpilePackages`, so `next build` compiles them
itself. `packageManager: "pnpm@9.15.0"` in the root `package.json` is what
tells Vercel which package manager to use — do not remove it.

**Functions run in Sydney (`syd1`), next to the database (`ap-southeast-2`).** Both
`apps/web/vercel.json` and `apps/console/vercel.json` say so (`"regions"`), so all three
projects get it from the repo and not from a dashboard setting. Vercel's default is `iad1`
(Washington): every query then crosses the Pacific twice, about 200 ms each, and a console
click that makes a few queries in a row waited 0.6–1.2 s for nothing else (found 2026-10-16).
If the database ever moves, this line moves with it.

## Environment variables

Set these **before the first deploy**, not after.

`/` is a prerendered ISR route (`○ /  Revalidate 30s` in the build output),
so it queries the database **at build time**. With no `DATABASE_URL` the build
does not merely produce an empty homepage — it fails. This is the single most
likely reason a first deploy goes red.

### Required — the app is broken without them

    DATABASE_URL                         Supabase TRANSACTION pooler, port 6543.
                                         Not 5432: serverless opens and drops
                                         connections constantly and the direct
                                         port will exhaust. Percent-encode the
                                         password.
    NEXT_PUBLIC_SUPABASE_URL             Auth, and the one host next/image may
                                         fetch from.
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    NEXT_PUBLIC_WEB_URL                  https://<project>.vercel.app — no
                                         trailing slash. Wrong here means wrong
                                         links inside outgoing email.

### Required for alerts — these FAIL LOUDLY, which is deliberate

`buildScheduleDigestEmail` throws rather than sending a message that cannot
comply with the Spam Act 2003. Unset means no alert email is ever sent.

    RESEND_API_KEY
    ALERT_EMAIL_FROM                     A full address, never a bare domain.
                                         `example.com.au` alone reaches Resend as
                                         `Name <example.com.au>` and is refused.
                                         The domain must be verified in Resend
                                         or sends come back 403.
    ALERT_SENDER_NAME
    ALERT_SENDER_ADDRESS                 A postal address. Legally required.
    ALERT_UNSUBSCRIBE_SECRET             HMAC key. No default anywhere in code —
                                         a default is a link anybody could forge
                                         for anybody else's alert.
    CRON_SECRET                          Any long random string. Unset means
                                         /api/cron/alerts refuses everything with
                                         503, which is the correct closed
                                         failure: an open trigger is a bill and a
                                         mailing, not a slow page.

Generate the two secrets with `openssl rand -hex 32`.

### Optional — each degrades to something sensible

    ANTHROPIC_API_KEY                    Unset: /chat answers 503 with a readable
                                         reason. Every other page is unaffected.
    ANTHROPIC_CHAT_MODEL                 Unset: DEFAULT_CHAT_MODEL in
    ANTHROPIC_ALERT_MODEL                packages/ai/src/models.ts (claude-haiku-4-5).
    AI_CHAT_DAILY_TURN_CAP               Default 2000. A cost ceiling, NOT a
                                         security control. Set a hard spend cap
                                         in the Anthropic console as well.
    AI_DAILY_BUDGET_USD                  Default 5. Trailing 24h, from ai_run.
    AI_DAILY_BUDGET_USD_PER_USER         Default 0.25.
    GOOGLE_MAPS_API_KEY                  Server key, restrict by IP. Unset: the
                                         radius is lost; suburb search still
                                         works. Needs Places API (New) for
                                         Google reviews and Geocoding API for
                                         CSV import and pin addresses.
    NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY  A DIFFERENT key, restrict by HTTP
                                         referrer. Never interchangeable with the
                                         one above. Unset: maps show a "not
                                         configured" panel; pins are still stored
                                         and searched.
    NEXT_PUBLIC_SUPABASE_MEDIA_BUCKET    Defaults to `media`.
    REVALIDATE_SECRET                    Unset: /api/revalidate refuses
                                         everything and the site falls back to
                                         its own short revalidate windows.
    ALERTS_DRY_RUN                       `1` builds every digest and sends no
                                         mail. Set this on any preview that
                                         shares the production database.
    MAIL_INBOUND_DOMAIN                  The domain Resend receives on, e.g.
    MAIL_REPLY_SECRET                    reply.example.com.au, plus the key that
                                         signs reply addresses. Both or neither.
                                         Unset: console replies still send, but
                                         buyers' answers go to the agent's own
                                         email instead of back into the inbox.
    RESEND_WEBHOOK_SECRET                `whsec_…` of the inbound webhook.
                                         Unset: /api/mail/inbound refuses all.

### Email conversations — one-time setup (docs/adr/0016)

Quickest (no DNS): Resend gives every account a receiving subdomain.
1. Resend → Emails → **Receiving** → ⋯ → **Receiving address**. It looks like
   `anything@<id>.resend.app`; the part after `@` is the domain.
2. Set `MAIL_INBOUND_DOMAIN=<id>.resend.app` and a long random
   `MAIL_REPLY_SECRET` (`openssl rand -hex 32`). Restart the servers.
3. That is enough, on localhost too: the inbox, the buyer's messages page and
   the cron tick PULL received mail from Resend (`pullReceivedMail`), so no
   webhook or public URL is needed.

Optional, for instant delivery once deployed: Resend → Webhooks → endpoint
`https://<web host>/api/mail/inbound`, event `email.received`, its secret in
`RESEND_WEBHOOK_SECRET`. Own domain instead of resend.app: Resend → Domains →
enable receiving on a SUBDOMAIN (e.g. `reply.example.com.au`) and add its MX —
never the main domain, whose mail lives elsewhere.

4. Run migrations 0016–0018 before deploying the code that reads them.
5. Check: send a reply from `/inbox`, answer it from Gmail, and it appears in the
   thread within seconds. Each agency's own address is shown on its `/inbox`.

#### Production, step by step (own subdomain + webhook)

Sending stays on the verified `alerts@quotemydecking.com.au`; only RECEIVING gets a subdomain.

1. **Resend → Domains → `quotemydecking.com.au` → Receiving → Enable** on a subdomain, e.g.
   `reply.quotemydecking.com.au` (never the bare domain — its own mail lives elsewhere).
   Resend shows one **MX** record (host `reply`, priority 10). Add it at the DNS host exactly as
   shown, wait until Resend says *Verified*.
2. **Resend → Webhooks → Add endpoint**: URL `https://<web host>/api/mail/inbound`,
   event **`email.received`**. Copy its signing secret (`whsec_…`).
3. **The same secret value in both projects** (console signs the Reply-To, web reads it back):

       cd apps/web     && vercel link      # once, pick the web project
       openssl rand -hex 32                # → the reply secret; keep it in the password manager
       printf '%s' 'reply.quotemydecking.com.au' | vercel env add MAIL_INBOUND_DOMAIN production
       printf '%s' '<the hex>'                   | vercel env add MAIL_REPLY_SECRET production
       printf '%s' 'whsec_…'                     | vercel env add RESEND_WEBHOOK_SECRET production
       cd ../console   && vercel link      # once, pick the console project
       printf '%s' 'reply.quotemydecking.com.au' | vercel env add MAIL_INBOUND_DOMAIN production
       printf '%s' '<the same hex>'              | vercel env add MAIL_REPLY_SECRET production

   Then redeploy both (`vercel --prod`, or Redeploy in the dashboard): env changes reach only new
   deployments.
4. **Check**: send a reply from `/inbox`; the email's Reply-To must be
   `t+<thread>.<sig>@reply.quotemydecking.com.au`. Answer it from Gmail — it lands in the same
   thread within seconds (webhook), or within 5 minutes (the cron pull) if the webhook is not set.
   Resend → Webhooks shows each delivery and its HTTP status; a 401 there is a wrong
   `RESEND_WEBHOOK_SECRET`.
5. **Attachments** on those replies become documents on the thread's contact (ADR 0053 §7) once
   the documents section below is set up — nothing more to configure here.

### Documents and the knowledge base (console + web cron; docs/adr/0053)

1. **Migration 0061** before deploying the code that reads it (`pnpm db:migrate`).
2. **A PRIVATE bucket** — Supabase → Storage → New bucket: name `documents`, **Public: off**,
   file size limit **25 MB**, allowed MIME types:
   `application/pdf, image/jpeg, image/png, image/webp,
   application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/plain,
   text/markdown, text/csv`. Add **no** policies: the service key is the only way in, and every
   read is a 60-second signed link handed out after the visibility rule.
3. **Environment** (both projects unless said):

       SUPABASE_SERVICE_ROLE_KEY            Already set for photos. Required.
       SUPABASE_DOCUMENTS_BUCKET            Default `documents`.
       ANTHROPIC_API_KEY  (web)             Reads scans and photos. Unset: text PDFs, Word and
                                            text files are still read; scans are marked
                                            "reading is not switched on".
       ANTHROPIC_DOCUMENT_MODEL (web)       Default claude-opus-5-5. Must be a model priced in
                                            packages/ai/src/models.ts.
       DOCUMENTS_VISION (web)               `off` switches scan reading off.
       DOCUMENTS_VISION_DAILY_BUDGET_USD_PER_AGENCY (web)   Default 1. Trailing 24 h.
       EMBEDDINGS_PROVIDER / VOYAGE_API_KEY (web)            As for search (ADR 0031); unset
                                            = documents are found by words only.
       RESEND_API_KEY (web)                 Already set. Fetches inbound attachments.

4. **The cron** `/api/cron/documents` is in `apps/web/vercel.json` (every 5 minutes, same
   `CRON_SECRET`). It declares `maxDuration = 300`, which needs **fluid compute** (on by default
   for new projects: Project → Settings → Functions). Manual run:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<web host>/api/cron/documents`.
5. **Check** (TEST-PLAN **BG**): drop a PDF on a contact's Documents tab → "Reading…" → "Ready"
   within 5 minutes; ask the assistant about something on page 2 → it names the document and
   the page.

### Integrations — the token key (console project; docs/adr/0020)

Google Calendar, Zoom, Sheets and Reviews tokens are stored **encrypted** with a key
that lives only in the environment — never in the database, never in git, never in a log.

    INTEGRATION_TOKEN_KEY          REQUIRED on the console in production.
                                   32 random bytes, base64:  openssl rand -base64 32
    INTEGRATION_TOKEN_KEY_PREVIOUS Only during a rotation (below).
    INTEGRATION_OAUTH_RETURN_BASE  Leave UNSET in production — the return address is
                                   then NEXT_PUBLIC_AGENCY_URL (which must be https).
                                   Dev only: http://localhost:3001.
    INTEGRATIONS_STUB              NEVER in production.

**The console refuses to start in production** if `INTEGRATIONS_STUB=1` is set or
`INTEGRATION_TOKEN_KEY` is missing or malformed (`apps/console/instrumentation.ts`;
checked by starting a production build both ways). The log line says which variable.

**Production gets its OWN key.** Never copy the dev key from `.env.local`: anyone
holding a key plus a database dump can read every stored token. Generate a fresh
one for production, keep it only in Vercel → Settings → Environment Variables
(Production scope), and in your password manager.

**Losing the key means everyone reconnects.** Without it no stored token can be
decrypted. Nothing else is lost — appointments, contacts and the rest are
untouched — but every Google/Zoom connection must be disconnected and connected
again by its owner (agents their own, an admin the agency's). There is no recovery
path by design.

**Rotating the key** (yearly, or at once if it may have leaked):

1. Generate a new key: `openssl rand -base64 32`.
2. On Vercel set `INTEGRATION_TOKEN_KEY_PREVIOUS` = the current key and
   `INTEGRATION_TOKEN_KEY` = the new one. Redeploy.
   From now on new tokens are written with the new key; old ones still decrypt
   with the previous key (each stored value names the key that wrote it).
3. Let every connection be re-saved under the new key — a reconnect does it.
   (Until a re-encrypt script exists, ask owners to reconnect. A token renewal
   re-saves only the access token — and Zoom's rotated refresh token — so a
   Google refresh token stays on the old key until its owner reconnects.)
4. When no row is left on the old key, remove `INTEGRATION_TOKEN_KEY_PREVIOUS` and
   redeploy. If the old key leaked, do not wait: remove it at once and have
   everyone reconnect — a leaked key must not keep working.

The same key also signs the OAuth `state` (through a derived key), so a rotation
also expires any Connect that is half-way through — the person simply presses
Connect again.

### Google Calendar and Zoom (console + web cron; docs/adr/0020 "Phase 3b")

    GOOGLE_OAUTH_CLIENT_ID / _SECRET   Google Cloud → Credentials → OAuth client
                                       (Web application). Console AND web (the
                                       cron renews tokens when it reads back).
    ZOOM_OAUTH_CLIENT_ID / _SECRET     Zoom Marketplace → General app. Same two projects.
    ZOOM_OAUTH_RETURN_BASE             Leave UNSET in production (the console's https
                                       host is accepted by Zoom). Dev only: a tunnel.

Redirect URI to register at both providers in production:
`https://agency.<domain>/api/integrations/oauth/return` (the agency console URL —
the same single route; agent-side connections hop there and back by the signed
state). Keep the dev URIs registered beside it while testing.

Before real customers: Google app verification (needs the domain, a homepage and a
privacy policy; until then Testing mode = test users only, tokens die after ~7 days)
and, for Zoom accounts outside your own, publishing the app on the Zoom Marketplace.
The read-back runs inside the existing 5-minute cron tick — nothing extra to schedule —
which lives in the WEB project, so the web project needs `INTEGRATION_TOKEN_KEY` (the
same value as the console) as well as the four client variables. Without them the tick
skips the read-back and the console still syncs on every change.

### Outlook mail and calendar (console + web cron; docs/adr/0076)

    MICROSOFT_CLIENT_ID / _SECRET      Microsoft Entra admin center → App registrations → New:
                                       "Accounts in any organizational directory (any Microsoft
                                       Entra ID tenant) and personal Microsoft accounts". Platform:
                                       Web, redirect URI the same single route as Google's
                                       (`https://agency.<domain>/api/integrations/oauth/return`).
                                       API permissions (Microsoft Graph, Delegated): Mail.Send,
                                       Calendars.ReadWrite, User.Read, offline_access, openid, email.
                                       Certificates & secrets → New client secret. Console AND web.

The client secret EXPIRES (at most 24 months): put the date in the calendar and rotate it before.
Before real customers: **publisher verification** (a Microsoft Partner Network ID tied to the domain) —
without it the consent screen says "unverified" and many organisations need an IT admin to approve the app.
Microsoft has no per-app revoke: a disconnect deletes our tokens and tells the person to remove the app under
their Microsoft account. Each person chooses which of Gmail / Outlook (and Google / Outlook Calendar) is in use.

### Meeting reminders (web cron; docs/adr/0032)

The same 5-minute tick sends meeting reminders: a bell notification and an email to the
agent and whoever booked it, and an email to an invited contact. Nothing extra to schedule.
The WEB project needs the mail variables (as for alerts) and `NEXT_PUBLIC_AGENT_URL` /
`NEXT_PUBLIC_AGENCY_URL`, so the reminder email's "Open your calendar" link points at the
console. Without mail, the bell still works. Migration 0039 (btree_gist, the no-overlap
constraint, `notification`) must be applied before this code goes up: the console reads
`notification` on every page through the bell.

### Template email to contacts (console + web; docs/adr/0022)

    ALERT_UNSUBSCRIBE_SECRET   REQUIRED for it — every template email carries a
                               contact unsubscribe link signed with it; without it
                               nothing is sent (Approve says why).
    EMAIL_LIMIT_PER_BATCH      20   recipients per batch
    EMAIL_LIMIT_PER_AGENT_DAY  50   per agent per rolling 24 h (all platform-composed mail)
    EMAIL_LIMIT_PER_AGENCY_DAY 200  per agency per rolling 24 h
    EMAIL_REPEAT_DAYS          7    the same person not again within N days. 0 = rule off,
                               DEVELOPMENT ONLY; production uses at least 7.
    EMAIL_SEND_DELAY_MS        500  pause between two messages of a batch
    EMAIL_DEV_ALLOWLIST        DEVELOPMENT ONLY. Outside production, template emails
                               go only to these addresses / @domains; unset means
                               NOBODY (everyone shows "dev allowlist"). Production
                               ignores it entirely — set nothing there.

Nothing is ever sent on a schedule: a person prepares a batch, checks the frozen
list, and presses Approve & Send. The cron tick only expires batches after 48 h,
settles a send that was interrupted, and resumes an approved batch left queued.

### Deliberately NOT set

    COOKIE_DOMAIN     Leave unset on a *.vercel.app deployment. The schema
                      defaults it to `.lvh.me`, but `cookieDomainFor()` reads
                      process.env directly, so unset yields a host-only cookie —
                      which is the right answer here. Set it to `.yourdomain.com`
                      only once the real domain exists.

    NEXT_PUBLIC_AGENT_URL / NEXT_PUBLIC_AGENCY_URL
                      Not read by apps/web anywhere — checked, not assumed:
                      the only `process.env` reads of either are in
                      packages/smoke, and `web-shell.tsx` draws no console links
                      at all. They matter to the console (invite claim links are
                      built from NEXT_PUBLIC_AGENT_URL so an agent never lands on
                      the agency host), so they belong on THAT project when it
                      is deployed, not this one.

    SUPABASE_SERVICE_ROLE_KEY
                      Also not needed by apps/web. The only reader is
                      `packages/core/src/media/storage-client.ts`, which the
                      media barrel deliberately does NOT re-export, and apps/web
                      imports only `@repo/core/media/url` and the DB-reading
                      helpers. Uploads are a console concern. Leaving it off the
                      web project means the key that bypasses RLS is not sitting
                      in an environment that has no use for it.

    DIRECT_URL        Tooling only. The three readers are drizzle.config.ts,
                      geo/backfill.ts and clear-listings.ts — all CLI, none of
                      them runtime. It is what you migrate WITH, not something
                      the deployment needs.

    R2_*, NEXT_PUBLIC_R2_PUBLIC_URL
                      Declared in the env schema and read by NO code anywhere —
                      grep finds zero `process.env.R2_` outside the schema.
                      Media went to Supabase Storage (ADR 0009). They stay
                      declared so a move back is a resolver change rather than a
                      schema change; they are not a deployment prerequisite.

    EMBEDDINGS_PROVIDER                  Optional (ADR 0031). `voyage` turns on the
                                         assistant's search by meaning; unset =
                                         search by words only.
    VOYAGE_API_KEY                       With the above. Note/email text goes to
                                         Voyage (US): privacy policy + DPA first.
    EMBEDDINGS_DAILY_BUDGET_USD_PER_AGENCY  Indexing cap per agency a day (default
                                         0.25), inside AI_DAILY_BUDGET_USD.

    NEXT_PUBLIC_UI_PREVIEW, AGENT_INVITE_TTL_MINUTES
                      Console-only. No effect on apps/web.

## Migrations

Vercel does not run them. `packages/db/drizzle/` gained six since the last
deploy — `0008` through `0013` — and the app will throw on a missing table.

    DATABASE_URL=<DIRECT url, port 5432> pnpm db:migrate

Use the **direct** connection for migrations, not the pooler. Run it before
the first deploy, and after any deploy whose diff touches `drizzle/`.

## The scheduler tick

One Vercel cron on the web project: `*/5 * * * *` on `/api/cron/alerts`
(`apps/web/vercel.json`, Vercel Pro). It runs every scheduled thing for every
surface — saved-search alerts, agents' skills, template-email batches, the
assistant's scheduled actions, appointment sync. Full reasoning in
`apps/web/CRON.md`. Needs `CRON_SECRET` on the web project (Production);
Vercel sends it as `Authorization: Bearer`.

The every-minute tick, `/api/cron/minute` (ADR 0035), runs its jobs in rounds against a 45 s budget
(ADR 0073): every job gets one round, then the full queues drain until the budget is spent. Its log is
`{ ok, ms, budgetMs, jobs: { workflows, scheduled, reminders, aiCalls, platformEmails, zoomAlerts, deals,
phoneKyc } }`, each with `rounds`, `ms`, `more` and totals. A job with `more: true` tick after tick is
falling behind: look at its `ms` before raising a batch size (`MINUTE_BATCH` in `packages/core/src/cron`).

The shortest gap anywhere is 10 minutes — saved searches
(`MIN_INTERVAL_MINUTES`) and skills (`MIN_SKILL_INTERVAL_MINUTES`, migration
0038) alike — against the 5-minute tick: 2:1, so a backlog drains. Change the
tick and the floor together or not at all.

## After the first deploy — verify, do not assume

    # 1. The cron endpoint is reachable AND closed to strangers.
    curl -s -o /dev/null -w '%{http_code}\n' \
      -X POST https://<project>.vercel.app/api/cron/alerts
    # expect 401. A 200 here means CRON_SECRET is not set — stop and fix it.

    # 2. It runs with the secret.
    curl -s -X POST https://<project>.vercel.app/api/cron/alerts \
      -H "x-cron-secret: $CRON_SECRET" | jq
    # expect { ok: true, claimed, delivered, ... }

    # 3. Then watch the web project's logs: a GET /api/cron/alerts every 5 minutes.

Also worth a look on day one: `/` renders listings (the build reached the
database), `/search` returns results, `/listing/[id]` opens, and `/chat`
either answers or 503s with a readable reason rather than a stack trace.

`docs/TEST-PLAN.md` is the manual pass that needs a browser.

## AI help for the contacts import (ADR 0056)

1. **Migration 0064** (`listing_import.ai_mapped`, `ai_clean`) — apply before deploying this code:
   the import screens read both columns.
2. **Environment** — both projects: the console maps columns at upload and runs dry-run chunks
   while the page is open; the web cron carries on a dry run whose tab was closed.

       ANTHROPIC_API_KEY                    Already set. Unset: imports work exactly as before
                                            (header synonyms only, no "AI fixes" box).
       ANTHROPIC_IMPORT_MODEL               Default claude-opus-5-5 (low effort). Must be a model
                                            priced in packages/ai/src/models.ts.
       IMPORT_AI                            `off` switches both steps off.
       IMPORT_AI_DAILY_BUDGET_USD_PER_AGENCY  Default 1. Trailing 24 h, both steps together; over it,
                                            the synonyms stand and failing rows say so.

3. **Check** (TEST-PLAN **BJ**).

## Skills, matched buyers, more roles, the inbox assistant (ADR 0058–0062)

1. **Migrations**, before deploying this code: **0065** (`skill_switch`) and **0066** (`email_batch.listing_id`,
   `listing_snapshot`) are applied; **0067** (three contact roles) was applied 2026-10-28. The contact form and
   directory list the new roles, so 0067 must be in before this code is deployed.
2. **Environment** — console only (the inbox assistant runs from the open conversation):

       ANTHROPIC_API_KEY                     Already set. Unset: no assistant over the reply box.
       ANTHROPIC_SKILL_AGENT_MODEL           The model both calls use (default claude-sonnet-5-5).
       INBOX_AI                              `off` hides the assistant on every conversation.
       INBOX_AI_DAILY_BUDGET_USD_PER_AGENCY  Default 2. Trailing 24 h, summaries and drafts together; over
                                             it, the buttons say the budget is used up.
       NEXT_PUBLIC_WEB_URL                   Already set. `{{listing_link}}` points at its /listing/<id>.

3. **Inbound email** is ROADMAP 1.6's other half and needs no code — see "Email conversations" above
   (`MAIL_INBOUND_DOMAIN`, `MAIL_REPLY_SECRET`, the MX record). Until it is set, the assistant still works
   on enquiries and on what the agent sent; clients' replies just don't come back into the thread.
4. **Check**: TEST-PLAN **BK**, **BL**, **BM**, **BN**, **BO**, **BP**.

## The deal pipeline (ADR 0063)

1. **Migration 0068** (`deal` with its commission columns, `deal_condition`, `deal_event`) before deploying this
   code: the listing page's Deal tab, `/pipeline`, `/finance` and `/my-commission` read them. **0067** too, for
   settling's Past client tag. Both applied 2026-10-28.
2. Nothing new in the environment. The web project's every-minute cron (`/api/cron/minute`) now runs the deal
   sync and the condition/settlement reminders.
3. **Check**: TEST-PLAN **BQ** and **BR**.

## The property page (ADR 0065)

1. No migration of its own, but `/properties` and `/my-properties` read the deal: **0068** first.
2. **Environment** — console only:

       PROPERTY_AI                              `off` hides the summary button on every property.
       PROPERTY_AI_DAILY_BUDGET_USD_PER_AGENCY  Default 2. Trailing 24 h of property summaries; over it, the
                                                button says the budget is used up. AI_DAILY_BUDGET_USD still caps all AI.

   The summary uses ANTHROPIC_API_KEY and ANTHROPIC_SKILL_AGENT_MODEL, like the inbox assistant.
3. **Check**: TEST-PLAN **BS**.

## More workflow triggers (ADR 0066)

1. **Migration 0069** (widens `workflow_event_kind_check`) before deploying this code — a scan inserting a new kind
   into the old CHECK would fail the minute tick's workflow step.
2. Nothing new in the environment; the scans run in the existing minute cron, only while a workflow wants them.
3. **Check**: TEST-PLAN **BT**.

## "AI decides" in a workflow (ADR 0067)

1. **Migration 0069** also adds `workflow_run.decision` — the minute tick writes it, so 0069 goes in first.
2. **Environment** — the **web** project (the minute cron runs the decision):

       ANTHROPIC_API_KEY                         Set it on web too. Unset: every decision is "Not sure".
       ANTHROPIC_SKILL_AGENT_MODEL               The model (default as for the inbox assistant).
       WORKFLOW_AI                               `off` makes every decision "Not sure".
       WORKFLOW_AI_DAILY_BUDGET_USD_PER_AGENCY   Default 2. Trailing 24 h; over it, "Not sure" with the reason.

3. **Check**: TEST-PLAN **BU**.
