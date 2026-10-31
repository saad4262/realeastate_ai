import { and, eq, sql } from 'drizzle-orm';
import { integrationAccount, integrationChoice, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { IntegrationError, integrationResource, resolveIntegration } from './accounts';
import type { IntegrationOwnerType, IntegrationProvider } from './providers';

/**
 * Which connected mailbox / calendar is ACTIVE (ADR 0076). A person (or the agency) may connect both Google's
 * and Microsoft's, and uses one of each:
 *   - the one they chose, while it is still connected — even expired: it is never silently swapped for the
 *     other (fail closed; the screens say "reconnect");
 *   - else the only one connected;
 *   - else, both connected and nothing chosen, Google's. That only arises when both were connected at once:
 *     connecting a second one records the first as chosen (`saveConnection`), so it never switches by itself.
 * Disconnecting the chosen one forgets the choice, so what is left becomes active.
 */

export const PURPOSES = ['mail', 'calendar'] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Each purpose's providers, Google's first (the default when both are connected and none is chosen). */
export const PURPOSE_PROVIDERS: Record<Purpose, readonly IntegrationProvider[]> = {
  mail: ['gmail', 'outlook_mail'],
  calendar: ['google_calendar', 'outlook_calendar'],
};

export function purposeOf(provider: IntegrationProvider): Purpose | null {
  return (Object.keys(PURPOSE_PROVIDERS) as Purpose[]).find((p) => PURPOSE_PROVIDERS[p].includes(provider)) ?? null;
}

/** Pure: of one owner's accounts for one purpose, the active one (or null when none is connected). */
export function pickActive<T extends { provider: IntegrationProvider }>(accounts: readonly T[], chosen: IntegrationProvider | null, purpose: Purpose): T | null {
  const mine = accounts.filter((a) => PURPOSE_PROVIDERS[purpose].includes(a.provider));
  if (chosen) {
    const c = mine.find((a) => a.provider === chosen);
    if (c) return c;
  }
  if (mine.length <= 1) return mine[0] ?? null;
  for (const p of PURPOSE_PROVIDERS[purpose]) {
    const a = mine.find((x) => x.provider === p);
    if (a) return a;
  }
  return null;
}

/** The owner's choice for a purpose, or null. One statement. */
export async function chosenProvider(db: DbOrTx, agencyId: string, ownerType: IntegrationOwnerType, ownerId: string, purpose: Purpose): Promise<IntegrationProvider | null> {
  const [r] = await db
    .select({ provider: integrationChoice.provider })
    .from(integrationChoice)
    .where(and(eq(integrationChoice.agencyId, agencyId), eq(integrationChoice.ownerType, ownerType), eq(integrationChoice.ownerId, ownerId), eq(integrationChoice.purpose, purpose)))
    .limit(1);
  return (r?.provider as IntegrationProvider | undefined) ?? null;
}

/**
 * "Use this one instead": make a connected provider the active one for its purpose. The same permission as
 * connecting it (`integration:manage`): a person for their own, an owner or admin for the agency's.
 */
export async function setActiveProvider(
  db: DbOrTx,
  actor: Actor,
  slot: { provider: IntegrationProvider; ownerType: IntegrationOwnerType },
): Promise<{ purpose: Purpose }> {
  if (!actor.agencyId) throw new IntegrationError('forbidden', 'You may not change this');
  const purpose = purposeOf(slot.provider);
  if (!purpose) throw new IntegrationError('invalid', 'Only a mailbox or a calendar can be made the active one');
  const ownerId = slot.ownerType === 'user' ? actor.userId : actor.agencyId;
  if (!can(actor, 'integration:manage', integrationResource({ agencyId: actor.agencyId, ownerType: slot.ownerType, ownerId }))) {
    throw new IntegrationError('forbidden', 'You may not change this');
  }
  const [acct] = await db
    .select({ id: integrationAccount.id })
    .from(integrationAccount)
    .where(and(eq(integrationAccount.agencyId, actor.agencyId), eq(integrationAccount.provider, slot.provider), eq(integrationAccount.ownerType, slot.ownerType), eq(integrationAccount.ownerId, ownerId)))
    .limit(1);
  if (!acct) throw new IntegrationError('invalid', 'Connect it first, then make it the one you use');
  await db
    .insert(integrationChoice)
    .values({ agencyId: actor.agencyId, ownerType: slot.ownerType, ownerId, purpose, provider: slot.provider, chosenBy: actor.userId })
    .onConflictDoUpdate({
      target: [integrationChoice.agencyId, integrationChoice.ownerType, integrationChoice.ownerId, integrationChoice.purpose],
      set: { provider: slot.provider, chosenBy: actor.userId, updatedAt: sql`now()` },
    });
  return { purpose };
}

/** Disconnecting the chosen provider forgets the choice (in the disconnect's own transaction). */
export async function forgetChoice(db: DbOrTx, agencyId: string, ownerType: IntegrationOwnerType, ownerId: string, provider: IntegrationProvider): Promise<void> {
  await db
    .delete(integrationChoice)
    .where(and(eq(integrationChoice.agencyId, agencyId), eq(integrationChoice.ownerType, ownerType), eq(integrationChoice.ownerId, ownerId), eq(integrationChoice.provider, provider)));
}

/**
 * The actor's OWN active provider for a purpose, and what `resolveIntegration` says of it (usable account,
 * or why not). With nothing connected: Google's provider, `not_connected`. Two statements.
 */
export async function resolveActive(db: DbOrTx, actor: Actor, purpose: Purpose) {
  const accounts = actor.agencyId
    ? await db
        .select({ provider: integrationAccount.provider })
        .from(integrationAccount)
        .where(and(eq(integrationAccount.agencyId, actor.agencyId), eq(integrationAccount.ownerType, 'user'), eq(integrationAccount.ownerId, actor.userId)))
    : [];
  const chosen = actor.agencyId ? await chosenProvider(db, actor.agencyId, 'user', actor.userId, purpose) : null;
  const active = pickActive(accounts.map((a) => ({ provider: a.provider as IntegrationProvider })), chosen, purpose);
  const provider = active?.provider ?? PURPOSE_PROVIDERS[purpose][0]!;
  return { provider, ...(await resolveIntegration(db, actor, provider)) };
}
