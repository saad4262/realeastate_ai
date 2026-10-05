# 0020 — Integrations: tokens encrypted by the app, one OAuth return route that hops hosts

**Status:** accepted for the plumbing, 2026-10-05. Migration 0024. CRM Phase 4. No real
provider is connected yet: a dev-only stub provider exercises the whole flow.

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

**NOT SURE (for the user).** One Google OAuth app for Calendar + Sheets + Reviews
(incremental scopes) or three; Zoom's redirect rules for http/localhost (verify in 3b);
exact scope names (verify against provider docs in 3b — listed provisionally); whether
read-only members may connect their own calendar (decided: no).
