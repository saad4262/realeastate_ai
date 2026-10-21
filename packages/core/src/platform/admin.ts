import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  agency,
  membership,
  platformAdmin,
  platformViewLog,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';

/**
 * The platform admin console (ADR 0049): the platform's own people reading
 * every agency, and nothing else.
 *
 * Two kinds of actor meet here. The ADMIN (`loadPlatformAdmin`) belongs to no
 * agency and may do exactly one thing, `platform:read`: list agencies and
 * people across the platform, and open a VIEW. The VIEW (`platformViewActor`)
 * is an ordinary agency actor — the agency's owner, or one named member —
 * marked `via: 'platform'`, which makes can() refuse every action that is not
 * a read. Handed to the existing core reads, it sees what that owner or member
 * sees; handed to any write, it is refused before the write's own rule runs.
 *
 * Every page an admin opens is written to `platform_view_log` (the user's
 * decision: admins read everything, and every read is recorded).
 */

export class PlatformError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid';
  constructor(code: PlatformError['code'], message: string) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f-]{36}$/i;
const PLATFORM = { type: 'platform' } as const;

function requireAdmin(admin: Actor): void {
  if (!can(admin, 'platform:read', PLATFORM)) {
    throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  }
}

/** A view actor, or throw — for the reads that exist only for the admin console. */
export function requirePlatformView(view: Actor): asserts view is Actor & { agencyId: string; via: 'platform'; viewerId: string } {
  if (view.via !== 'platform' || !view.agencyId || !view.viewerId) {
    throw new PlatformError('forbidden', 'Only the admin console reads this');
  }
}

/** The platform admin behind this signed-in user, or null when they are not one. One statement. */
export async function loadPlatformAdmin(db: DbOrTx, userId: string): Promise<Actor | null> {
  if (!UUID.test(userId)) return null;
  const [row] = await db
    .select({ userId: platformAdmin.userId })
    .from(platformAdmin)
    .where(eq(platformAdmin.userId, userId))
    .limit(1);
  return row ? { userId: row.userId, platformAdmin: true } : null;
}

// ── Shared SQL ────────────────────────────────────────────────────────────

const personName = sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})`;

/**
 * The counts every agency row carries — sub-selected, so a page of agencies stays one statement.
 * `agency.id` is written out, not interpolated: in a select with no join Drizzle renders
 * `${agency.id}` as a bare "id", which inside `from membership m` binds to m.id
 * (single-table-subquery.test.ts).
 */
function agencyCounts() {
  return {
    members: sql<number>`(select count(*)::int from membership m where m.agency_id = agency.id and m.status = 'active')`,
    liveListings: sql<number>`(select count(*)::int from listing l where l.agency_id = agency.id and l.status in ('live', 'under_offer'))`,
    leads30d: sql<number>`(select count(*)::int from lead x where x.agency_id = agency.id and x.created_at > now() - interval '30 days')`,
    leadsTotal: sql<number>`(select count(*)::int from lead x where x.agency_id = agency.id)`,
    contacts: sql<number>`(select count(*)::int from contact c where c.agency_id = agency.id)`,
    upcomingMeetings: sql<number>`(select count(*)::int from appointment a where a.agency_id = agency.id and a.status = 'scheduled' and a.starts_at > now())`,
    owner: sql<{ name: string; email: string } | null>`(
      select json_build_object('name', coalesce(nullif(u.name, ''), u.email), 'email', u.email)
      from membership m join "user" u on u.id = m.user_id
      where m.agency_id = agency.id and m.role = 'owner'
      order by (m.status = 'active') desc, m.created_at
      limit 1
    )`,
  };
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

// ── The whole platform ────────────────────────────────────────────────────

export type PlatformTotals = {
  agencies: number;
  activeMembers: number;
  liveListings: number;
  leads7d: number;
  leads30d: number;
  meetingsNext7d: number;
  newAgencies30d: number;
};

/** The admin home's figures. One statement. */
export async function platformTotals(db: Db, admin: Actor): Promise<PlatformTotals> {
  requireAdmin(admin);
  const [row] = await db.execute<Record<keyof PlatformTotals, number>>(sql`
    select
      (select count(*)::int from agency) as "agencies",
      (select count(*)::int from membership where status = 'active') as "activeMembers",
      (select count(*)::int from listing where status in ('live', 'under_offer')) as "liveListings",
      (select count(*)::int from lead where created_at > now() - interval '7 days') as "leads7d",
      (select count(*)::int from lead where created_at > now() - interval '30 days') as "leads30d",
      (select count(*)::int from appointment where status = 'scheduled' and starts_at > now() and starts_at < now() + interval '7 days') as "meetingsNext7d",
      (select count(*)::int from agency where created_at > now() - interval '30 days') as "newAgencies30d"
  `);
  return {
    agencies: num(row?.agencies),
    activeMembers: num(row?.activeMembers),
    liveListings: num(row?.liveListings),
    leads7d: num(row?.leads7d),
    leads30d: num(row?.leads30d),
    meetingsNext7d: num(row?.meetingsNext7d),
    newAgencies30d: num(row?.newAgencies30d),
  };
}

export type AgencyStatus = 'active' | 'suspended' | 'trial';

export type PlatformAgencyRow = {
  id: string;
  name: string;
  slug: string;
  status: AgencyStatus;
  plan: string | null;
  timeZone: string;
  createdAt: Date;
  members: number;
  liveListings: number;
  leads30d: number;
  leadsTotal: number;
  contacts: number;
  upcomingMeetings: number;
  owner: { name: string; email: string } | null;
};

function agencyRow(r: Record<string, unknown>): PlatformAgencyRow {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    status: r.status as AgencyStatus,
    plan: (r.plan as string | null) ?? null,
    timeZone: r.timeZone as string,
    createdAt: new Date(r.createdAt as string | Date),
    members: num(r.members),
    liveListings: num(r.liveListings),
    leads30d: num(r.leads30d),
    leadsTotal: num(r.leadsTotal),
    contacts: num(r.contacts),
    upcomingMeetings: num(r.upcomingMeetings),
    owner: (r.owner as PlatformAgencyRow['owner']) ?? null,
  };
}

const agencyColumns = () => ({
  id: agency.id,
  name: agency.name,
  slug: agency.slug,
  status: agency.status,
  plan: agency.plan,
  timeZone: agency.timeZone,
  createdAt: agency.createdAt,
  ...agencyCounts(),
});

export type AgencyListOptions = { q?: string; status?: AgencyStatus; limit?: number; offset?: number };

/** Every agency on the platform, newest first, with its counts and the total. One statement. */
export async function listAgencies(
  db: Db,
  admin: Actor,
  opts: AgencyListOptions = {},
): Promise<{ rows: PlatformAgencyRow[]; total: number }> {
  requireAdmin(admin);
  const q = opts.q?.trim();
  const where = and(
    q ? or(ilike(agency.name, `%${q}%`), ilike(agency.slug, `%${q}%`)) : undefined,
    opts.status ? eq(agency.status, opts.status) : undefined,
  );
  const rows = await db
    .select({ ...agencyColumns(), total: sql<number>`count(*) over()` })
    .from(agency)
    .where(where)
    .orderBy(desc(agency.createdAt), asc(agency.id))
    .limit(Math.min(opts.limit ?? 50, 200))
    .offset(Math.max(opts.offset ?? 0, 0));
  return { rows: rows.map((r) => agencyRow(r)), total: num(rows[0]?.total) };
}

export type PlatformAgencyProfile = PlatformAgencyRow & {
  abn: string | null;
  /** ADR 0050: why and since when it is suspended, and when its trial ends. */
  suspendedAt: Date | null;
  suspendedReason: string | null;
  trialEndsAt: Date | null;
  logoUrl: string | null;
  owners: { userId: string; name: string; email: string; role: MembershipRole; status: string }[];
};

/** One agency's profile: the row, its counts and who runs it. One statement. */
export async function getAgencyProfile(db: Db, admin: Actor, agencyId: string): Promise<PlatformAgencyProfile> {
  requireAdmin(admin);
  if (!UUID.test(agencyId)) throw new PlatformError('not_found', 'That agency was not found');
  const [row] = await db
    .select({
      ...agencyColumns(),
      abn: agency.abn,
      suspendedAt: agency.suspendedAt,
      suspendedReason: agency.suspendedReason,
      trialEndsAt: agency.trialEndsAt,
      logoUrl: agency.logoUrl,
      owners: sql<PlatformAgencyProfile['owners'] | null>`(
        select json_agg(json_build_object(
          'userId', u.id, 'name', coalesce(nullif(u.name, ''), u.email), 'email', u.email, 'role', m.role, 'status', m.status
        ) order by (m.role = 'owner') desc, lower(coalesce(nullif(u.name, ''), u.email)))
        from membership m join "user" u on u.id = m.user_id
        where m.agency_id = agency.id and m.role in ('owner', 'admin')
      )`,
    })
    .from(agency)
    .where(eq(agency.id, agencyId))
    .limit(1);
  if (!row) throw new PlatformError('not_found', 'That agency was not found');
  return {
    ...agencyRow(row),
    abn: row.abn ?? null,
    logoUrl: row.logoUrl ?? null,
    owners: row.owners ?? [],
    suspendedAt: row.suspendedAt ? new Date(row.suspendedAt) : null,
    suspendedReason: row.suspendedReason ?? null,
    trialEndsAt: row.trialEndsAt ? new Date(row.trialEndsAt) : null,
  };
}

// ── People ────────────────────────────────────────────────────────────────

export type PlatformPersonRow = {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  role: MembershipRole;
  status: string;
  joinedAt: Date | null;
  /** `suspended` with this set is a removal by the agency (ADR 0030); without it, a block by the platform (ADR 0050). */
  removed: boolean;
  /** ADR 0052: the last time their console was open. */
  lastSeenAt: Date | null;
  agencyId: string;
  agencyName: string;
  openLeads: number;
  listings: number;
  contacts: number;
  upcomingMeetings: number;
  lastAssistantAt: Date | null;
};

/** What each person is carrying — sub-selected, so a list of people stays one statement. */
function personCounts() {
  return {
    openLeads: sql<number>`(select count(*)::int from lead x where x.agency_id = ${membership.agencyId} and x.assigned_to = ${membership.userId} and x.status <> 'closed')`,
    listings: sql<number>`(
      select count(*)::int from listing_agent la join listing l on l.id = la.listing_id
      where la.user_id = ${membership.userId} and l.agency_id = ${membership.agencyId} and l.status in ('draft', 'pending', 'live', 'under_offer')
    )`,
    contacts: sql<number>`(select count(*)::int from contact c where c.agency_id = ${membership.agencyId} and c.assigned_to = ${membership.userId})`,
    upcomingMeetings: sql<number>`(
      select count(*)::int from appointment a
      where a.agency_id = ${membership.agencyId} and a.status = 'scheduled' and a.starts_at > now()
        and (a.assigned_agent_id = ${membership.userId} or a.created_by = ${membership.userId})
    )`,
    lastAssistantAt: sql<string | null>`(
      select max(ac.last_turn_at) from assistant_conversation ac
      where ac.agency_id = ${membership.agencyId} and ac.user_id = ${membership.userId}
    )`,
  };
}

const personColumns = () => ({
  userId: user.id,
  name: personName,
  email: user.email,
  phone: user.phone,
  role: membership.role,
  status: membership.status,
  joinedAt: membership.joinedAt,
  removedAt: membership.removedAt,
  lastSeenAt: user.lastSeenAt,
  agencyId: agency.id,
  agencyName: agency.name,
  ...personCounts(),
});

function personRow(r: Record<string, unknown>): PlatformPersonRow {
  return {
    userId: r.userId as string,
    name: r.name as string,
    email: r.email as string,
    phone: (r.phone as string | null) ?? null,
    role: r.role as MembershipRole,
    status: r.status as string,
    joinedAt: r.joinedAt ? new Date(r.joinedAt as string | Date) : null,
    removed: Boolean(r.removedAt),
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt as string | Date) : null,
    agencyId: r.agencyId as string,
    agencyName: r.agencyName as string,
    openLeads: num(r.openLeads),
    listings: num(r.listings),
    contacts: num(r.contacts),
    upcomingMeetings: num(r.upcomingMeetings),
    lastAssistantAt: r.lastAssistantAt ? new Date(r.lastAssistantAt as string) : null,
  };
}

/** Everyone who is or was a member of one agency — removed ones too — with what each carries. One statement. */
export async function listAgencyPeople(db: Db, admin: Actor, agencyId: string): Promise<PlatformPersonRow[]> {
  requireAdmin(admin);
  if (!UUID.test(agencyId)) return [];
  const rows = await db
    .select(personColumns())
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .innerJoin(agency, eq(agency.id, membership.agencyId))
    .where(eq(membership.agencyId, agencyId))
    .orderBy(
      sql`(${membership.status} = 'active') desc`,
      sql`(${membership.role} in ('owner', 'admin')) desc`,
      asc(sql`lower(${personName})`),
    );
  return rows.map((r) => personRow(r));
}

/** Every member of every agency, searchable by name, email or agency, with the total. One statement. */
export async function listAllPeople(
  db: Db,
  admin: Actor,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: PlatformPersonRow[]; total: number }> {
  requireAdmin(admin);
  const q = opts.q?.trim();
  const rows = await db
    .select({ ...personColumns(), total: sql<number>`count(*) over()` })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .innerJoin(agency, eq(agency.id, membership.agencyId))
    .where(q ? or(ilike(user.name, `%${q}%`), ilike(user.email, `%${q}%`), ilike(agency.name, `%${q}%`)) : undefined)
    .orderBy(asc(sql`lower(${personName})`), asc(membership.id))
    .limit(Math.min(opts.limit ?? 50, 200))
    .offset(Math.max(opts.offset ?? 0, 0));
  return { rows: rows.map((r) => personRow(r)), total: num(rows[0]?.total) };
}

// ── The view ──────────────────────────────────────────────────────────────

export type PlatformView = {
  /** Hand this to the ordinary core reads. Every write refuses it (can(), `via: 'platform'`). */
  actor: Actor & { agencyId: string; via: 'platform'; viewerId: string };
  agencyName: string;
  agencyTimeZone: string;
  /** For the page header only — never a permission input. */
  agencyStatus: AgencyStatus;
  agencyPlan: string | null;
  /** The member whose view this is; null for the agency as a whole. */
  subject: { userId: string; name: string; email: string; role: MembershipRole; status: string } | null;
};

/**
 * A read-only view of one agency (no `userId`: as its owner sees it) or of one
 * of its members (as that member sees it — their own leads, inbox, calendar,
 * team conversations and assistant chats). One statement: the agency, and the
 * member's role and listings when one is named.
 *
 * The member must belong to THIS agency (a membership row, in any status — a
 * removed member's history is still the agency's). Anyone else is not found.
 */
export async function platformViewActor(
  db: Db,
  admin: Actor,
  target: { agencyId: string; userId?: string },
): Promise<PlatformView> {
  requireAdmin(admin);
  const notFound = () => new PlatformError('not_found', target.userId ? 'That member was not found in this agency' : 'That agency was not found');
  if (!UUID.test(target.agencyId) || (target.userId !== undefined && !UUID.test(target.userId))) throw notFound();
  const memberId = target.userId ?? null;
  const [row] = await db
    .select({
      agencyId: agency.id,
      agencyName: agency.name,
      timeZone: agency.timeZone,
      agencyStatus: agency.status,
      agencyPlan: agency.plan,
      member: sql<{ userId: string; name: string; email: string; role: MembershipRole; status: string; listings: string[] | null } | null>`(
        select json_build_object(
          'userId', u.id, 'name', coalesce(nullif(u.name, ''), u.email), 'email', u.email, 'role', m.role, 'status', m.status,
          'listings', (select json_agg(la.listing_id) from listing_agent la join listing l on l.id = la.listing_id
                       where la.user_id = u.id and l.agency_id = m.agency_id)
        )
        from membership m join "user" u on u.id = m.user_id
        where m.agency_id = agency.id and m.user_id = ${memberId}::uuid
      )`,
    })
    .from(agency)
    .where(eq(agency.id, target.agencyId))
    .limit(1);
  if (!row) throw notFound();
  if (memberId && !row.member) throw notFound();

  const base = { agencyId: row.agencyId, via: 'platform' as const, viewerId: admin.userId };
  if (!row.member) {
    return {
      actor: { ...base, userId: admin.userId, membershipRole: 'owner' },
      agencyName: row.agencyName,
      agencyTimeZone: row.timeZone,
      agencyStatus: row.agencyStatus as AgencyStatus,
      agencyPlan: row.agencyPlan ?? null,
      subject: null,
    };
  }
  const m = row.member;
  return {
    actor: { ...base, userId: m.userId, membershipRole: m.role, listingAgentOf: m.listings ?? [] },
    agencyName: row.agencyName,
    agencyTimeZone: row.timeZone,
    agencyStatus: row.agencyStatus as AgencyStatus,
    agencyPlan: row.agencyPlan ?? null,
    subject: { userId: m.userId, name: m.name, email: m.email, role: m.role, status: m.status },
  };
}

// ── The log ───────────────────────────────────────────────────────────────

/**
 * Record one page an admin opened. Pass the admin for a platform-wide page,
 * or the view for a page inside an agency. One statement.
 */
export async function logPlatformView(
  db: DbOrTx,
  who: Actor,
  /** `subjectUserId`: on a platform-wide page about one person (a site user, ADR 0051). */
  entry: { area: string; refId?: string | null; subjectUserId?: string | null },
): Promise<void> {
  let adminUserId: string;
  let agencyId: string | null = null;
  let subjectUserId: string | null = null;
  if (who.via === 'platform') {
    requirePlatformView(who);
    adminUserId = who.viewerId;
    agencyId = who.agencyId;
    subjectUserId = who.userId === who.viewerId ? null : who.userId;
  } else {
    requireAdmin(who);
    adminUserId = who.userId;
    subjectUserId = entry.subjectUserId && UUID.test(entry.subjectUserId) ? entry.subjectUserId : null;
  }
  await db.insert(platformViewLog).values({
    adminUserId,
    agencyId,
    subjectUserId,
    area: entry.area.slice(0, 32),
    refId: entry.refId && UUID.test(entry.refId) ? entry.refId : null,
  });
}

export type PlatformViewLogRow = { at: Date; adminName: string; area: string; subjectName: string | null; refId: string | null };

/** Who from the platform looked at this agency, newest first. One statement. */
export async function listAgencyViewLog(db: Db, admin: Actor, agencyId: string, limit = 50): Promise<PlatformViewLogRow[]> {
  requireAdmin(admin);
  if (!UUID.test(agencyId)) return [];
  const rows = await db
    .select({
      at: platformViewLog.createdAt,
      adminName: personName,
      area: platformViewLog.area,
      refId: platformViewLog.refId,
      subjectName: sql<string | null>`(select coalesce(nullif(s.name, ''), s.email) from "user" s where s.id = ${platformViewLog.subjectUserId})`,
    })
    .from(platformViewLog)
    .innerJoin(user, eq(user.id, platformViewLog.adminUserId))
    .where(eq(platformViewLog.agencyId, agencyId))
    .orderBy(desc(platformViewLog.createdAt))
    .limit(Math.min(limit, 200));
  return rows.map((r) => ({ at: new Date(r.at), adminName: r.adminName, area: r.area, subjectName: r.subjectName ?? null, refId: r.refId ?? null }));
}
