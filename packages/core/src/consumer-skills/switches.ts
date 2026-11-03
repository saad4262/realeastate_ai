import { and, eq, inArray, sql } from 'drizzle-orm';
import { consumerSkillSwitch, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  CONSUMER_SKILLS,
  consumerSkill,
  consumerSkillBlock,
  consumerSkillDefault,
  isSwitchable,
  pausedConsumerSkills,
  type ConsumerSkill,
  type ConsumerSkillBlock,
  type ConsumerSkillKey,
} from './catalog';

/**
 * A buyer's consumer-skill switches (ADR 0080). A row exists only where the buyer changed the default;
 * a visitor who is not signed in has no rows and gets the defaults. A switch never widens anything —
 * every skill still works only within `can()`.
 */

export class ConsumerSkillError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ConsumerSkillError';
  }
}

type Env = Record<string, string | undefined>;

export type ConsumerSkillView = ConsumerSkill & {
  on: boolean;
  /** The buyer's own choice — what they set, or the default while they never changed it — whatever the platform paused. */
  chosen: boolean;
  /** Why it is not running; null when it is. */
  block: ConsumerSkillBlock | null;
  /** When the buyer last changed it; null while it is on its default. */
  changedAt: Date | null;
};

/** The stored switches of one buyer, keyed by skill. One read. */
async function storedSwitches(db: DbOrTx, userId: string) {
  const rows = await db
    .select({ key: consumerSkillSwitch.skillKey, enabled: consumerSkillSwitch.enabled, at: consumerSkillSwitch.updatedAt })
    .from(consumerSkillSwitch)
    .where(eq(consumerSkillSwitch.userId, userId));
  return new Map(rows.map((r) => [r.key, r]));
}

/**
 * Every skill that is not running for this visitor, and why — what one chat turn checks its tools
 * against. `null` actor: not signed in, so no read at all.
 */
export async function consumerSkillBlocks(db: DbOrTx, actor: Actor | null, env: Env = process.env): Promise<ReadonlyMap<ConsumerSkillKey, ConsumerSkillBlock>> {
  const stored = actor?.userId ? await storedSwitches(db, actor.userId) : new Map<string, { enabled: boolean }>();
  const paused = pausedConsumerSkills(env);
  const blocks = new Map<ConsumerSkillKey, ConsumerSkillBlock>();
  for (const s of CONSUMER_SKILLS) {
    const block = consumerSkillBlock(s.key, stored.get(s.key)?.enabled, Boolean(actor?.userId), paused);
    if (block) blocks.set(s.key, block);
  }
  return blocks;
}

/** Is this skill running for this visitor? */
export async function isConsumerSkillOn(db: DbOrTx, actor: Actor | null, key: ConsumerSkillKey, env: Env = process.env): Promise<boolean> {
  return !(await consumerSkillBlocks(db, actor, env)).has(key);
}

/** The Skills page: every skill in catalog order, with this buyer's state. */
export async function listConsumerSkills(db: DbOrTx, actor: Actor, env: Env = process.env): Promise<ConsumerSkillView[]> {
  if (!can(actor, 'consumer_skill:read', { type: 'consumer_skill', ownerId: actor.userId })) {
    throw new ConsumerSkillError('forbidden', 'Sign in to see your Skills.');
  }
  const stored = await storedSwitches(db, actor.userId);
  const paused = pausedConsumerSkills(env);
  return CONSUMER_SKILLS.map((s) => {
    const r = stored.get(s.key);
    const block = consumerSkillBlock(s.key, r?.enabled, true, paused);
    return { ...s, on: block === null, chosen: r?.enabled ?? consumerSkillDefault(s.key), block, changedAt: r?.at ?? null };
  });
}

/** Flip one of the buyer's own switches. Only a built skill has one. */
export async function setConsumerSkill(db: DbOrTx, actor: Actor, key: ConsumerSkillKey, on: boolean): Promise<void> {
  if (!can(actor, 'consumer_skill:manage', { type: 'consumer_skill', ownerId: actor.userId })) {
    throw new ConsumerSkillError('forbidden', 'Sign in to change your Skills.');
  }
  if (!isSwitchable(key)) throw new ConsumerSkillError('not_found', `“${consumerSkill(key).name}” is not available yet.`);
  await db
    .insert(consumerSkillSwitch)
    .values({ userId: actor.userId, skillKey: key, enabled: on })
    .onConflictDoUpdate({
      target: [consumerSkillSwitch.userId, consumerSkillSwitch.skillKey],
      set: { enabled: on, updatedAt: sql`now()` },
    });
}

/**
 * For a background job: of these buyers, the ones with this skill not running (switched off, or paused
 * for everyone). One statement for all of them. Signed-in by construction — a job only knows accounts.
 */
export async function usersWithConsumerSkillOff(db: DbOrTx, userIds: readonly string[], key: ConsumerSkillKey, env: Env = process.env): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  if (pausedConsumerSkills(env).has(key) || !isSwitchable(key)) return new Set(userIds);
  const rows = await db
    .select({ userId: consumerSkillSwitch.userId, enabled: consumerSkillSwitch.enabled })
    .from(consumerSkillSwitch)
    .where(and(inArray(consumerSkillSwitch.userId, [...userIds]), eq(consumerSkillSwitch.skillKey, key)));
  const stored = new Map(rows.map((r) => [r.userId, r.enabled]));
  return new Set(userIds.filter((id) => consumerSkillBlock(key, stored.get(id), true, new Set()) !== null));
}
