import { and, eq, or, sql } from 'drizzle-orm';
import { integrationAccount, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor, type Resource } from '../permissions';
import { decryptToken, encryptToken, type TokenKeys } from './crypto';
import {
  missingScopes,
  PROVIDERS,
  type IntegrationOwnerType,
  type IntegrationProvider,
  type IntegrationStatus,
} from './providers';

/**
 * Connected accounts (ADR 0020). Every read that can reach a screen selects
 * the SAFE columns only — the token columns are named in exactly two places in
 * this file: the write after a connection, and `tokensForUse`, which asks
 * can() first and is never called by a page.
 */

export class IntegrationError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'unavailable' | 'expired';
  constructor(code: IntegrationError['code'], message: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
  }
}

export type IntegrationState = IntegrationStatus | 'not_connected';

/** One account as a screen may see it. No tokens, ever. */
export type IntegrationAccountView = {
  id: string;
  provider: IntegrationProvider;
  ownerType: IntegrationOwnerType;
  accountLabel: string | null;
  grantedScopes: string[];
  /** The stored status, or `expired` once a token has lapsed with nothing to renew it. */
  state: IntegrationStatus;
  missingScopes: string[];
  lastSyncedAt: Date | null;
  lastError: string | null;
  connectedAt: Date;
  /**
   * An agency account whose connecting person has since left the agency
   * (ADR 0030 §5.4): it still works; an admin should reconnect it with an
   * account the agency controls. Reconnecting clears it.
   */
  connectorLeft: boolean;
};

const SAFE = {
  id: integrationAccount.id,
  agencyId: integrationAccount.agencyId,
  provider: integrationAccount.provider,
  ownerType: integrationAccount.ownerType,
  ownerId: integrationAccount.ownerId,
  accountLabel: integrationAccount.externalAccountLabel,
  grantedScopes: integrationAccount.grantedScopes,
  status: integrationAccount.status,
  lastSyncedAt: integrationAccount.lastSyncedAt,
  lastError: integrationAccount.lastError,
  tokenExpiresAt: integrationAccount.tokenExpiresAt,
  connectorLeftAt: integrationAccount.connectorLeftAt,
  /** Whether a refresh token is held — a boolean, computed in SQL; the token stays put. */
  canRenew: sql<boolean>`${integrationAccount.refreshTokenEnc} is not null`,
  createdAt: integrationAccount.createdAt,
};

type SafeRow = {
  id: string;
  agencyId: string;
  provider: string;
  ownerType: string;
  ownerId: string;
  accountLabel: string | null;
  grantedScopes: string[] | null;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  tokenExpiresAt: Date | null;
  connectorLeftAt: Date | null;
  canRenew: boolean | string;
  createdAt: Date;
};

export function integrationResource(a: { agencyId: string; ownerType: string; ownerId: string; id?: string }): Resource {
  return {
    type: 'integration',
    ...(a.id ? { id: a.id } : {}),
    agencyId: a.agencyId,
    integrationOwnerType: a.ownerType as IntegrationOwnerType,
    ownerId: a.ownerId,
  };
}

function toView(r: SafeRow, now: Date): IntegrationAccountView {
  const provider = r.provider as IntegrationProvider;
  const granted = r.grantedScopes ?? [];
  const canRenew = r.canRenew === true || r.canRenew === 't';
  const lapsed = r.tokenExpiresAt !== null && new Date(r.tokenExpiresAt).getTime() < now.getTime() && !canRenew;
  return {
    id: r.id,
    provider,
    ownerType: r.ownerType as IntegrationOwnerType,
    accountLabel: r.accountLabel,
    grantedScopes: granted,
    state: r.status === 'connected' && lapsed ? 'expired' : (r.status as IntegrationStatus),
    missingScopes: missingScopes(provider, granted),
    lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt) : null,
    lastError: r.lastError,
    connectorLeft: r.connectorLeftAt !== null,
    connectedAt: new Date(r.createdAt),
  };
}

/** The accounts this actor may see: their own user-level ones and their agency's. One statement. */
async function visibleRows(db: DbOrTx, actor: Actor): Promise<SafeRow[]> {
  if (!actor.agencyId) return [];
  return (await db
    .select(SAFE)
    .from(integrationAccount)
    .where(
      and(
        eq(integrationAccount.agencyId, actor.agencyId),
        or(
          and(eq(integrationAccount.ownerType, 'user'), eq(integrationAccount.ownerId, actor.userId)),
          and(eq(integrationAccount.ownerType, 'agency'), eq(integrationAccount.ownerId, actor.agencyId)),
        ),
      ),
    )) as SafeRow[];
}

export type IntegrationSlot = {
  provider: IntegrationProvider;
  ownerType: IntegrationOwnerType;
  account: IntegrationAccountView | null;
  /** Decided by can(): may this actor connect / disconnect THIS slot. */
  mayManage: boolean;
};

/**
 * The settings page: one slot per provider and owner type this actor may see
 * (their own, and the agency's), connected or not.
 */
export async function listIntegrationSlots(db: Db, actor: Actor, now = new Date()): Promise<IntegrationSlot[]> {
  if (!actor.agencyId) throw new IntegrationError('forbidden', 'You do not have permission to view integrations');
  if (!can(actor, 'integration:read', { type: 'integration', agencyId: actor.agencyId })) {
    throw new IntegrationError('forbidden', 'You do not have permission to view integrations');
  }
  const rows = await visibleRows(db, actor);
  const slots: IntegrationSlot[] = [];
  for (const provider of Object.keys(PROVIDERS) as IntegrationProvider[]) {
    for (const ownerType of PROVIDERS[provider].ownerTypes) {
      const ownerId = ownerType === 'user' ? actor.userId : actor.agencyId;
      const resource = integrationResource({ agencyId: actor.agencyId, ownerType, ownerId });
      if (!can(actor, 'integration:read', resource)) continue;
      const row = rows.find((r) => r.provider === provider && r.ownerType === ownerType);
      slots.push({
        provider,
        ownerType,
        account: row ? toView(row, now) : null,
        mayManage: can(actor, 'integration:manage', resource),
      });
    }
  }
  return slots;
}

export type IntegrationRequirement = {
  provider: IntegrationProvider;
  /** `connected` only when there is an account, unexpired, with every scope. */
  state: IntegrationState;
  /** Which account would be used — the actor's own, or the agency's. */
  ownerType: IntegrationOwnerType | null;
  accountLabel: string | null;
  missingScopes: string[];
  /** Whether this actor could fix it themselves (connect their own, or an admin the agency's). */
  mayConnect: boolean;
};

export type IntegrationCheck = {
  ok: boolean;
  results: IntegrationRequirement[];
  /** The providers that are not usable, in the order asked. */
  missing: IntegrationProvider[];
};

/**
 * "Is X usable for this person?" — what a button, a skill or the AI asks
 * before it relies on a provider (ADR 0020). Never guesses: anything short of
 * a connected account with every scope is reported, and the caller says
 * "Connect X first".
 *
 * Which account applies follows the provider's owner order: Zoom is the
 * agent's own, else the agency's; a calendar is only ever the person's own;
 * reviews only the agency's. One statement, however many providers are asked.
 */
export async function requireIntegrations(
  db: DbOrTx,
  actor: Actor,
  providers: readonly IntegrationProvider[],
  now = new Date(),
): Promise<IntegrationCheck> {
  const rows = actor.agencyId ? await visibleRows(db, actor) : [];
  const results = providers.map((provider) => pick(rows, actor, provider, now).requirement);
  const missing = results.filter((r) => r.state !== 'connected').map((r) => r.provider);
  return { ok: missing.length === 0, results, missing };
}

/** One provider's answer, and — for the server only — which account row it is. */
function pick(rows: SafeRow[], actor: Actor, provider: IntegrationProvider, now: Date): { requirement: IntegrationRequirement; accountId: string | null } {
  const order = PROVIDERS[provider].ownerTypes;
  const found = order
    .map((ownerType) => rows.find((r) => r.provider === provider && r.ownerType === ownerType))
    .filter((r): r is SafeRow => Boolean(r))
    .map((r) => toView(r, now));
  // A usable account wins; otherwise the first one that exists explains why not.
  const usable = found.find((v) => v.state === 'connected' && v.missingScopes.length === 0);
  const shown = usable ?? found[0] ?? null;
  const mayConnect = order.some((ownerType) =>
    actor.agencyId
      ? can(actor, 'integration:manage', integrationResource({
          agencyId: actor.agencyId,
          ownerType,
          ownerId: ownerType === 'user' ? actor.userId : actor.agencyId,
        }))
      : false,
  );
  return {
    requirement: {
      provider,
      state: usable ? 'connected' : shown ? (shown.missingScopes.length && shown.state === 'connected' ? 'permission_missing' : shown.state) : 'not_connected',
      ownerType: shown?.ownerType ?? null,
      accountLabel: shown?.accountLabel ?? null,
      missingScopes: shown?.missingScopes ?? [],
      mayConnect,
    },
    accountId: usable?.id ?? null,
  };
}

/**
 * For the server's own use (appointment sync): the account `actor` would use
 * for this provider — their own, else the agency's, by the provider's order —
 * or null with the reason. The id never reaches a page.
 */
export async function resolveIntegration(
  db: DbOrTx,
  actor: Actor,
  provider: IntegrationProvider,
  now = new Date(),
): Promise<{ accountId: string | null; requirement: IntegrationRequirement }> {
  const rows = actor.agencyId ? await visibleRows(db, actor) : [];
  return pick(rows, actor, provider, now);
}

/** What a provider handed back after the person approved. */
export type GrantedConnection = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  grantedScopes: string[];
  accountLabel: string | null;
};

/**
 * Store a connection the return route verified. The status is decided HERE
 * from the scopes actually granted — a person can untick one on the consent
 * screen, and then it is `permission_missing`, not `connected`.
 *
 * Tokens are encrypted with the row's own id as part of the authenticated
 * data, so the row is written first (without tokens) and the tokens second,
 * in one transaction.
 */
export async function saveConnection(
  db: Db,
  keys: TokenKeys,
  actor: Actor,
  target: { provider: IntegrationProvider; ownerType: IntegrationOwnerType; ownerId: string; agencyId: string },
  granted: GrantedConnection,
): Promise<{ id: string; status: IntegrationStatus; missingScopes: string[] }> {
  if (!PROVIDERS[target.provider].ownerTypes.includes(target.ownerType)) {
    throw new IntegrationError('invalid', 'That integration cannot be connected at that level');
  }
  if (!can(actor, 'integration:manage', integrationResource(target))) {
    throw new IntegrationError('forbidden', 'You may not connect this integration');
  }
  const missing = missingScopes(target.provider, granted.grantedScopes);
  const status: IntegrationStatus = missing.length ? 'permission_missing' : 'connected';

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(integrationAccount)
      .values({
        agencyId: target.agencyId,
        provider: target.provider,
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        externalAccountLabel: granted.accountLabel,
        grantedScopes: granted.grantedScopes,
        status,
        lastError: missing.length ? `Not granted: ${missing.join(', ')}` : null,
        tokenExpiresAt: granted.expiresAt,
        connectedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: [integrationAccount.provider, integrationAccount.ownerType, integrationAccount.ownerId],
        set: {
          externalAccountLabel: granted.accountLabel,
          grantedScopes: granted.grantedScopes,
          status,
          lastError: missing.length ? `Not granted: ${missing.join(', ')}` : null,
          tokenExpiresAt: granted.expiresAt,
          connectedBy: actor.userId,
          // Reconnected by someone in the agency now: the "connected by a person who left" flag goes.
          connectorLeftAt: null,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: integrationAccount.id });
    const id = row!.id;
    await tx
      .update(integrationAccount)
      .set({
        accessTokenEnc: encryptToken(granted.accessToken, { rowId: id, column: 'access_token' }, keys),
        refreshTokenEnc: granted.refreshToken
          ? encryptToken(granted.refreshToken, { rowId: id, column: 'refresh_token' }, keys)
          : null,
      })
      .where(eq(integrationAccount.id, id));
    return { id, status, missingScopes: missing };
  });
}

/**
 * Disconnect: the row goes, and with it every token. Telling Google / Zoom
 * first is `disconnectAndRevoke` (tokens.ts), which ends here.
 */
export async function disconnectIntegration(
  db: DbOrTx,
  actor: Actor,
  slot: { provider: IntegrationProvider; ownerType: IntegrationOwnerType },
): Promise<{ removed: boolean }> {
  if (!actor.agencyId) throw new IntegrationError('forbidden', 'You may not disconnect this integration');
  const ownerId = slot.ownerType === 'user' ? actor.userId : actor.agencyId;
  if (!can(actor, 'integration:manage', integrationResource({ agencyId: actor.agencyId, ownerType: slot.ownerType, ownerId }))) {
    throw new IntegrationError('forbidden', 'You may not disconnect this integration');
  }
  const gone = await db
    .delete(integrationAccount)
    .where(
      and(
        eq(integrationAccount.provider, slot.provider),
        eq(integrationAccount.ownerType, slot.ownerType),
        eq(integrationAccount.ownerId, ownerId),
        eq(integrationAccount.agencyId, actor.agencyId),
      ),
    )
    .returning({ id: integrationAccount.id });
  return { removed: gone.length > 0 };
}

/**
 * The tokens, decrypted, for the SERVER to call a provider on this actor's
 * behalf (Phase 3b). `integration:use` first: a person's own account, or the
 * agency's for any member. Never passed to a page or an action's result.
 */
export async function tokensForUse(
  db: Db,
  keys: TokenKeys,
  actor: Actor,
  accountId: string,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date | null }> {
  const [row] = await db
    .select({
      id: integrationAccount.id,
      agencyId: integrationAccount.agencyId,
      ownerType: integrationAccount.ownerType,
      ownerId: integrationAccount.ownerId,
      access: integrationAccount.accessTokenEnc,
      refresh: integrationAccount.refreshTokenEnc,
      expiresAt: integrationAccount.tokenExpiresAt,
    })
    .from(integrationAccount)
    .where(eq(integrationAccount.id, accountId))
    .limit(1);
  if (!row || !can(actor, 'integration:use', integrationResource(row))) {
    throw new IntegrationError('not_found', 'That connection was not found');
  }
  if (!row.access) throw new IntegrationError('unavailable', 'That connection holds no token');
  return {
    accessToken: decryptToken(row.access, { rowId: row.id, column: 'access_token' }, keys),
    refreshToken: row.refresh ? decryptToken(row.refresh, { rowId: row.id, column: 'refresh_token' }, keys) : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
  };
}
