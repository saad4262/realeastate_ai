import { IntegrationError } from './accounts';
import type { OAuthAdapter } from './oauth';
import { call, expiresAtFrom, form, ProviderError, scopeList, str, type Fetch } from './provider-http';

/**
 * Microsoft sign-in for Outlook mail and calendar (ADR 0076; the identity platform's OAuth 2.0 authorization
 * code flow, checked on learn.microsoft.com 2026-10-31):
 *  - the `common` tenant: work/school (Microsoft 365) and personal (Outlook.com) accounts alike;
 *  - a confidential web app: client secret, plus PKCE (S256) as Microsoft recommends;
 *  - a refresh token only with `offline_access`; EVERY refresh returns a new one that replaces the old
 *    (tokens.ts stores whatever comes back);
 *  - a dead refresh token answers 400 `invalid_grant`.
 * There is no endpoint to revoke one app's delegated grant: disconnecting deletes our copy, and the person
 * removes the app under their Microsoft account's app permissions (the card says so).
 */

export const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

export type MicrosoftClient = { clientId: string; clientSecret: string };

export function microsoftClientFromEnv(env: NodeJS.ProcessEnv = process.env): MicrosoftClient | null {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Who signed in, from the id_token that came straight from Microsoft's token endpoint over TLS (not
 * re-verified, as Google's). `email` when the account has one; personal accounts often only have
 * `preferred_username`.
 */
export function accountFromIdToken(idToken: string | null): string | null {
  const body = idToken?.split('.')[1];
  if (!body) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { email?: unknown; preferred_username?: unknown };
    const v = typeof claims.email === 'string' && claims.email ? claims.email : typeof claims.preferred_username === 'string' ? claims.preferred_username : null;
    return v ? v.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function microsoftAdapter(client: MicrosoftClient, fetchImpl: Fetch = fetch): OAuthAdapter {
  const token = (fields: Record<string, string>) =>
    call(fetchImpl, 'Microsoft sign-in', MICROSOFT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: client.clientId, client_secret: client.clientSecret, ...fields }),
    });
  return {
    kind: 'real',
    authorizeUrl({ state, redirectUri, scopes, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: client.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: scopes.join(' '),
        state,
        // Lets a person with several Microsoft accounts pick the right one; consent is asked when needed.
        prompt: 'select_account',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${MICROSOFT_AUTHORIZE_URL}?${q.toString()}`;
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const { json } = await token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }).catch((err: unknown) => {
        throw new IntegrationError('invalid', err instanceof ProviderError ? `Microsoft refused the sign-in: ${err.message}` : 'Microsoft refused the sign-in');
      });
      const accessToken = str(json?.access_token);
      if (!json || !accessToken) throw new IntegrationError('invalid', 'Microsoft sent back something unexpected');
      return {
        accessToken,
        refreshToken: str(json.refresh_token),
        expiresAt: expiresAtFrom(json),
        grantedScopes: scopeList(json.scope),
        accountLabel: accountFromIdToken(str(json.id_token)),
      };
    },
    async refresh(refreshToken) {
      try {
        const { json } = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
        const accessToken = str(json?.access_token);
        if (!json || !accessToken) throw new ProviderError('failed', 'Microsoft sent back something unexpected');
        // Microsoft rotates: the new refresh token replaces the old one.
        return { accessToken, refreshToken: str(json.refresh_token), expiresAt: expiresAtFrom(json) };
      } catch (err) {
        // 400 invalid_grant (and 401 invalid_client): this grant is over.
        if (err instanceof ProviderError && (err.status === 400 || err.status === 401)) {
          throw new ProviderError('revoked', 'Microsoft says this connection was revoked or has expired', err.status);
        }
        throw err;
      }
    },
    async revoke() {
      // No per-app revocation for delegated grants (see the header): say so, so the screen tells the person to
      // remove the app under their Microsoft account. Our copy is deleted by the caller either way.
      throw new ProviderError('failed', 'Microsoft has no way for an app to revoke its own access');
    },
  };
}
