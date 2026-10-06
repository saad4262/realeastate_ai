# 0020 — Integrations: tokens encrypted by the app, one OAuth return route that hops hosts

**Status:** accepted, 2026-10-05 (plumbing, migration 0024, CRM Phase 4). **Real Google
Calendar and Zoom built 2026-10-06 (Phase 3b, migration 0027)** — see "Phase 3b" below. Sheets
and Reviews still run on the stub only.

**Context.** Agents and agencies will connect Google Calendar, Zoom, Google Sheets and
Google Business Profile (reviews). We must hold OAuth tokens safely, let every feature ask
"is X connected for this person?", and survive a real constraint: Google accepts a plain-
`http` redirect URI only for `localhost`, while dev runs on `agency.lvh.me` /
`agents.lvh.me` and the session cookie lives on `.lvh.me` — a cookie `localhost` never sees.

**Decision.**
1. **One table, `integration_account`**: provider, owner_type (`user` | `agency`),
   owner_id (the user's or the agency's id), agency_id, account label, granted scopes,
   status (`connected` | `expired` | `error` | `permission_missing`), last sync, last
   error, and encrypted access token, refresh token and expiry. No row = not connected.
   One row per (provider, owner_type, owner_id). Which owner types a provider allows is
   in code (`integrations/providers.ts`) and in a CHECK: Google Calendar per user, Google
   Reviews per agency, Zoom and Sheets either.
2. **Encryption in the app, key from the environment.** AES-256-GCM (node:crypto), a
   fresh 96-bit IV per value, and the row id + column name as additional authenticated
   data — a ciphertext copied into another row or column fails to decrypt. Stored as
   `v1.<keyId>.<iv>.<tag>.<ciphertext>`. The key is `INTEGRATION_TOKEN_KEY` (32 bytes,
   base64); `INTEGRATION_TOKEN_KEY_PREVIOUS` is accepted for decryption during a
   rotation. Never in the database, never logged: errors carry no values, and no
   function returns a token outside packages/core. Not Supabase Vault: its key is held
   by the database, and the rule here is that a database dump alone opens nothing.
3. **Server only (ADR 0017).** RLS on, no policies, no grants: the browser keys cannot read
   the table at all. Even through the server, every read used by a screen leaves the
   token columns out; decryption is a separate function that asks `can()` first.
4. **Permissions.** `integration:read` — see status: your own user-level accounts, and
   your agency's agency-level ones (an agent must see "agency Zoom is connected").
   `integration:manage` — connect/disconnect: your own user-level ones (not read-only
   members); agency-level ones only owner/admin. `integration:use` — the server may use
   the tokens on your behalf: your own user-level; agency-level for any active member
   (an agent scheduling on the agency's Zoom). Nobody reads another user's tokens.
5. **`requireIntegrations(actor, providers)`** answers per provider which account applies
   (Zoom: the agent's own, else the agency's — the earlier decision; Calendar: own;
   Reviews: agency; Sheets: own, else agency) and its state, including
   `not_connected` and an expired token. Buttons, skills and the AI all ask it; the UI
   shows "Connect X first" with a Connect button.
6. **OAuth plumbing.**
   - **State:** HMAC-signed (key derived from `INTEGRATION_TOKEN_KEY` by HKDF, separate
     from the token key), 10-minute expiry, carrying provider, owner type/id, the
     user's id, the console surface, and a nonce. It is bound to the user: the final
     step refuses unless the signed-in user is the one in the state.
   - **One return route, `/api/integrations/oauth/return`**, is the only redirect URI
     ever registered, built as `INTEGRATION_OAUTH_RETURN_BASE` + that path (default: the
     agency console URL). **In dev** that base is `http://localhost:3001`. The route is
     public (no session on localhost); when the request's host is not the console host
     named in the signed state, it does nothing but 302 to that host — chosen from
     `NEXT_PUBLIC_AGENCY_URL` / `NEXT_PUBLIC_AGENT_URL` only, never from the URL, so it
     is not an open redirect — keeping the query. On the right host, with the session
     cookie, it verifies the state, exchanges the code (sending the same redirect URI),
     **re-checks the granted scopes** (a person can untick one on the consent screen →
     `permission_missing`), encrypts and stores. **In production** the base is the
     console's own https host, so the hop never happens; one code path for both.
   - The code travels through one extra redirect in dev only; it is single-use and
     useless without the client secret.
7. **Stub provider (dev only).** With `INTEGRATIONS_STUB=1` and outside production, every
   provider's Connect goes to a local consent page that lists the scopes with
   checkboxes (untick one to test `permission_missing`) and returns a stub code through
   the same return route. Real adapters (Google, Zoom) arrive in Phase 3b behind the same
   interface.

**Alternatives.** A tunnel (ngrok) with https on lvh.me — external service, changing URLs.
`localhost` as the dev console host — breaks the shared `.lvh.me` session (ADR 0003).
Storing tokens unencrypted behind RLS — a dump or a mistaken grant leaks them.

**Decided (client/PM, 2026-10-05) — replaces the earlier NOT SURE list. Recorded, not built (Phase 3b).**
- **Google:** ONE Google Cloud app for Calendar, Sheets and Reviews; permissions requested
  incrementally (each when its feature is first connected). Until Google verifies the app it
  stays in Testing: only listed test users can connect, and their tokens expire after about
  7 days (the integrations page must show "Expired — reconnect"). Verification needs a real
  domain, a homepage and a privacy policy — so it waits for the domain (after testing).
- **Least privilege:** Sheets must reach ONLY the file the person picks (Google Picker with
  the per-file `drive.file` scope), never all of Drive or every sheet —
  `spreadsheets.readonly` in `integrations/providers.ts` is provisional and changes in 3b.
  Calendar: events only. All scope names verified against Google's docs in 3b.
- **Zoom:** each agent connects their own Zoom; an owner/admin connects the agency's Zoom
  (the "own, else agency" fallback stays). Letting accounts outside our own Zoom account
  connect needs the app approved/published on the Zoom Marketplace — check Zoom's docs in
  3b. Zoom's redirect rules for http/localhost are checked then too; a tunnel is used for
  Zoom only, if Zoom refuses localhost.
- **Read-only members** cannot connect any account (implemented).

**Phase 3b — real Google Calendar and Zoom (built 2026-10-06, migration 0027).**
Checked against Google's and Zoom's documentation on 2026-10-06.
1. **Configuration.** `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `ZOOM_OAUTH_CLIENT_ID`/`_SECRET`
   (server-only; half a pair refuses to start). A provider with both set is real; otherwise
   the dev stub when `INTEGRATIONS_STUB=1`; otherwise "cannot be connected here yet". Tokens
   the stub issued only ever go back to the stub, never in production.
2. **Scopes (least privilege).** Google Calendar: `calendar.events.owned` (narrower than
   `calendar.events`: only calendars the person owns, still create/change/delete/read our
   events) + `openid email` for the account label. Google returns `email` as
   `…/userinfo.email`; both spellings count. No `include_granted_scopes`: each connection's
   token carries only its own scopes. Zoom (granular, user-level, set on the app):
   `meeting:write:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`,
   `user:read:user`. No `:admin` scopes.
3. **Redirects.** Google: `http://localhost:3001/api/integrations/oauth/return` in dev (Google
   allows http only for localhost). **Zoom refuses `localhost`, and `127.0.0.1` only for public
   PKCE clients** — ours has a secret — so in dev Zoom alone returns through an https tunnel:
   `ZOOM_OAUTH_RETURN_BASE`. The return route hops to the console host as before.
4. **PKCE on both, with no storage:** the verifier is an HMAC of the signed state under the
   state key, recomputed at the return.
5. **Renewal and expiry** (`tokens.ts` `withAccessToken`): renew 2 minutes before expiry and
   once more on a 401. Google keeps its refresh token; **Zoom rotates it** (the old one dies),
   so the write is a compare-and-swap on the access-token ciphertext, and the loser of a race
   uses the winner's token. A refresh answered 400/401 (`invalid_grant`) marks the account
   `expired` → "Expired — reconnect"; a 5xx/timeout is "try again", not expiry.
6. **Disconnect** revokes at the provider first (best effort), then deletes our row; the page
   says so if the provider did not confirm.
7. **Appointments mirror out, never in** (`appointments/sync.ts`). Our row is the truth. After
   every change (marked `pending` in the change's own transaction) the console runs
   `syncAppointment`, acting AS the assigned agent: their own Google Calendar; their own Zoom,
   else the agency's. Zoom first (create on booking for type Zoom without a pasted link; move
   on reschedule; delete on cancel), then Calendar (create / move / "✓ title" on complete /
   delete on cancel). The Google event id is derived from the appointment id, and one run at
   a time holds the row (`sync_claimed_at`), so a double submit makes one event and one
   meeting. **No attendees and `sendUpdates=none`: Google never emails the contact** — our
   approved invitation stays the way to tell them.
8. **Read-back without webhooks** (no public domain yet): the 5-minute cron re-runs syncs a
   crash left `pending`, and calls `events.get` with the stored ETag for each event WE created
   for an upcoming appointment (60 days ahead, each at most every 5 minutes) — 304 when
   unchanged, and nothing else in the person's calendar is read. Sync tokens were not used:
   they stream every change in the whole calendar, personal events included, through our
   server. A moved or deleted event is **flagged** (`calendar_sync_state = 'conflict'`, what
   Google shows in `calendar_conflict`), never copied: the agent chooses "Keep ours" (push
   back) or "Use Google's time" (an ordinary reschedule, on the timeline). Later, with a
   domain: Google push notifications instead of polling.
9. **Zoom secrets.** Only the meeting id and the participants' join link are kept. The host's
   `start_url` and the `password` fields are dropped on arrival. The join link (which carries
   Zoom's embedded passcode) is the one participants need: it is visible only to who can read
   the appointment (its agent, who booked it, admins) and goes to the contact only through the
   approved invitation.
10. **Failure shows, with Retry.** A sync problem never undoes the change: the card says
    "Google Calendar — not synced: <reason>" / "Zoom — …" with Retry (whoever may change the
    appointment). Booking type Zoom with no usable Zoom and no pasted link is refused with
    "Connect Zoom first" — in the Schedule panel and again on the server.

**Known limits / NOT SURE.** A process killed between Zoom creating a meeting and our row
storing it leaves one orphan meeting in the host's Zoom (rare; nothing else breaks). Events
are not removed from Google when a calendar is disconnected (the connection that could do it
is gone). When Sheets arrives on the same Google app, disconnecting one Google connection may
revoke the other's grant — to check then. Zoom Marketplace publishing (other companies' Zoom
accounts) and Google verification wait for the domain.
