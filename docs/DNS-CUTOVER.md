# Cloudflare DNS cutover — step by step

Moving the platform onto a domain whose DNS is on Cloudflare: first the **temporary domain**, later the
**real domain**. The same list both times; only `OLD` and `NEW` change. Tick each line in the PR or
ticket for the cutover. Every step says what proves it is done.

| Placeholder | Meaning | Example |
|---|---|---|
| `NEW` | The domain we are moving to | `localagent.com.au` |
| `OLD` | What users reach today | `realeastate-ai-users.vercel.app` (web), the temporary domain later |

Hosts on `NEW` (one Vercel project each side, ADR 0003 / non-negotiable 9):

| Host | Vercel project | What |
|---|---|---|
| `NEW` (apex) and `www.NEW` | web | public site, webhooks, crons |
| `agents.NEW`, `agency.NEW` | console | agent desk and agency console (the SAME project) |
| `admin.NEW` | console (admin) | platform admin (ADR 0049) |

**Not changing:** the email sender stays `alerts@quotemydecking.com.au` (verified in Resend); its DNS is
not part of this cutover. Vercel crons belong to the projects, not the domain.

---

## 1. Two days before

- [ ] **Access:** the registrar login for `NEW`, the Cloudflare account, every Vercel project, Supabase,
      Google Cloud, Zoom Marketplace, Resend, and the production env (for step 7). Proven by: each one opened.
- [ ] **Add `NEW` to Cloudflare** (Add a site → Free plan is enough). Cloudflare copies the records it can
      find: read them all. Do NOT change nameservers yet.
- [ ] **Keep what `NEW` already does:** if the agency or the client already uses `NEW` for email (Google
      Workspace, Microsoft 365), its MX, SPF (`TXT v=spf1…`), DKIM and DMARC records must be in Cloudflare
      exactly as they are now. Proven by: the list in Cloudflare matches the current provider's, line by line.
- [ ] **DNSSEC off at the registrar** (remove the DS record). Nameservers must not change while an old DS
      record is live, or validating resolvers fail the whole domain. Wait for its TTL (often 24–48 h).
      Proven by: `dig NEW DS +short` returns nothing.
- [ ] If moving from another DNS host: **lower the TTL** of the records that will change to 300 s, a day
      ahead, so mistakes undo quickly.

## 2. Add the domains in Vercel (before any DNS change)

- [ ] web project → Domains: `NEW` and `www.NEW` (one redirects to the other; pick apex as primary).
- [ ] console project → Domains: `agents.NEW` and `agency.NEW`.
- [ ] admin console project → Domains: `admin.NEW`.
- [ ] Write down the records Vercel shows for each (it may give a project-specific CNAME target; use
      exactly what it shows). Proven by: each domain listed, "Invalid configuration" until DNS is in.

## 3. DNS records in Cloudflare

All Vercel records **DNS only (grey cloud)**: a proxied record stops Vercel issuing the certificate.

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `@` | `76.76.21.21` (or what Vercel shows) | DNS only |
| CNAME | `www` | `cname.vercel-dns.com` (or what Vercel shows) | DNS only |
| CNAME | `agents` | as Vercel shows | DNS only |
| CNAME | `agency` | as Vercel shows | DNS only |
| CNAME | `admin` | as Vercel shows | DNS only |

- [ ] **No AAAA** record for these names (Vercel serves custom domains on IPv4; a stray AAAA stalls SSL).
- [ ] **No stale `_acme-challenge`** TXT from a previous host.
- [ ] **CAA:** none, or one that allows Vercel's issuer (`0 issue "letsencrypt.org"`).
- [ ] **Optional — email replies on `NEW`** (ADR 0016): an MX on a subdomain, e.g. `reply`, with the value
      and priority Resend shows under Receiving, DNS only. Never on the apex (it would take the domain's
      own email). Until then replies keep using the `*.resend.app` address.
- [ ] Cloudflare SSL/TLS mode **Full (strict)** — matters only if anything is ever proxied.

## 4. Switch the nameservers

- [ ] At the registrar, replace the nameservers with the two Cloudflare shows. Proven by:
      `dig NS NEW +short` shows Cloudflare's, and Cloudflare says "Active" (minutes to a day).
- [ ] Vercel: each domain turns valid and gets its certificate. Proven by: `https://NEW`,
      `https://agents.NEW`, `https://agency.NEW`, `https://admin.NEW` load with a valid lock.
- [ ] **DNSSEC back on:** enable it in Cloudflare, add the DS record it gives at the registrar.
      Proven by: `dig NEW DS +short` shows it; dnsviz.net is green.

## 5. Environment variables, then redeploy

On Vercel, Production, for each project that lists it. Values for `NEW`:

| Variable | web | console | admin | Value |
|---|---|---|---|---|
| `NEXT_PUBLIC_WEB_URL` | ✓ | ✓ | ✓ | `https://NEW` |
| `NEXT_PUBLIC_AGENT_URL` | ✓ | ✓ | ✓ | `https://agents.NEW` |
| `NEXT_PUBLIC_AGENCY_URL` | ✓ | ✓ | ✓ | `https://agency.NEW` |
| `NEXT_PUBLIC_ADMIN_URL` | ✓ | ✓ | ✓ | `https://admin.NEW` |
| `COOKIE_DOMAIN` | ✓ | ✓ | ✓ | `.NEW` (leading dot) |
| `PHONE_WEBHOOK_BASE` | ✓ | ✓ |  | `https://NEW` |
| `INTEGRATION_OAUTH_RETURN_BASE` |  | ✓ |  | unset (= the agency URL) |
| `ZOOM_OAUTH_RETURN_BASE` |  | ✓ |  | unset |
| `CONSOLE_SURFACE_OVERRIDE` |  |  | ✓ | unset once `admin.NEW` works |

- [ ] Redeploy all three (env changes reach only new deployments). Proven by: the deployment's env list.
- [ ] **Everyone signs in again** once (the session cookie's domain changed). Tell the agencies first.

## 6. Services that know the domain

- [ ] **Supabase Auth** → URL configuration: Site URL `https://agency.NEW`; Redirect URLs add
      `https://agents.NEW/**`, `https://agency.NEW/**`, `https://admin.NEW/**`, `https://NEW/**`.
      Keep the `OLD` ones until step 9. Proven by: a password reset email's link opens on `NEW`.
- [ ] **Google Cloud** (the one app): OAuth client redirect URI
      `https://agency.NEW/api/integrations/oauth/return`; consent screen authorised domain `NEW`,
      homepage and privacy policy on `NEW`; Maps browser key referrers `https://NEW/*`; Picker key referrers
      `https://agency.NEW/*`, `https://agents.NEW/*`. Proven by: Connect Google Calendar works on `NEW`.
      (Moving to the real domain re-opens Google verification for the new homepage: plan for it.)
- [ ] **Zoom Marketplace**: redirect URL and OAuth allow list on `https://agency.NEW/...`; Deauthorization
      endpoint `https://NEW/api/zoom/webhook` → "Validate" green.
- [ ] **Resend** → Webhooks: the inbound endpoint `https://NEW/api/mail/inbound` (same signing secret).
      Proven by: replying to a console email lands back in its thread.
- [ ] **Twilio** — every agency's numbers still point at `OLD`. With the production env and
      `PHONE_WEBHOOK_BASE=https://NEW`: `pnpm --filter @repo/core phone:repoint`. Proven by: "failed: 0",
      and a text to a test number shows in Inbox → Texts.
- [ ] **Retell** — the agent's webhook URL holds the domain: `pnpm --filter @repo/ai retell:setup`, set the
      printed `RETELL_AGENT_ID` on web and console, redeploy. Proven by: a test AI call's summary arrives.

## 7. Verify (do not assume)

- [ ] Sign in on `agency.NEW`, open `agents.NEW` in the same browser: still signed in. Sign out on one:
      signed out on both.
- [ ] The public site, a listing page, search with a map (browser key), address autocomplete.
- [ ] Bulk email to yourself: the unsubscribe link opens on `NEW` and works.
- [ ] Phone & SMS: a missed call is listed, a text in and out (BX, BY), an AI call (BZ) if Retell is live.
- [ ] Vercel → web → Cron logs: `/api/cron/minute` and `/api/cron/alerts` answer `ok: true` after the deploy.
- [ ] `pnpm smoke` (read-only groups) against production.

## 8. Keep `OLD` working

- [ ] **Do not remove `OLD`.** Emails already sent carry `OLD` links — including unsubscribe links, which
      the Spam Act needs to keep working. Keep `OLD` on the web project as a domain that **redirects (308)
      to `NEW`**, and on the console project the same. Keep it at least 6 months.
- [ ] After a week with no errors: remove the `OLD` redirect URLs from Supabase, Google and Zoom.

## 9. Rollback (if step 7 fails)

1. Vercel env: put the `OLD` values back; redeploy (minutes). `OLD` still works because it was not removed.
2. Twilio: `phone:repoint` again with `PHONE_WEBHOOK_BASE` = the `OLD` web URL.
3. Retell: `RETELL_AGENT_ID` back to the previous agent; redeploy.
4. DNS itself rarely needs undoing; if it does, the registrar's old nameservers (and the low TTLs) bring
   it back within the TTL.

---

Sources checked on 2026-10-30: Vercel's guides to [A records](https://vercel.com/kb/guide/a-record-and-caa-with-vercel)
and [using A records](https://vercel.com/kb/guide/use-domain-vercel-a-records); Resend's
[Cloudflare guide](https://resend.com/docs/guides/dns/cloudflare) and
[verification troubleshooting](https://resend.com/docs/knowledge-base/what-if-my-domain-is-not-verifying);
Cloudflare's [disable DNSSEC](https://developers.cloudflare.com/learning-paths/get-started/add-domain-to-cf/disable-dnssec)
and [DNSSEC](https://developers.cloudflare.com/dns/dnssec/) docs.
