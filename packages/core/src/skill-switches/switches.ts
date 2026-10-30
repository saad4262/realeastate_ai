import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { skillSwitch, user, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor, type MembershipRole } from '../permissions';
import { platformSkill, skillOffMessage, skillsForHolder, type PlatformSkill, type SkillKey, type SwitchHolder } from './catalog';

/**
 * The platform skills' switches (ADR 0058). No row = OFF (ADR 0069): a skill runs only once its holder
 * has switched it on. The agency's switch (`user_id` null) is its owners' and admins'; every other
 * member has their own. Neither overrides the other, and a switch never widens anything — each skill
 * still works only within `can()`.
 */

/** Of the skills a holder has, the ones not switched on. Pure: a missing row is off. */
export function skillsOffOf(holder: SwitchHolder, onKeys: ReadonlySet<string>): SkillKey[] {
  return skillsForHolder(holder)
    .map((s) => s.key)
    .filter((k) => !onKeys.has(k));
}

export class SkillSwitchError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'SkillSwitchError';
  }
}

export function holderOf(role: MembershipRole | null | undefined): SwitchHolder {
  return isAgencyAdminRole(role) ? 'agency' : 'personal';
}

/** The `can()` resource for a person's own switches. */
function resourceFor(actor: Actor) {
  return { type: 'skill_switch', agencyId: actor.agencyId, ...(holderOf(actor.membershipRole) === 'personal' ? { ownerId: actor.userId } : {}) };
}

/** Rows of one holder: the agency's (user null) or one member's. */
function holderWhere(actor: Actor) {
  return and(
    eq(skillSwitch.agencyId, actor.agencyId as string),
    holderOf(actor.membershipRole) === 'agency' ? isNull(skillSwitch.userId) : eq(skillSwitch.userId, actor.userId),
  );
}

export type SkillSwitchView = PlatformSkill & {
  on: boolean;
  /** Who last changed it and when; null while it has never been switched (off until then). */
  changedBy: string | null;
  changedAt: Date | null;
  /** A `pair` skill seen by an agent: whether the agency has it on too (both are needed). */
  agencyOn?: boolean;
};

/**
 * A `pair` skill (ADR 0069 §4) runs for this person only when the agency's switch is on and — for anyone
 * but an owner or admin, whose switch IS the agency's — their own too. Pure: the switched-on rows in.
 */
export function pairedSkillOn(rows: readonly { userId: string | null; enabled: boolean }[], userId: string, role: MembershipRole | null | undefined): boolean {
  const agencyOn = rows.some((r) => r.userId === null && r.enabled);
  if (!agencyOn || !role) return false;
  return isAgencyAdminRole(role) || rows.some((r) => r.userId === userId && r.enabled);
}

/** For a machine path (a webhook): is this `pair` skill on for this member of this agency? */
export async function isPairedSkillOn(db: DbOrTx, agencyId: string, userId: string, role: MembershipRole | null | undefined, key: SkillKey): Promise<boolean> {
  const rows = await db
    .select({ userId: skillSwitch.userId, enabled: skillSwitch.enabled })
    .from(skillSwitch)
    .where(and(eq(skillSwitch.agencyId, agencyId), eq(skillSwitch.skillKey, key), or(isNull(skillSwitch.userId), eq(skillSwitch.userId, userId))));
  return pairedSkillOn(rows, userId, role);
}

/** The switches this person holds, in catalog order. */
export async function listSkillSwitches(db: DbOrTx, actor: Actor): Promise<{ holder: SwitchHolder; skills: SkillSwitchView[] }> {
  if (!actor.agencyId || !can(actor, 'skill_switch:read', resourceFor(actor))) throw new SkillSwitchError('forbidden', 'You do not have access to Skills.');
  const holder = holderOf(actor.membershipRole);
  const rows = await db
    .select({ key: skillSwitch.skillKey, enabled: skillSwitch.enabled, at: skillSwitch.updatedAt, by: sql<string | null>`coalesce(${user.name}, ${user.email})` })
    .from(skillSwitch)
    .leftJoin(user, eq(user.id, skillSwitch.changedBy))
    .where(holderWhere(actor));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // An agent's `pair` skills also need the agency's switch: say which way the agency has it.
  const pairKeys = holder === 'personal' ? skillsForHolder(holder).filter((s) => s.pair).map((s) => s.key) : [];
  const agencyOnKeys = new Set(
    pairKeys.length
      ? (
          await db
            .select({ key: skillSwitch.skillKey })
            .from(skillSwitch)
            .where(and(eq(skillSwitch.agencyId, actor.agencyId), isNull(skillSwitch.userId), eq(skillSwitch.enabled, true), inArray(skillSwitch.skillKey, pairKeys)))
        ).map((r) => r.key)
      : [],
  );
  return {
    holder,
    skills: skillsForHolder(holder).map((s) => {
      const r = byKey.get(s.key);
      return { ...s, on: r ? r.enabled : false, changedBy: r?.by ?? null, changedAt: r?.at ?? null, ...(s.pair && holder === 'personal' ? { agencyOn: agencyOnKeys.has(s.key) } : {}) };
    }),
  };
}

/**
 * Has this person's holder switched this skill on? No row = off (ADR 0069). An `agency` skill is not
 * one an agent holds, so it never gates them (their role already keeps them from what it does).
 */
export async function isSkillOn(db: DbOrTx, actor: Actor, key: SkillKey): Promise<boolean> {
  if (!actor.agencyId) return false;
  const holder = holderOf(actor.membershipRole);
  if (!skillsForHolder(holder).some((s) => s.key === key)) return true;
  const [row] = await db
    .select({ enabled: skillSwitch.enabled })
    .from(skillSwitch)
    .where(and(holderWhere(actor), eq(skillSwitch.skillKey, key)))
    .limit(1);
  return row?.enabled === true;
}

/** Throws the refusal the person sees when the skill is off. */
export async function requireSkillOn(db: DbOrTx, actor: Actor, key: SkillKey): Promise<void> {
  if (!(await isSkillOn(db, actor, key))) throw new SkillSwitchError('forbidden', skillOffMessage(key, holderOf(actor.membershipRole)));
}

export async function setSkillSwitch(db: DbOrTx, actor: Actor, key: SkillKey, on: boolean): Promise<void> {
  if (!actor.agencyId || !can(actor, 'skill_switch:manage', resourceFor(actor))) {
    throw new SkillSwitchError('forbidden', 'You may not change these switches.');
  }
  const holder = holderOf(actor.membershipRole);
  if (!skillsForHolder(holder).some((s) => s.key === key)) throw new SkillSwitchError('not_found', `“${platformSkill(key).name}” is not one of your skills.`);
  const userId = holder === 'agency' ? null : actor.userId;
  // The conflict target is the unique index's own expressions (agency, coalesce(user, 0), key).
  await db.execute(sql`
    insert into skill_switch (agency_id, user_id, skill_key, enabled, changed_by)
    values (${actor.agencyId}, ${userId}, ${key}, ${on}, ${actor.userId})
    on conflict (agency_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), skill_key)
    do update set enabled = excluded.enabled, changed_by = excluded.changed_by, updated_at = now()`);
}

/**
 * For the hourly scan: of these people, which have which skills off. One statement for all of them.
 * Returns `${agencyId}|${userId}|${key}` for every skill that is off for that person.
 */
export async function skillsOffFor(
  db: DbOrTx,
  people: readonly { agencyId: string; userId: string; role: MembershipRole | null | undefined }[],
): Promise<Set<string>> {
  const off = new Set<string>();
  if (!people.length) return off;
  const agencies = [...new Set(people.map((p) => p.agencyId))];
  // The switches that are ON; everything else a holder has is off (ADR 0069).
  const rows = await db
    .select({ agencyId: skillSwitch.agencyId, userId: skillSwitch.userId, key: skillSwitch.skillKey })
    .from(skillSwitch)
    .where(and(inArray(skillSwitch.agencyId, agencies), eq(skillSwitch.enabled, true)));
  const agencyOn = new Map<string, Set<string>>();
  const personalOn = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = r.userId ? `${r.agencyId}|${r.userId}` : r.agencyId;
    const map = r.userId ? personalOn : agencyOn;
    map.set(k, (map.get(k) ?? new Set()).add(r.key));
  }
  for (const p of people) {
    const holder = holderOf(p.role);
    const on = (holder === 'agency' ? agencyOn.get(p.agencyId) : personalOn.get(`${p.agencyId}|${p.userId}`)) ?? new Set<string>();
    for (const key of skillsOffOf(holder, on)) off.add(`${p.agencyId}|${p.userId}|${key}`);
  }
  return off;
}

/** Every skill this person has off, in one read — what one assistant turn checks its tools against. */
export async function skillsOffForActor(db: DbOrTx, actor: Actor): Promise<ReadonlySet<SkillKey>> {
  if (!actor.agencyId) return new Set();
  const rows = await db
    .select({ key: skillSwitch.skillKey })
    .from(skillSwitch)
    .where(and(holderWhere(actor), eq(skillSwitch.enabled, true)));
  return new Set(skillsOffOf(holderOf(actor.membershipRole), new Set(rows.map((r) => r.key))));
}
