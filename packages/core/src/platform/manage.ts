import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { agency, membership, platformAction, user, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { PlatformError } from './admin';

/**
 * The admin console's controls (ADR 0050): suspend or reactivate an agency,
 * its plan and trial, block or unblock one member, make someone owner.
 *
 * Only `platform:manage` (a platform admin, never a view). Each change and its
 * `platform_action` row are one transaction, so nothing changes unrecorded.
 * What a suspension or a block DOES is decided where people come in — the
 * console's actor loader (`accessBlock`), the public listing filter and the
 * background jobs' claim queries (`SUSPENDED_AGENCY_IDS`) — not here.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const PLATFORM = { type: 'platform' } as const;

export type PlatformActionKind =
  | 'agency_suspended'
  | 'agency_reactivated'
  | 'plan_changed'
  | 'member_blocked'
  | 'member_unblocked'
  | 'owner_changed';

function requireManager(admin: Actor): void {
  if (!can(admin, 'platform:manage', PLATFORM)) {
    throw new PlatformError('forbidden', 'Only a platform admin may change this');
  }
}

function reasonOf(raw: string): string {
  const reason = raw.trim().replace(/\s+/g, ' ');
  if (reason.length < 3) throw new PlatformError('invalid', 'Say why — at least a few words. It is kept with the change.');
  return reason.slice(0, 500);
}

async function record(
  tx: DbOrTx,
  admin: Actor,
  agencyId: string,
  action: PlatformActionKind,
  detail: Record<string, unknown>,
  subjectUserId: string | null = null,
): Promise<void> {
  await tx.insert(platformAction).values({ adminUserId: admin.userId, agencyId, subjectUserId, action, detail });
}

async function lockAgency(tx: DbOrTx, agencyId: string) {
  if (!UUID.test(agencyId)) throw new PlatformError('not_found', 'That agency was not found');
  const [row] = await tx
    .select({ id: agency.id, status: agency.status, plan: agency.plan, trialEndsAt: agency.trialEndsAt })
    .from(agency)
    .where(eq(agency.id, agencyId))
    .limit(1)
    .for('update');
  if (!row) throw new PlatformError('not_found', 'That agency was not found');
  return row;
}

// ── The agency ────────────────────────────────────────────────────────────

/**
 * Suspend: nobody in it can use the console, its listings leave the public
 * site, and its workflows, skills, scheduled steps, imports and bulk email
 * wait. Nothing is deleted; reactivating puts it all back.
 */
export async function suspendAgency(db: Db, admin: Actor, agencyId: string, rawReason: string): Promise<void> {
  requireManager(admin);
  const reason = reasonOf(rawReason);
  await db.transaction(async (tx) => {
    const a = await lockAgency(tx, agencyId);
    if (a.status === 'suspended') throw new PlatformError('invalid', 'This agency is already suspended.');
    await tx
      .update(agency)
      .set({ status: 'suspended', suspendedAt: sql`now()`, suspendedReason: reason, updatedAt: sql`now()` })
      .where(eq(agency.id, a.id));
    await record(tx, admin, a.id, 'agency_suspended', { from: a.status, reason });
  });
}

/** Reactivate a suspended agency, as active or back on trial. */
export async function reactivateAgency(db: Db, admin: Actor, agencyId: string, to: 'active' | 'trial'): Promise<void> {
  requireManager(admin);
  if (to !== 'active' && to !== 'trial') throw new PlatformError('invalid', 'Reactivate as active or as a trial.');
  await db.transaction(async (tx) => {
    const a = await lockAgency(tx, agencyId);
    if (a.status !== 'suspended') throw new PlatformError('invalid', 'This agency is not suspended.');
    await tx
      .update(agency)
      .set({ status: to, suspendedAt: null, suspendedReason: null, updatedAt: sql`now()` })
      .where(eq(agency.id, a.id));
    await record(tx, admin, a.id, 'agency_reactivated', { to });
  });
}

export type PlanInput = { plan: string; status: 'active' | 'trial'; trialEndsAt: Date | null };

/**
 * The plan's name, active-or-trial, and when the trial ends. A suspended
 * agency keeps its suspension — reactivating is its own, deliberate step.
 */
export async function setAgencyPlan(db: Db, admin: Actor, agencyId: string, input: PlanInput): Promise<void> {
  requireManager(admin);
  const plan = input.plan.trim();
  if (plan.length < 1 || plan.length > 64) throw new PlatformError('invalid', 'Give the plan a name (up to 64 characters).');
  if (input.status !== 'active' && input.status !== 'trial') throw new PlatformError('invalid', 'Choose active or trial.');
  if (input.trialEndsAt && Number.isNaN(input.trialEndsAt.getTime())) throw new PlatformError('invalid', 'That trial end date is not a date.');
  const trialEndsAt = input.status === 'trial' ? input.trialEndsAt : null;
  await db.transaction(async (tx) => {
    const a = await lockAgency(tx, agencyId);
    const status = a.status === 'suspended' ? 'suspended' : input.status;
    await tx.update(agency).set({ plan, status, trialEndsAt, updatedAt: sql`now()` }).where(eq(agency.id, a.id));
    await record(tx, admin, a.id, 'plan_changed', {
      from: { plan: a.plan, status: a.status, trialEndsAt: a.trialEndsAt?.toISOString() ?? null },
      to: { plan, status, trialEndsAt: trialEndsAt?.toISOString() ?? null },
    });
  });
}

// ── Members ───────────────────────────────────────────────────────────────

async function lockMember(tx: DbOrTx, agencyId: string, userId: string) {
  if (!UUID.test(agencyId) || !UUID.test(userId)) throw new PlatformError('not_found', 'That member was not found in this agency');
  const [row] = await tx
    .select({ id: membership.id, role: membership.role, status: membership.status, removedAt: membership.removedAt })
    .from(membership)
    .where(and(eq(membership.agencyId, agencyId), eq(membership.userId, userId)))
    .limit(1)
    .for('update');
  if (!row) throw new PlatformError('not_found', 'That member was not found in this agency');
  return row;
}

async function otherActiveOwners(tx: DbOrTx, agencyId: string, userId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(membership)
    .where(and(eq(membership.agencyId, agencyId), eq(membership.role, 'owner'), eq(membership.status, 'active'), ne(membership.userId, userId)));
  return Number(r?.n ?? 0);
}

/**
 * Block one member: they can no longer use the console, nor register an
 * agency of their own, and their bulk email waits. Their work stays where it
 * is. Not the agency's last owner — make someone else owner first.
 */
export async function blockMember(db: Db, admin: Actor, agencyId: string, userId: string, rawReason: string): Promise<void> {
  requireManager(admin);
  const reason = reasonOf(rawReason);
  await db.transaction(async (tx) => {
    const m = await lockMember(tx, agencyId, userId);
    if (m.status !== 'active') {
      throw new PlatformError('invalid', m.removedAt ? 'The agency already removed this member.' : 'This member is not active.');
    }
    if (m.role === 'owner' && (await otherActiveOwners(tx, agencyId, userId)) === 0) {
      throw new PlatformError('invalid', 'This is the agency’s only owner. Make someone else owner first.');
    }
    await tx.update(membership).set({ status: 'suspended', updatedAt: sql`now()` }).where(eq(membership.id, m.id));
    await record(tx, admin, agencyId, 'member_blocked', { reason, role: m.role }, userId);
  });
}

/** Undo a block. Refused if they have since become active in another agency (one active agency per person). */
export async function unblockMember(db: Db, admin: Actor, agencyId: string, userId: string): Promise<void> {
  requireManager(admin);
  await db.transaction(async (tx) => {
    const m = await lockMember(tx, agencyId, userId);
    if (m.status !== 'suspended' || m.removedAt) throw new PlatformError('invalid', 'This member is not blocked.');
    const [elsewhere] = await tx
      .select({ id: membership.id })
      .from(membership)
      .where(and(eq(membership.userId, userId), eq(membership.status, 'active')))
      .limit(1);
    if (elsewhere) throw new PlatformError('invalid', 'They are now active in another agency, so this membership cannot be unblocked.');
    await tx.update(membership).set({ status: 'active', updatedAt: sql`now()` }).where(eq(membership.id, m.id));
    await record(tx, admin, agencyId, 'member_unblocked', {}, userId);
  });
}

/**
 * Make an active member the owner. With `demoteOthers`, the agency's other
 * owners become admins — the usual "the owner changed hands"; without it the
 * agency has one more owner.
 */
export async function makeOwner(
  db: Db,
  admin: Actor,
  agencyId: string,
  userId: string,
  opts: { demoteOthers: boolean },
): Promise<void> {
  requireManager(admin);
  await db.transaction(async (tx) => {
    await lockAgency(tx, agencyId);
    const m = await lockMember(tx, agencyId, userId);
    if (m.status !== 'active') throw new PlatformError('invalid', 'Only an active member can be made owner.');
    if (m.role === 'owner' && !opts.demoteOthers) throw new PlatformError('invalid', 'They are already an owner.');
    await tx.update(membership).set({ role: 'owner', updatedAt: sql`now()` }).where(eq(membership.id, m.id));
    const demoted = opts.demoteOthers
      ? await tx
          .update(membership)
          .set({ role: 'admin', updatedAt: sql`now()` })
          .where(and(eq(membership.agencyId, agencyId), eq(membership.role, 'owner'), ne(membership.userId, userId)))
          .returning({ userId: membership.userId })
      : [];
    await record(tx, admin, agencyId, 'owner_changed', { from: m.role as MembershipRole, demoted: demoted.map((d) => d.userId) }, userId);
  });
}

// ── The record ────────────────────────────────────────────────────────────

export type PlatformActionRow = {
  at: Date;
  adminName: string;
  action: PlatformActionKind;
  subjectName: string | null;
  detail: Record<string, unknown>;
};

/** Every change the platform made to this agency, newest first. One statement. */
export async function listPlatformActions(db: Db, admin: Actor, agencyId: string, limit = 50): Promise<PlatformActionRow[]> {
  if (!can(admin, 'platform:read', PLATFORM)) throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  if (!UUID.test(agencyId)) return [];
  const rows = await db
    .select({
      at: platformAction.createdAt,
      adminName: sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})`,
      action: platformAction.action,
      detail: platformAction.detail,
      subjectName: sql<string | null>`(select coalesce(nullif(s.name, ''), s.email) from "user" s where s.id = ${platformAction.subjectUserId})`,
    })
    .from(platformAction)
    .innerJoin(user, eq(user.id, platformAction.adminUserId))
    .where(eq(platformAction.agencyId, agencyId))
    .orderBy(desc(platformAction.createdAt))
    .limit(Math.min(limit, 200));
  return rows.map((r) => ({
    at: new Date(r.at),
    adminName: r.adminName,
    action: r.action as PlatformActionKind,
    subjectName: r.subjectName ?? null,
    detail: (r.detail ?? {}) as Record<string, unknown>,
  }));
}
