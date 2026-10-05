import { randomBytes } from 'node:crypto';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { IntegrationError, integrationResource, saveConnection, type GrantedConnection } from './accounts';
import type { TokenKeys } from './crypto';
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

/** What a provider must do. Google and Zoom implement it in Phase 3b. */
export type OAuthAdapter = {
  kind: 'stub' | 'real';
  authorizeUrl(p: { state: string; redirectUri: string; scopes: string[]; surface: Surface }): string;
  exchange(p: { code: string; redirectUri: string }): Promise<GrantedConnection>;
};

export function consoleUrl(surface: Surface, env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    surface === 'agency'
      ? env.NEXT_PUBLIC_AGENCY_URL?.trim() || 'http://agency.lvh.me:3001'
      : env.NEXT_PUBLIC_AGENT_URL?.trim() || 'http://agents.lvh.me:3001';
  return raw.replace(/\/+$/, '');
}

/** The registered redirect URI: `INTEGRATION_OAUTH_RETURN_BASE` (dev: http://localhost:3001), else the agency console. */
export function returnUri(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.INTEGRATION_OAUTH_RETURN_BASE?.trim() || consoleUrl('agency', env);
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
});

/** The adapter for a provider on this server, or null when it cannot be connected here yet. */
export function adapterFor(_provider: IntegrationProvider, env: NodeJS.ProcessEnv = process.env): OAuthAdapter | null {
  if (stubEnabled(env)) return stubAdapter(env);
  // Real Google and Zoom adapters: Phase 3b.
  return null;
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
  return adapter.authorizeUrl({ state, redirectUri: returnUri(env), scopes: requiredScopes(p.provider), surface: p.surface });
}

/**
 * Step one of the return route, before any session is looked at: should this
 * request be handed to another host? Only to the console host the SIGNED state
 * names (from the environment, never from the URL) — so it is not an open
 * redirect. Null when this is already the right host, or the state is not ours.
 */
export function returnHop(
  requestOrigin: string,
  query: URLSearchParams,
  keys: TokenKeys,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const state = verifyState(query.get('state'), keys);
  if (!state) return null;
  const target = consoleUrl(state.surface, env);
  if (new URL(target).origin === new URL(requestOrigin).origin) return null;
  return `${target}${RETURN_PATH}?${query.toString()}`;
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
  const adapter = adapterFor(state.provider, env);
  if (!code || !adapter) return { ok: false, error: 'The provider did not send a code back.', surface: state.surface };
  try {
    const granted = await adapter.exchange({ code, redirectUri: returnUri(env) });
    const saved = await saveConnection(db, keys, actor, state, granted);
    return { ok: true, provider: state.provider, status: saved.status, missingScopes: saved.missingScopes, surface: state.surface };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof IntegrationError ? err.message : `Could not connect ${PROVIDERS[state.provider].label}.`,
      surface: state.surface,
    };
  }
}
