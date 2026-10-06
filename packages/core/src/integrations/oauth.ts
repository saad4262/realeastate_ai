import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { IntegrationError, integrationResource, saveConnection, type GrantedConnection } from './accounts';
import { ProviderError, type Fetch } from './provider-http';
import { stateKey, type TokenKeys } from './crypto';
import { googleAdapter, googleClientFromEnv } from './google-oauth';
import { zoomAdapter, zoomClientFromEnv } from './zoom-oauth';
import {
  PROVIDERS,
  requiredScopes,
  type IntegrationOwnerType,
  type IntegrationProvider,
  type IntegrationStatus,
} from './providers';
import { signState, verifyState, type OAuthState } from './state';

/**
 * OAuth plumbing (ADR 0020), provider-agnostic. One return route,
 * `/api/integrations/oauth/return`, is the only redirect URI ever registered;
 * in dev it is on `localhost` (Google allows plain http only there) and hops
 * to the console host the signed state names, where the session cookie is.
 */

export const RETURN_PATH = '/api/integrations/oauth/return';
export const STUB_PATH = '/integrations/stub';

export type Surface = 'agency' | 'agent';

export type RefreshedTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date | null };

/** What a provider must do: the stub, Google (google-oauth.ts) and Zoom (zoom-oauth.ts). */
export type OAuthAdapter = {
  kind: 'stub' | 'real';
  authorizeUrl(p: { state: string; redirectUri: string; scopes: string[]; surface: Surface; codeChallenge: string }): string;
  exchange(p: { code: string; redirectUri: string; codeVerifier: string }): Promise<GrantedConnection>;
  /** A new access token. Throws ProviderError `revoked` when the refresh token is dead. */
  refresh(refreshToken: string): Promise<RefreshedTokens>;
  /** Tell the provider to forget the grant. Best effort; the caller deletes our copy either way. */
  revoke(token: string): Promise<void>;
};

/**
 * PKCE without storing anything: the verifier is an HMAC of the signed state
 * under the server's state key, so only this server can compute it, and the
 * return route recomputes it from the `state` it is handed.
 */
export function pkceVerifier(state: string, keys: TokenKeys): string {
  return createHmac('sha256', stateKey(keys)).update(`pkce:${state}`).digest('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function consoleUrl(surface: Surface, env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    surface === 'agency'
      ? env.NEXT_PUBLIC_AGENCY_URL?.trim() || 'http://agency.lvh.me:3001'
      : env.NEXT_PUBLIC_AGENT_URL?.trim() || 'http://agents.lvh.me:3001';
  return raw.replace(/\/+$/, '');
}

/**
 * The registered redirect URI: `INTEGRATION_OAUTH_RETURN_BASE` (dev:
 * http://localhost:3001), else the agency console. Zoom may have its own base
 * (`ZOOM_OAUTH_RETURN_BASE`, dev: an https tunnel) — Zoom refuses localhost.
 */
export function returnUri(env: NodeJS.ProcessEnv = process.env, provider?: IntegrationProvider): string {
  const zoomBase = provider === 'zoom' ? env.ZOOM_OAUTH_RETURN_BASE?.trim() : undefined;
  const base = zoomBase || env.INTEGRATION_OAUTH_RETURN_BASE?.trim() || consoleUrl('agency', env);
  return `${base.replace(/\/+$/, '')}${RETURN_PATH}`;
}

/** The stub may run only when asked for, and never in production. */
export function stubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTEGRATIONS_STUB === '1' && env.NODE_ENV !== 'production';
}

/**
 * A pretend provider for dev and tests: its consent page lists the scopes with
 * checkboxes, and its "code" carries what was ticked, so the scope re-check and
 * `permission_missing` can be exercised without Google.
 */
export const stubAdapter = (env: NodeJS.ProcessEnv = process.env): OAuthAdapter => ({
  kind: 'stub',
  authorizeUrl({ state, redirectUri, scopes, surface }) {
    const q = new URLSearchParams({ state, redirect_uri: redirectUri, scope: scopes.join(' ') });
    return `${consoleUrl(surface, env)}${STUB_PATH}?${q.toString()}`;
  },
  async exchange({ code }) {
    const m = /^stub\.([A-Za-z0-9_-]+)$/.exec(code);
    if (!m) throw new IntegrationError('invalid', 'The provider sent back something unexpected');
    let body: { scopes?: unknown; label?: unknown };
    try {
      body = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as typeof body;
    } catch {
      throw new IntegrationError('invalid', 'The provider sent back something unexpected');
    }
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [];
    return {
      accessToken: `stub-access-${randomBytes(16).toString('hex')}`,
      refreshToken: `stub-refresh-${randomBytes(16).toString('hex')}`,
      expiresAt: new Date(Date.now() + 3600_000),
      grantedScopes: scopes,
      accountLabel: typeof body.label === 'string' ? body.label.slice(0, 200) : 'stub account',
    };
  },
  async refresh(refreshToken) {
    // The stub's own "revoked" refresh token, so expiry can be exercised without Google.
    if (refreshToken.startsWith('stub-revoked')) throw new ProviderError('revoked', 'The stub says this connection was revoked');
    return { accessToken: `stub-access-${randomBytes(16).toString('hex')}`, refreshToken: null, expiresAt: new Date(Date.now() + 3600_000) };
  },
  async revoke() {},
});

/** Tokens the stub handed out — they only ever go back to the stub. */
export function isStubToken(token: string): boolean {
  return token.startsWith('stub-');
}

/** The real adapter for a provider, when its client id and secret are set. Sheets and Reviews: not yet. */
export function realAdapterFor(provider: IntegrationProvider, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): OAuthAdapter | null {
  if (provider === 'google_calendar') {
    const client = googleClientFromEnv(env);
    return client ? googleAdapter(client, fetchImpl) : null;
  }
  if (provider === 'zoom') {
    const client = zoomClientFromEnv(env);
    return client ? zoomAdapter(client, fetchImpl) : null;
  }
  return null;
}

/**
 * The adapter for connecting a provider on this server: the real one when it
 * is configured, else the dev stub when that is on, else null ("cannot be
 * connected here yet").
 */
export function adapterFor(provider: IntegrationProvider, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): OAuthAdapter | null {
  return realAdapterFor(provider, env, fetchImpl) ?? (stubEnabled(env) ? stubAdapter(env) : null);
}

/**
 * The adapter that may renew or revoke an EXISTING connection: tokens the
 * stub issued go back to the stub (and only outside production), anything
 * else to the real provider.
 */
export function adapterForTokens(
  provider: IntegrationProvider,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): OAuthAdapter | null {
  if (isStubToken(token)) return stubEnabled(env) ? stubAdapter(env) : null;
  return realAdapterFor(provider, env, fetchImpl);
}

/**
 * Begin connecting: check the person may, sign a state bound to them, and
 * return where to send their browser. Nothing is stored until the return.
 */
export function startConnect(
  actor: Actor,
  keys: TokenKeys,
  p: { provider: IntegrationProvider; ownerType: IntegrationOwnerType; surface: Surface },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!actor.agencyId) throw new IntegrationError('forbidden', 'You may not connect this integration');
  if (!PROVIDERS[p.provider].ownerTypes.includes(p.ownerType)) {
    throw new IntegrationError('invalid', 'That integration cannot be connected at that level');
  }
  const ownerId = p.ownerType === 'user' ? actor.userId : actor.agencyId;
  if (!can(actor, 'integration:manage', integrationResource({ agencyId: actor.agencyId, ownerType: p.ownerType, ownerId }))) {
    throw new IntegrationError('forbidden', p.ownerType === 'agency' ? 'Only an owner or admin connects the agency’s accounts' : 'You may not connect this integration');
  }
  const adapter = adapterFor(p.provider, env);
  if (!adapter) {
    throw new IntegrationError('unavailable', `${PROVIDERS[p.provider].label} cannot be connected on this server yet`);
  }
  const state = signState(
    { provider: p.provider, ownerType: p.ownerType, ownerId, agencyId: actor.agencyId, userId: actor.userId, surface: p.surface },
    keys,
  );
  return adapter.authorizeUrl({
    state,
    redirectUri: returnUri(env, p.provider),
    scopes: requiredScopes(p.provider),
    surface: p.surface,
    codeChallenge: pkceChallenge(pkceVerifier(state, keys)),
  });
}

/** Marks a return that has already been handed over once. Its presence means: never hop again. */
export const HOP_PARAM = 'hopped';

/**
 * The host the BROWSER used. Not `request.nextUrl`: under `next dev` that is
 * built from the server's bind address (always localhost:3001), so on
 * agents.lvh.me the route thought it was still on localhost and redirected to
 * itself forever. A forwarded host (a tunnel, Vercel) wins over Host.
 */
export function browserHost(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  return forwarded || headers.get('host')?.trim() || '';
}

/** `host[:port]`, lower-cased, default port dropped — from a host or a full origin. */
function normalHost(hostOrOrigin: string, protocol: string): string {
  try {
    const url = new URL(hostOrOrigin.includes('://') ? hostOrOrigin : `${protocol}//${hostOrOrigin}`);
    return url.host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Step one of the return route, before any session is looked at: should this
 * request be handed to another host? Only to the console host the SIGNED state
 * names (from the environment, never from the URL) — so it is not an open
 * redirect. Null when this is already the right host, the state is not ours,
 * or this request was already handed over once: it hops AT MOST ONCE, so a
 * host that is misreported can cost a readable error but never a loop.
 */
export function returnHop(
  requestHost: string,
  query: URLSearchParams,
  keys: TokenKeys,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (query.has(HOP_PARAM)) return null;
  const state = verifyState(query.get('state'), keys);
  if (!state) return null;
  const target = new URL(consoleUrl(state.surface, env));
  if (normalHost(requestHost, target.protocol) === target.host.toLowerCase()) return null;
  const forward = new URLSearchParams(query);
  forward.set(HOP_PARAM, '1');
  return `${target.origin}${RETURN_PATH}?${forward.toString()}`;
}

export type ReturnOutcome =
  | { ok: true; provider: IntegrationProvider; status: IntegrationStatus; missingScopes: string[]; surface: Surface }
  | { ok: false; error: string; surface: Surface | null };

/**
 * Step two, on the right host with the session: verify the state, check it is
 * THIS user's, exchange the code (sending the same redirect URI), and store —
 * where the granted scopes are re-checked.
 */
export async function completeConnect(
  db: Db,
  keys: TokenKeys,
  actor: Actor | null,
  query: URLSearchParams,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): Promise<ReturnOutcome> {
  const state: OAuthState | null = verifyState(query.get('state'), keys);
  if (!state) return { ok: false, error: 'That connection link has expired. Start again from Integrations.', surface: null };
  if (!actor || actor.userId !== state.userId || actor.agencyId !== state.agencyId) {
    return { ok: false, error: 'That connection was started by a different account. Sign in as them, or start again.', surface: state.surface };
  }
  if (query.get('error')) {
    return { ok: false, error: `${PROVIDERS[state.provider].label} was not connected — permission was declined.`, surface: state.surface };
  }
  const code = query.get('code');
  const adapter = adapterFor(state.provider, env, fetchImpl);
  if (!code || !adapter) return { ok: false, error: 'The provider did not send a code back.', surface: state.surface };
  try {
    const granted = await adapter.exchange({
      code,
      redirectUri: returnUri(env, state.provider),
      codeVerifier: pkceVerifier(query.get('state')!, keys),
    });
    const saved = await saveConnection(db, keys, actor, state, granted);
    return { ok: true, provider: state.provider, status: saved.status, missingScopes: saved.missingScopes, surface: state.surface };
  } catch (err) {
    // A provider's code is single-use: it is never retried here. A new one
    // only comes from starting over, so say so.
    const reason = err instanceof IntegrationError ? err.message : `Could not connect ${PROVIDERS[state.provider].label}`;
    return { ok: false, error: `${reason.replace(/\.$/, '')}. Connect again.`, surface: state.surface };
  }
}
