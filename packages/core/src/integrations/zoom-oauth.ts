import { IntegrationError } from './accounts';
import type { OAuthAdapter } from './oauth';
import { basicAuth, call, expiresAtFrom, form, ProviderError, scopeList, str, type Fetch } from './provider-http';

/**
 * Zoom sign-in (Phase 3b; Zoom's "OAuth 2.0" integration guide, checked
 * 2026-10-06):
 *  - token calls authenticate with HTTP Basic `client_id:client_secret`;
 *  - scopes are configured on the app in the Marketplace, not in the URL —
 *    what was granted comes back in the token response and is re-checked;
 *  - access tokens last an hour; refresh tokens 90 days and ROTATE: every
 *    refresh returns a new one and the old one stops working, so the new one
 *    is stored at once (`tokens.ts` does it as a compare-and-swap);
 *  - Zoom refuses `localhost` redirects for apps with a secret — dev uses an
 *    https tunnel (`ZOOM_OAUTH_RETURN_BASE`).
 */

export const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
export const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
export const ZOOM_REVOKE_URL = 'https://zoom.us/oauth/revoke';
export const ZOOM_API = 'https://api.zoom.us/v2';

export type ZoomClient = { clientId: string; clientSecret: string };

export function zoomClientFromEnv(env: NodeJS.ProcessEnv = process.env): ZoomClient | null {
  const clientId = env.ZOOM_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.ZOOM_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function zoomAdapter(client: ZoomClient, fetchImpl: Fetch = fetch): OAuthAdapter {
  const tokenCall = (body: Record<string, string | undefined>) =>
    call(fetchImpl, 'Zoom sign-in', ZOOM_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(client.clientId, client.clientSecret) },
      body: form(body),
    });

  return {
    kind: 'real',
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${ZOOM_AUTHORIZE_URL}?${q.toString()}`;
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const { json } = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }).catch(
        (err: unknown) => {
          throw new IntegrationError('invalid', err instanceof ProviderError ? `Zoom refused the sign-in: ${err.message}` : 'Zoom refused the sign-in');
        },
      );
      const accessToken = str(json?.access_token);
      if (!json || !accessToken) throw new IntegrationError('invalid', 'Zoom sent back something unexpected');
      // Which account it is, for the card. Not worth failing the connection over.
      const me = await call(fetchImpl, 'Zoom', `${ZOOM_API}/users/me`, { headers: { authorization: `Bearer ${accessToken}` } }).catch(() => null);
      return {
        accessToken,
        refreshToken: str(json.refresh_token),
        expiresAt: expiresAtFrom(json),
        grantedScopes: scopeList(json.scope),
        accountLabel: str(me?.json?.email)?.slice(0, 200) ?? null,
      };
    },
    async refresh(refreshToken) {
      try {
        const { json } = await tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
        const accessToken = str(json?.access_token);
        if (!json || !accessToken) throw new ProviderError('failed', 'Zoom sent back something unexpected');
        return { accessToken, refreshToken: str(json.refresh_token), expiresAt: expiresAtFrom(json) };
      } catch (err) {
        // 400/401 from the token endpoint: the refresh token is invalid, expired or revoked.
        if (err instanceof ProviderError && (err.status === 400 || err.status === 401)) {
          throw new ProviderError('revoked', 'Zoom says this connection was revoked or has expired', err.status);
        }
        throw err;
      }
    },
    async revoke(token) {
      await call(fetchImpl, 'Zoom sign-in', ZOOM_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(client.clientId, client.clientSecret) },
        body: form({ token }),
      }, [400, 401]);
    },
  };
}
