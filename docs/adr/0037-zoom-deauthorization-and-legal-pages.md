# 0037 — Zoom deauthorization endpoint, and the legal pages

**Status:** ACCEPTED, 2026-10-12. Asked by the user for the Zoom Marketplace production review.

- **Endpoint:** `POST /api/zoom/webhook` on apps/web (the public site, outside the middleware
  matcher, like the Resend inbound webhook). It is the app's "Deauthorization Notification
  Endpoint URL" (Zoom: App listing → Links & Support). Logic in `packages/core/src/integrations/zoom-webhook.ts`.
- **Verification:** every request needs `x-zm-signature` = `v0=` + hex HMAC-SHA256 (key: the app's
  Secret Token, `ZOOM_WEBHOOK_SECRET_TOKEN`) over `v0:<x-zm-request-timestamp>:<raw body>`, timestamp
  within 5 minutes. No secret → 503 (Zoom retries 5xx); bad signature → 401. `endpoint.url_validation`
  is answered with `{ plainToken, encryptedToken }`.
- **Deauthorization deletes** every `integration_account` row with provider `zoom` and that Zoom user
  id: the person's own and any agency's, in any agency. Zoom ended the grant already, so there is
  nothing to revoke. Appointments keep their saved meeting link (an agency record); a later sync
  sees "Connect Zoom first", as after a disconnect. A deauthorization for another client id is ignored.
- **Zoom user id stored:** migration 0043 adds `integration_account.external_account_id` (from
  `/users/me` `id` at connect) + index (provider, external_account_id). Rows connected before it are
  null and the notice cannot find them; reconnect them. If a notice is lost (Zoom does not retry 4xx),
  the next token refresh fails and the row already shows "Expired — reconnect".
- **Not done:** Zoom's legacy Data Compliance API call (no current Zoom doc requires it for General apps);
  Zoom sends deauthorization notices only for published apps, so the real event is first seen in production.
- **Legal pages:** `/privacy-policy` and `/terms-of-service` on apps/web, `(legal)` route group. Bracketed
  placeholders in `app/(legal)/legal.ts`; the text is a draft for a lawyer to review, written to match
  what the code does (scopes, encrypted tokens, the deletion above).
