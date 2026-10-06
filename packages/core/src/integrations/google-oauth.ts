import { IntegrationError } from './accounts';
import type { OAuthAdapter } from './oauth';
import { call, expiresAtFrom, form, ProviderError, scopeList, str, type Fetch } from './provider-http';

/**
 * Google sign-in for Calendar (Phase 3b; Google's "OAuth 2.0 for web server
 * applications"). Checked against Google's documentation on 2026-10-06:
 *  - `access_type=offline` + `prompt=consent` → a refresh token every time;
 *  - PKCE (S256) on top of the client secret;
 *  - NOT `include_granted_scopes`: each connection's token carries only what
 *    that connection asked for (Sheets, later, asks for its own);
 *  - a dead refresh token answers 400 `invalid_grant`. In Testing mode that
 *    happens after about 7 days — the card then says "Expired — reconnect".
 */

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export type GoogleClient = { clientId: string; clientSecret: string };

export function googleClientFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleClient | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The email in an id_token. It came straight from Google's token endpoint over TLS, so it is not re-verified. */
function emailFromIdToken(idToken: string | null): string | null {
  const body = idToken?.split('.')[1];
  if (!body) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function googleAdapter(client: GoogleClient, fetchImpl: Fetch = fetch): OAuthAdapter {
  return {
    kind: 'real',
    authorizeUrl({ state, redirectUri, scopes, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${GOOGLE_AUTHORIZE_URL}?${q.toString()}`;
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const { json } = await call(fetchImpl, 'Google sign-in', GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
      }).catch((err: unknown) => {
        throw new IntegrationError('invalid', err instanceof ProviderError ? `Google refused the sign-in: ${err.message}` : 'Google refused the sign-in');
      });
      const accessToken = str(json?.access_token);
      if (!json || !accessToken) throw new IntegrationError('invalid', 'Google sent back something unexpected');
      return {
        accessToken,
        refreshToken: str(json.refresh_token),
        expiresAt: expiresAtFrom(json),
        grantedScopes: scopeList(json.scope),
        accountLabel: emailFromIdToken(str(json.id_token)),
      };
    },
    async refresh(refreshToken) {
      try {
        const { json } = await call(fetchImpl, 'Google sign-in', GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
        });
        const accessToken = str(json?.access_token);
        if (!json || !accessToken) throw new ProviderError('failed', 'Google sent back something unexpected');
        // Google keeps the same refresh token unless it says otherwise.
        return { accessToken, refreshToken: str(json.refresh_token), expiresAt: expiresAtFrom(json) };
      } catch (err) {
        // 400 invalid_grant (and 401 invalid_client): this grant is over.
        if (err instanceof ProviderError && (err.status === 400 || err.status === 401)) {
          throw new ProviderError('revoked', 'Google says this connection was revoked or has expired', err.status);
        }
        throw err;
      }
    },
    async revoke(token) {
      await call(fetchImpl, 'Google sign-in', GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ token }),
      }, [400]); // 400: already revoked — the outcome we wanted.
    },
  };
}
