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

## apps/web — project settings

| Setting                          | Value                     |
| -------------------------------- | ------------------------- |
| Root Directory                   | `apps/web`                |
| Include files outside root dir   | **on** (needs `packages/`)|
| Framework Preset                 | Next.js                   |
| Install / Build / Output command | leave as detected         |

Nothing needs a custom build command. The workspace packages export raw
TypeScript (`"." : "./src/index.ts"`, no `dist`) and `next.config.ts` lists
every one of them in `transpilePackages`, so `next build` compiles them
itself. `packageManager: "pnpm@9.15.0"` in the root `package.json` is what
tells Vercel which package manager to use — do not remove it.

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
    ANTHROPIC_CHAT_MODEL                 Defaults to claude-opus-5. The deployed
                                         default is currently Haiku — see
                                         DEFAULT_CHAT_MODEL.
    AI_CHAT_DAILY_TURN_CAP               Default 2000. A cost ceiling, NOT a
                                         security control. Set a hard spend cap
                                         in the Anthropic console as well.
    AI_DAILY_BUDGET_USD                  Default 5. Trailing 24h, from ai_run.
    AI_DAILY_BUDGET_USD_PER_USER         Default 0.25.
    GOOGLE_MAPS_API_KEY                  Server key, restrict by IP. Unset: the
                                         radius is lost; suburb search still
                                         works.
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

    NEXT_PUBLIC_UI_PREVIEW, AGENT_INVITE_TTL_MINUTES
                      Console-only. No effect on apps/web.

## Migrations

Vercel does not run them. `packages/db/drizzle/` gained six since the last
deploy — `0008` through `0013` — and the app will throw on a missing table.

    DATABASE_URL=<DIRECT url, port 5432> pnpm db:migrate

Use the **direct** connection for migrations, not the pooler. Run it before
the first deploy, and after any deploy whose diff touches `drizzle/`.

## The scheduler tick

`vercel.json` declares a daily `0 3 * * *`. That is a floor, not the cadence —
Vercel Hobby **fails the deployment** for any expression that would run more
than once a day. The real 5-minute tick comes from
`.github/workflows/alerts-cron.yml`. Full reasoning in `apps/web/CRON.md`.

Two repository secrets, at Settings → Secrets and variables → Actions:

    ALERTS_CRON_URL   https://<project>.vercel.app/api/cron/alerts
    CRON_SECRET       the same value set on Vercel

The workflow exits 1 when either is missing, so a forgotten secret is a red
run rather than alerts that quietly never fire.

## After the first deploy — verify, do not assume

    # 1. The cron endpoint is reachable AND closed to strangers.
    curl -s -o /dev/null -w '%{http_code}\n' \
      -X POST https://<project>.vercel.app/api/cron/alerts
    # expect 401. A 200 here means CRON_SECRET is not set — stop and fix it.

    # 2. It runs with the secret.
    curl -s -X POST https://<project>.vercel.app/api/cron/alerts \
      -H "x-cron-secret: $CRON_SECRET" | jq
    # expect { ok: true, claimed, delivered, ... }

    # 3. Then run the workflow by hand: Actions → "alerts cron" → Run workflow.

Also worth a look on day one: `/` renders listings (the build reached the
database), `/search` returns results, `/listing/[id]` opens, and `/chat`
either answers or 503s with a readable reason rather than a stack trace.

`docs/TEST-PLAN.md` is the manual pass that needs a browser.
