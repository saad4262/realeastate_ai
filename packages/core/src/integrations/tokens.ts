import { and, eq, ne, sql } from 'drizzle-orm';
import { integrationAccount, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { disconnectIntegration, IntegrationError, integrationResource } from './accounts';
import { decryptToken, encryptToken, type TokenKeys } from './crypto';
import { adapterForTokens, type RefreshedTokens } from './oauth';
import { ProviderError, type Fetch } from './provider-http';
import { PROVIDERS, type IntegrationOwnerType, type IntegrationProvider } from './providers';

/**
 * Using a connection (Phase 3b): a fresh access token, renewed when it is
 * about to lapse or when the provider refuses it, and the account marked
 * `expired` — the card then says "Expired — reconnect" — when the refresh
 * token itself is dead.
 *
 * Two requests may renew the same account at once (Zoom rotates its refresh
 * token, so the loser's old one is already void). The write is therefore a
 * compare-and-swap on the access token's ciphertext: whoever loses reads the
 * winner's token instead of declaring the connection dead.
 *
 * The provider calls happen outside any transaction; each write is one
 * statement.
 */

export type ProviderDeps = { env?: NodeJS.ProcessEnv; fetch?: Fetch; now?: () => Date };

/** Renew this long before the provider's stated expiry. */
export const RENEW_EARLY_MS = 2 * 60 * 1000;

type TokenRow = {
  id: string;
  provider: IntegrationProvider;
  status: string;
  accessEnc: string;
  access: string;
  refresh: string | null;
  expiresAt: Date | null;
};

async function loadTokenRow(db: DbOrTx, keys: TokenKeys, actor: Actor, accountId: string): Promise<TokenRow> {
  const [row] = await db
    .select({
      id: integrationAccount.id,
      agencyId: integrationAccount.agencyId,
      provider: integrationAccount.provider,
      ownerType: integrationAccount.ownerType,
      ownerId: integrationAccount.ownerId,
      status: integrationAccount.status,
      access: integrationAccount.accessTokenEnc,
      refresh: integrationAccount.refreshTokenEnc,
      expiresAt: integrationAccount.tokenExpiresAt,
    })
    .from(integrationAccount)
    .where(eq(integrationAccount.id, accountId))
    .limit(1);
  // The same gate as tokensForUse: your own account, or your agency's.
  if (!row || !can(actor, 'integration:use', integrationResource(row))) {
    throw new IntegrationError('not_found', 'That connection was not found');
  }
  if (!row.access) throw new IntegrationError('unavailable', 'That connection holds no token');
  return {
    id: row.id,
    provider: row.provider as IntegrationProvider,
    status: row.status,
    accessEnc: row.access,
    access: decryptToken(row.access, { rowId: row.id, column: 'access_token' }, keys),
    refresh: row.refresh ? decryptToken(row.refresh, { rowId: row.id, column: 'refresh_token' }, keys) : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
  };
}

/** Mark it expired, with a reason a person can act on. Never a token, never a provider body. */
export async function markExpired(db: DbOrTx, accountId: string, provider: IntegrationProvider): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ status: 'expired', lastError: `${PROVIDERS[provider].label} access was revoked or has expired — reconnect.`, updatedAt: sql`now()` })
    .where(and(eq(integrationAccount.id, accountId), ne(integrationAccount.status, 'expired')));
}

/** Someone else renewed it since we read it? Then theirs is the token to use. */
async function renewedMeanwhile(db: DbOrTx, keys: TokenKeys, row: TokenRow): Promise<string | null> {
  const [now] = await db
    .select({ access: integrationAccount.accessTokenEnc, status: integrationAccount.status })
    .from(integrationAccount)
    .where(eq(integrationAccount.id, row.id))
    .limit(1);
  if (!now?.access || now.access === row.accessEnc || now.status === 'expired') return null;
  return decryptToken(now.access, { rowId: row.id, column: 'access_token' }, keys);
}

async function renew(db: DbOrTx, keys: TokenKeys, row: TokenRow, deps: ProviderDeps): Promise<string> {
  const label = PROVIDERS[row.provider].label;
  if (!row.refresh) {
    await markExpired(db, row.id, row.provider);
    throw new IntegrationError('expired', `${label} needs reconnecting`);
  }
  const adapter = adapterForTokens(row.provider, row.access, deps.env ?? process.env, deps.fetch ?? fetch);
  if (!adapter) throw new IntegrationError('unavailable', `${label} is not set up on this server`);

  let fresh: RefreshedTokens;
  try {
    fresh = await adapter.refresh(row.refresh);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'revoked') {
      const theirs = await renewedMeanwhile(db, keys, row);
      if (theirs) return theirs;
      await markExpired(db, row.id, row.provider);
      throw new IntegrationError('expired', `${label} needs reconnecting`);
    }
    throw new IntegrationError('unavailable', `${label} did not answer — try again shortly`);
  }

  const won = await db
    .update(integrationAccount)
    .set({
      accessTokenEnc: encryptToken(fresh.accessToken, { rowId: row.id, column: 'access_token' }, keys),
      ...(fresh.refreshToken
        ? { refreshTokenEnc: encryptToken(fresh.refreshToken, { rowId: row.id, column: 'refresh_token' }, keys) }
        : {}),
      tokenExpiresAt: fresh.expiresAt,
      updatedAt: sql`now()`,
    })
    .where(and(eq(integrationAccount.id, row.id), eq(integrationAccount.accessTokenEnc, row.accessEnc)))
    .returning({ id: integrationAccount.id });
  if (won.length) return fresh.accessToken;
  // Lost the race: the stored token is the newest one.
  return (await renewedMeanwhile(db, keys, row)) ?? fresh.accessToken;
}

/**
 * Run `use` with a working access token for this account, as `actor` (who
 * must be allowed `integration:use` on it). Renews first when the token is
 * about to lapse, and once more if the provider still says 401.
 *
 * Throws IntegrationError `expired` (reconnect), `unavailable` (try later)
 * or `not_found`; ProviderErrors from `use` itself pass through.
 */
export async function withAccessToken<T>(
  db: DbOrTx,
  keys: TokenKeys,
  actor: Actor,
  accountId: string,
  deps: ProviderDeps,
  use: (accessToken: string) => Promise<T>,
): Promise<T> {
  const row = await loadTokenRow(db, keys, actor, accountId);
  if (row.status === 'expired') {
    throw new IntegrationError('expired', `${PROVIDERS[row.provider].label} needs reconnecting`);
  }
  const now = (deps.now ?? (() => new Date()))().getTime();
  let token = row.access;
  if (row.expiresAt && row.expiresAt.getTime() - now < RENEW_EARLY_MS) token = await renew(db, keys, row, deps);
  try {
    return await use(token);
  } catch (err) {
    if (!(err instanceof ProviderError) || err.kind !== 'unauthorized') throw err;
    // Refused before its time (revoked access token, clock skew): renew once and
    // try again — from a fresh read, in case someone else already renewed it.
    const latest = await loadTokenRow(db, keys, actor, accountId);
    if (latest.access !== token && latest.status !== 'expired') return use(latest.access);
    return use(await renew(db, keys, latest, deps));
  }
}

/** Record a good call on the card ("Last sync"), and clear an old error. */
export async function markUsed(db: DbOrTx, accountId: string): Promise<void> {
  await db
    .update(integrationAccount)
    .set({ lastSyncedAt: sql`now()`, lastError: null })
    .where(and(eq(integrationAccount.id, accountId), eq(integrationAccount.status, 'connected')));
}

/**
 * Disconnect, telling the provider first (best effort, outside any
 * transaction), then deleting our row and every token in it. `revoked` says
 * whether the provider confirmed — if not, the person is told to remove the
 * app in their Google / Zoom account themselves.
 */
export async function disconnectAndRevoke(
  db: DbOrTx,
  keys: TokenKeys | null,
  actor: Actor,
  slot: { provider: IntegrationProvider; ownerType: IntegrationOwnerType },
  deps: ProviderDeps = {},
): Promise<{ removed: boolean; revoked: boolean }> {
  let revoked = false;
  if (keys && actor.agencyId) {
    const ownerId = slot.ownerType === 'user' ? actor.userId : actor.agencyId;
    const [row] = await db
      .select({ id: integrationAccount.id })
      .from(integrationAccount)
      .where(
        and(
          eq(integrationAccount.provider, slot.provider),
          eq(integrationAccount.ownerType, slot.ownerType),
          eq(integrationAccount.ownerId, ownerId),
          eq(integrationAccount.agencyId, actor.agencyId),
        ),
      )
      .limit(1);
    // Only someone who may manage it gets this far with its tokens.
    if (row && can(actor, 'integration:manage', integrationResource({ agencyId: actor.agencyId, ownerType: slot.ownerType, ownerId }))) {
      try {
        const t = await loadTokenRow(db, keys, actor, row.id);
        const adapter = adapterForTokens(t.provider, t.access, deps.env ?? process.env, deps.fetch ?? fetch);
        if (adapter) {
          // Revoking the refresh token ends the whole grant (Google); Zoom takes the access token.
          await adapter.revoke(t.provider === 'zoom' ? t.access : (t.refresh ?? t.access));
          revoked = true;
        }
      } catch {
        revoked = false; // a dead token or an unreachable provider — delete ours anyway
      }
    }
  }
  const { removed } = await disconnectIntegration(db, actor, slot);
  return { removed, revoked };
}
