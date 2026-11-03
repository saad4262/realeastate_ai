import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { buyerProfile, chatMessage, consumerSkillSwitch, listing, property, propertyWatch, searchSchedule, shortlist, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { pausedConsumerSkills } from '../consumer-skills/catalog';
import { savedSearchQuerySchema } from '../listings/search-url';
import { deriveProfile, profileOverridesSchema, type FilterSignal, type ProfileFacts, type ProfileOverrides, type Signals } from './derive';

/**
 * Personal Property AI (ADR 0080, C4 decision 5; the user's rules, 2026-11-03): learns only from the buyer's own
 * explicit actions, every fact editable with its source, a working "Forget everything", no demographic field at all,
 * and blind to agencies — `buyer_profile:read/manage` are the owner's only.
 *
 * Learning starts when the buyer switches it on (the switch row's time) or when they last forgot, whichever is later:
 * nothing done while it was off, or before a forget, is ever learnt.
 */

export const MAX_SIGNALS = 200;

export class ProfileError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'invalid' | 'off',
    message: string,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

function require(actor: Actor, action: 'buyer_profile:read' | 'buyer_profile:manage') {
  if (!can(actor, action, { type: 'buyer_profile', ownerId: actor.userId })) throw new ProfileError('forbidden', 'Sign in to see your profile.');
}

export type ProfileView = { on: false } | { on: true; learningSince: Date; facts: ProfileFacts };

/** When learning began: the switch turned on, or the last forget, whichever is later. Null while it is off. */
async function learningSince(db: DbOrTx, userId: string, env: Record<string, string | undefined>): Promise<{ since: Date; overrides: ProfileOverrides } | null> {
  if (pausedConsumerSkills(env).has('personal_profile')) return null;
  const [[sw], [row]] = await Promise.all([
    db.select({ at: consumerSkillSwitch.updatedAt }).from(consumerSkillSwitch).where(and(eq(consumerSkillSwitch.userId, userId), eq(consumerSkillSwitch.skillKey, 'personal_profile'), eq(consumerSkillSwitch.enabled, true))).limit(1),
    db.select({ forgottenAt: buyerProfile.forgottenAt, overrides: buyerProfile.overrides }).from(buyerProfile).where(eq(buyerProfile.userId, userId)).limit(1),
  ]);
  if (!sw) return null;
  const since = row?.forgottenAt && row.forgottenAt > sw.at ? row.forgottenAt : sw.at;
  const parsed = profileOverridesSchema.safeParse(row?.overrides ?? {});
  return { since, overrides: parsed.success ? parsed.data : {} };
}

const asFilter = (q: unknown, at: Date): FilterSignal | null => {
  const parsed = savedSearchQuerySchema.partial().passthrough().safeParse(q);
  if (!parsed.success) return null;
  const v = parsed.data as Record<string, unknown>;
  return {
    at,
    ...(typeof v.suburb === 'string' ? { suburb: v.suburb } : {}),
    ...(v.channel === 'sale' || v.channel === 'rent' ? { channel: v.channel } : {}),
    ...(typeof v.priceTo === 'number' ? { priceTo: v.priceTo } : {}),
    ...(typeof v.bedrooms === 'number' ? { bedrooms: v.bedrooms } : {}),
    ...(typeof v.propertyType === 'string' ? { propertyType: v.propertyType } : {}),
  };
};

/** The buyer's own actions since learning began. Four reads, each bounded. */
export async function profileSignals(db: DbOrTx, userId: string, since: Date): Promise<Signals> {
  const [saved, chats, listed, watched] = await Promise.all([
    db.select({ query: searchSchedule.query, at: searchSchedule.createdAt }).from(searchSchedule).where(and(eq(searchSchedule.userId, userId), gte(searchSchedule.createdAt, since))).orderBy(desc(searchSchedule.createdAt)).limit(MAX_SIGNALS),
    db
      .select({ searches: chatMessage.searches, at: chatMessage.createdAt })
      .from(chatMessage)
      .where(and(eq(chatMessage.userId, userId), isNotNull(chatMessage.searches), gte(chatMessage.createdAt, since)))
      .orderBy(desc(chatMessage.createdAt))
      .limit(MAX_SIGNALS),
    db
      .select({ at: shortlist.createdAt, suburb: property.suburb, channel: sql<string>`${listing.channel}::text`, propertyType: listing.propertyType })
      .from(shortlist)
      .innerJoin(listing, eq(listing.id, shortlist.listingId))
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(and(eq(shortlist.userId, userId), gte(shortlist.createdAt, since)))
      .limit(MAX_SIGNALS),
    db.select({ at: propertyWatch.createdAt, suburb: property.suburb }).from(propertyWatch).innerJoin(property, eq(property.id, propertyWatch.propertyId)).where(and(eq(propertyWatch.userId, userId), gte(propertyWatch.createdAt, since))).limit(MAX_SIGNALS),
  ]);
  return {
    savedSearches: saved.flatMap((s) => {
      const f = asFilter(s.query, s.at);
      return f ? [f] : [];
    }),
    // A chat turn's `searches` are the filters the guide actually ran for this buyer (its citations).
    chats: chats.flatMap((m) => (Array.isArray(m.searches) ? (m.searches as { query?: unknown }[]).flatMap((c) => { const f = asFilter(c?.query, m.at); return f ? [f] : []; }) : [])),
    shortlisted: listed.map((l) => ({ at: l.at, suburb: l.suburb, channel: l.channel, propertyType: l.propertyType })),
    watched: watched.map((w) => ({ at: w.at, suburb: w.suburb })),
  };
}

export async function loadProfile(db: DbOrTx, actor: Actor, env: Record<string, string | undefined> = process.env): Promise<ProfileView> {
  require(actor, 'buyer_profile:read');
  const state = await learningSince(db, actor.userId, env);
  if (!state) return { on: false };
  return { on: true, learningSince: state.since, facts: deriveProfile(await profileSignals(db, actor.userId, state.since), state.overrides) };
}

/** Set or remove one or more fields. A field set to null is removed by the buyer; `undefined` leaves it learnt. */
export async function editProfile(db: DbOrTx, actor: Actor, patch: unknown): Promise<void> {
  require(actor, 'buyer_profile:manage');
  const parsed = profileOverridesSchema.safeParse(patch);
  if (!parsed.success) throw new ProfileError('invalid', 'That change could not be saved.');
  const [row] = await db.select({ overrides: buyerProfile.overrides }).from(buyerProfile).where(eq(buyerProfile.userId, actor.userId)).limit(1);
  const current = profileOverridesSchema.safeParse(row?.overrides ?? {});
  const next = { ...(current.success ? current.data : {}), ...parsed.data };
  await db
    .insert(buyerProfile)
    .values({ userId: actor.userId, overrides: next })
    .onConflictDoUpdate({ target: buyerProfile.userId, set: { overrides: next, updatedAt: sql`now()` } });
}

/** Give a field back to learning: drop the buyer's edit for it. */
export async function resetProfileField(db: DbOrTx, actor: Actor, field: keyof ProfileOverrides): Promise<void> {
  require(actor, 'buyer_profile:manage');
  const [row] = await db.select({ overrides: buyerProfile.overrides }).from(buyerProfile).where(eq(buyerProfile.userId, actor.userId)).limit(1);
  if (!row) return;
  const current = profileOverridesSchema.safeParse(row.overrides);
  const next = { ...(current.success ? current.data : {}) };
  delete next[field];
  await db.update(buyerProfile).set({ overrides: next, updatedAt: sql`now()` }).where(eq(buyerProfile.userId, actor.userId));
}

/**
 * Forget everything: nothing done before now is learnt again, and the buyer's edits go. Their saved searches,
 * shortlist and watches are their own features and stay — the page says so; only the profile forgets them.
 */
export async function forgetProfile(db: DbOrTx, actor: Actor): Promise<void> {
  require(actor, 'buyer_profile:manage');
  await db
    .insert(buyerProfile)
    .values({ userId: actor.userId, forgottenAt: sql`now()` as unknown as Date, overrides: {} })
    .onConflictDoUpdate({ target: buyerProfile.userId, set: { forgottenAt: sql`now()`, overrides: {}, updatedAt: sql`now()` } });
}
