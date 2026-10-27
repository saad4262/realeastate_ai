import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { skillSwitch, user, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor, type MembershipRole } from '../permissions';
import { platformSkill, skillOffMessage, skillsForHolder, type PlatformSkill, type SkillKey, type SwitchHolder } from './catalog';

/**
 * The platform skills' switches (ADR 0058). A row is an exception: no row = on. The agency's switch
 * (`user_id` null) is its owners' and admins'; every other member has their own. Neither overrides the
 * other, and a switch never widens anything — each skill still works only within `can()`.
 */

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
  /** Who last changed it and when; null while it has never been changed (on by default). */
  changedBy: string | null;
  changedAt: Date | null;
};

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
  return {
    holder,
    skills: skillsForHolder(holder).map((s) => {
      const r = byKey.get(s.key);
      return { ...s, on: r ? r.enabled : true, changedBy: r?.by ?? null, changedAt: r?.at ?? null };
    }),
  };
}

/**
 * Is this skill on for this person? An `agency` skill is not one an agent holds, so it never gates
 * them (their role already keeps them from what it does). Fails open only on that, never on an error.
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
  return row ? row.enabled : true;
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
  const rows = await db
    .select({ agencyId: skillSwitch.agencyId, userId: skillSwitch.userId, key: skillSwitch.skillKey })
    .from(skillSwitch)
    .where(and(inArray(skillSwitch.agencyId, agencies), eq(skillSwitch.enabled, false)));
  if (!rows.length) return off;
  const agencyOff = new Map<string, Set<string>>();
  const personalOff = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = r.userId ? `${r.agencyId}|${r.userId}` : r.agencyId;
    const map = r.userId ? personalOff : agencyOff;
    map.set(k, (map.get(k) ?? new Set()).add(r.key));
  }
  for (const p of people) {
    const keys = holderOf(p.role) === 'agency' ? agencyOff.get(p.agencyId) : personalOff.get(`${p.agencyId}|${p.userId}`);
    for (const key of keys ?? []) off.add(`${p.agencyId}|${p.userId}|${key}`);
  }
  return off;
}

/** Every skill this person has off, in one read — what one assistant turn checks its tools against. */
export async function skillsOffForActor(db: DbOrTx, actor: Actor): Promise<ReadonlySet<SkillKey>> {
  if (!actor.agencyId) return new Set();
  const rows = await db
    .select({ key: skillSwitch.skillKey })
    .from(skillSwitch)
    .where(and(holderWhere(actor), eq(skillSwitch.enabled, false)));
  const visible = new Set(skillsForHolder(holderOf(actor.membershipRole)).map((s) => s.key));
  return new Set(rows.map((r) => r.key as SkillKey).filter((k) => visible.has(k)));
}
