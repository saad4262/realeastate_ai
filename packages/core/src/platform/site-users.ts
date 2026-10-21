import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { PlatformError } from './admin';

/**
 * The admin console's Users section (ADR 0051): the people who use the public
 * site — accounts with no agency membership — and what they search for, open,
 * save, enquire about and ask the property guide; plus the platform-wide view
 * of the same (which suburbs, agencies and listings draw the most interest).
 *
 * `platform:read` only. Raw SQL with sub-selects: each read is a fixed number
 * of statements, started together; none per row. Searches and listing views
 * exist only from when `site_activity` was added — earlier visits were never
 * recorded.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const n = (v: unknown) => Number(v ?? 0);
const d = (v: unknown) => (v ? new Date(v as string) : null);

function requireAdmin(admin: Actor): void {
  if (!can(admin, 'platform:read', { type: 'platform' })) {
    throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  }
}

/** "1/14 Henry St, Paddington" from a property row aliased `p`. */
const ADDRESS = sql.raw(
  `trim(both ' ,' from concat_ws(' ', case when p.unit is not null and p.unit <> '' then p.unit || '/' || coalesce(p.street_number, '') else p.street_number end, p.street) || ', ' || p.suburb)`,
);

/** A site user: an account that belongs to no agency and is not a platform admin. */
const IS_SITE_USER = sql.raw(
  `not exists (select 1 from membership m where m.user_id = u.id) and not exists (select 1 from platform_admin pa where pa.user_id = u.id)`,
);

const USER_COLUMNS = sql.raw(`
  u.id, coalesce(nullif(u.name, ''), u.email) as name, u.email, u.phone, u.created_at, u.last_seen_at, u.blocked_at, u.blocked_reason,
  (select count(*)::int from site_activity a where a.user_id = u.id and a.kind = 'search') as searches,
  (select count(*)::int from site_activity a where a.user_id = u.id and a.kind = 'listing_view') as views,
  (select count(*)::int from lead l where l.user_id = u.id) as enquiries,
  (select count(*)::int from search_schedule s where s.user_id = u.id) as saved_searches,
  (select count(*)::int from shortlist s where s.user_id = u.id) as shortlist,
  (select count(*)::int from chat_thread c where c.user_id = u.id) as chats,
  greatest(
    (select max(a.created_at) from site_activity a where a.user_id = u.id),
    (select max(c.last_message_at) from chat_thread c where c.user_id = u.id),
    (select max(l.created_at) from lead l where l.user_id = u.id)
  ) as last_active_at`);

export type SiteUserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: Date;
  searches: number;
  views: number;
  enquiries: number;
  savedSearches: number;
  shortlist: number;
  chats: number;
  lastActiveAt: Date | null;
  /** ADR 0052. */
  lastSeenAt: Date | null;
  blocked: boolean;
  blockedReason: string | null;
};

function userRow(r: Record<string, unknown>): SiteUserRow {
  return {
    id: r.id as string,
    name: String(r.name),
    email: String(r.email),
    phone: (r.phone as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    searches: n(r.searches),
    views: n(r.views),
    enquiries: n(r.enquiries),
    savedSearches: n(r.saved_searches),
    shortlist: n(r.shortlist),
    chats: n(r.chats),
    lastActiveAt: d(r.last_active_at),
    lastSeenAt: d(r.last_seen_at),
    blocked: Boolean(r.blocked_at),
    blockedReason: (r.blocked_reason as string | null) ?? null,
  };
}

/** Every site user, most recently active first, with their counts and the total. One statement. */
export async function listSiteUsers(
  db: Db,
  admin: Actor,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: SiteUserRow[]; total: number }> {
  requireAdmin(admin);
  const q = opts.q?.trim();
  const like = q ? `%${q}%` : null;
  const rows = await db.execute<Record<string, unknown>>(sql`
    select ${USER_COLUMNS}, count(*) over() as total
    from "user" u
    where ${IS_SITE_USER} ${like ? sql`and (u.name ilike ${like} or u.email ilike ${like})` : sql``}
    order by last_active_at desc nulls last, u.created_at desc
    limit ${Math.min(opts.limit ?? 50, 200)} offset ${Math.max(opts.offset ?? 0, 0)}`);
  return { rows: [...rows].map(userRow), total: n(rows[0]?.total) };
}

export type SiteUserProfile = SiteUserRow & {
  topSuburbs: { suburb: string; state: string | null; searches: number; views: number }[];
  topAgencies: { agencyId: string; name: string; views: number; enquiries: number; saved: number }[];
  activity: { at: Date; kind: string; suburb: string | null; channel: string | null; listingId: string | null; address: string | null; agencyName: string | null; query: Record<string, unknown> | null }[];
  savedSearchRows: { id: string; name: string; prompt: string; cadence: string; status: string; createdAt: Date; lastRunAt: Date | null }[];
  enquiryRows: { id: string; kind: string; status: string; at: Date; address: string | null; agencyId: string; agencyName: string; message: string | null }[];
  saved: { listingId: string; address: string | null; agencyName: string; status: string; at: Date }[];
  chatRows: { id: string; title: string; lastMessageAt: Date; messages: number }[];
};

/** One site user, everything about them. Eight statements, started together. */
export async function getSiteUser(db: Db, admin: Actor, userId: string): Promise<SiteUserProfile> {
  requireAdmin(admin);
  if (!UUID.test(userId)) throw new PlatformError('not_found', 'That user was not found');
  const [base, suburbs, agencies, activity, schedules, leads, saved, chats] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`select ${USER_COLUMNS} from "user" u where u.id = ${userId} and ${IS_SITE_USER}`),
    db.execute<Record<string, unknown>>(sql`
      select min(a.suburb) as suburb, max(a.state) as state,
        count(*) filter (where a.kind = 'search')::int as searches,
        count(*) filter (where a.kind = 'listing_view')::int as views
      from site_activity a where a.user_id = ${userId} and a.suburb is not null
      group by lower(a.suburb) order by count(*) desc limit 10`),
    db.execute<Record<string, unknown>>(sql`
      select x.agency_id, ag.name, sum(x.views)::int as views, sum(x.enquiries)::int as enquiries, sum(x.saved)::int as saved
      from (
        select a.agency_id, 1 as views, 0 as enquiries, 0 as saved from site_activity a where a.user_id = ${userId} and a.agency_id is not null
        union all select l.agency_id, 0, 1, 0 from lead l where l.user_id = ${userId}
        union all select li.agency_id, 0, 0, 1 from shortlist s join listing li on li.id = s.listing_id where s.user_id = ${userId}
      ) x join agency ag on ag.id = x.agency_id
      group by x.agency_id, ag.name order by sum(x.views + x.enquiries * 5 + x.saved * 3) desc limit 10`),
    db.execute<Record<string, unknown>>(sql`
      select a.created_at, a.kind, a.suburb, a.channel, a.listing_id, a.query, ${ADDRESS} as address, ag.name as agency_name
      from site_activity a
      left join listing li on li.id = a.listing_id
      left join property p on p.id = li.property_id
      left join agency ag on ag.id = a.agency_id
      where a.user_id = ${userId} order by a.created_at desc limit 100`),
    db.execute<Record<string, unknown>>(sql`
      select s.id, s.name, s.prompt, s.cadence, s.status, s.created_at, s.last_run_at
      from search_schedule s where s.user_id = ${userId} order by s.created_at desc limit 50`),
    db.execute<Record<string, unknown>>(sql`
      select l.id, l.kind, l.status, l.created_at, l.message, l.agency_id, ag.name as agency_name, ${ADDRESS} as address
      from lead l join agency ag on ag.id = l.agency_id left join property p on p.id = l.property_id
      where l.user_id = ${userId} order by l.created_at desc limit 50`),
    db.execute<Record<string, unknown>>(sql`
      select s.listing_id, s.created_at, li.status, ag.name as agency_name, ${ADDRESS} as address
      from shortlist s join listing li on li.id = s.listing_id join agency ag on ag.id = li.agency_id
      left join property p on p.id = li.property_id
      where s.user_id = ${userId} order by s.created_at desc limit 50`),
    db.execute<Record<string, unknown>>(sql`
      select c.id, c.title, c.last_message_at, (select count(*)::int from chat_message m where m.thread_id = c.id) as messages
      from chat_thread c where c.user_id = ${userId} order by c.last_message_at desc limit 50`),
  ]);
  const [row] = [...base];
  if (!row) throw new PlatformError('not_found', 'That user was not found');
  return {
    ...userRow(row),
    topSuburbs: [...suburbs].map((r) => ({ suburb: String(r.suburb), state: (r.state as string | null) ?? null, searches: n(r.searches), views: n(r.views) })),
    topAgencies: [...agencies].map((r) => ({ agencyId: r.agency_id as string, name: String(r.name), views: n(r.views), enquiries: n(r.enquiries), saved: n(r.saved) })),
    activity: [...activity].map((r) => ({
      at: new Date(r.created_at as string),
      kind: String(r.kind),
      suburb: (r.suburb as string | null) ?? null,
      channel: (r.channel as string | null) ?? null,
      listingId: (r.listing_id as string | null) ?? null,
      address: (r.address as string | null) ?? null,
      agencyName: (r.agency_name as string | null) ?? null,
      query: (r.query as Record<string, unknown> | null) ?? null,
    })),
    savedSearchRows: [...schedules].map((r) => ({
      id: r.id as string,
      name: String(r.name),
      prompt: String(r.prompt),
      cadence: String(r.cadence),
      status: String(r.status),
      createdAt: new Date(r.created_at as string),
      lastRunAt: d(r.last_run_at),
    })),
    enquiryRows: [...leads].map((r) => ({
      id: r.id as string,
      kind: String(r.kind),
      status: String(r.status),
      at: new Date(r.created_at as string),
      address: (r.address as string | null) ?? null,
      agencyId: r.agency_id as string,
      agencyName: String(r.agency_name),
      message: (r.message as string | null) ?? null,
    })),
    saved: [...saved].map((r) => ({
      listingId: r.listing_id as string,
      address: (r.address as string | null) ?? null,
      agencyName: String(r.agency_name),
      status: String(r.status),
      at: new Date(r.created_at as string),
    })),
    chatRows: [...chats].map((r) => ({ id: r.id as string, title: String(r.title), lastMessageAt: new Date(r.last_message_at as string), messages: n(r.messages) })),
  };
}

export type SiteUserChat = { id: string; title: string; messages: { role: string; text: string; at: Date }[] };

/** One of a site user's conversations with the property guide. Two statements. */
export async function getSiteUserChat(db: Db, admin: Actor, userId: string, threadId: string): Promise<SiteUserChat> {
  requireAdmin(admin);
  const notFound = () => new PlatformError('not_found', 'That conversation was not found');
  if (!UUID.test(userId) || !UUID.test(threadId)) throw notFound();
  const [t] = await db.execute<{ id: string; title: string }>(sql`select id, title from chat_thread where id = ${threadId} and user_id = ${userId}`);
  if (!t) throw notFound();
  const rows = await db.execute<{ role: string; text: string; created_at: string }>(sql`
    select role::text as role, text, created_at from chat_message where thread_id = ${threadId} order by created_at, id`);
  return { id: t.id, title: t.title, messages: [...rows].map((m) => ({ role: m.role, text: m.text, at: new Date(m.created_at) })) };
}

// ── The whole site ────────────────────────────────────────────────────────

export type SiteInsights = {
  days: number;
  totals: { searches: number; signedInSearches: number; views: number; signedInViews: number; activeUsers: number; newUsers: number; enquiries: number };
  topSuburbs: { suburb: string; state: string | null; searches: number; views: number }[];
  topAgencies: { agencyId: string; name: string; views: number; enquiries: number }[];
  topListings: { listingId: string; address: string | null; agencyName: string | null; views: number }[];
};

/** What the public site's visitors looked for, over the last `days`. Four statements, started together. */
export async function siteInsights(db: Db, admin: Actor, days: 7 | 30 | 90 = 30): Promise<SiteInsights> {
  requireAdmin(admin);
  const since = sql`now() - make_interval(days => ${days})`;
  const [[t], suburbs, agencies, listings] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select
        (select count(*)::int from site_activity where kind = 'search' and created_at > ${since}) as searches,
        (select count(*)::int from site_activity where kind = 'search' and user_id is not null and created_at > ${since}) as signed_in_searches,
        (select count(*)::int from site_activity where kind = 'listing_view' and created_at > ${since}) as views,
        (select count(*)::int from site_activity where kind = 'listing_view' and user_id is not null and created_at > ${since}) as signed_in_views,
        (select count(distinct user_id)::int from site_activity where user_id is not null and created_at > ${since}) as active_users,
        (select count(*)::int from "user" u where u.created_at > ${since} and not exists (select 1 from membership m where m.user_id = u.id)) as new_users,
        (select count(*)::int from lead where user_id is not null and created_at > ${since}) as enquiries`),
    db.execute<Record<string, unknown>>(sql`
      select min(a.suburb) as suburb, max(a.state) as state,
        count(*) filter (where a.kind = 'search')::int as searches,
        count(*) filter (where a.kind = 'listing_view')::int as views
      from site_activity a where a.suburb is not null and a.created_at > ${since}
      group by lower(a.suburb) order by count(*) desc limit 15`),
    db.execute<Record<string, unknown>>(sql`
      select ag.id as agency_id, ag.name,
        (select count(*)::int from site_activity a where a.agency_id = ag.id and a.kind = 'listing_view' and a.created_at > ${since}) as views,
        (select count(*)::int from lead l where l.agency_id = ag.id and l.created_at > ${since}) as enquiries
      from agency ag order by 3 desc, 4 desc limit 15`),
    db.execute<Record<string, unknown>>(sql`
      select a.listing_id, count(*)::int as views, max(ag.name) as agency_name, max(${ADDRESS}) as address
      from site_activity a
      join listing li on li.id = a.listing_id left join property p on p.id = li.property_id left join agency ag on ag.id = li.agency_id
      where a.kind = 'listing_view' and a.created_at > ${since}
      group by a.listing_id order by 2 desc limit 15`),
  ]);
  return {
    days,
    totals: {
      searches: n(t?.searches),
      signedInSearches: n(t?.signed_in_searches),
      views: n(t?.views),
      signedInViews: n(t?.signed_in_views),
      activeUsers: n(t?.active_users),
      newUsers: n(t?.new_users),
      enquiries: n(t?.enquiries),
    },
    topSuburbs: [...suburbs].map((r) => ({ suburb: String(r.suburb), state: (r.state as string | null) ?? null, searches: n(r.searches), views: n(r.views) })),
    topAgencies: [...agencies].filter((r) => n(r.views) + n(r.enquiries) > 0).map((r) => ({ agencyId: r.agency_id as string, name: String(r.name), views: n(r.views), enquiries: n(r.enquiries) })),
    topListings: [...listings].map((r) => ({ listingId: r.listing_id as string, address: (r.address as string | null) ?? null, agencyName: (r.agency_name as string | null) ?? null, views: n(r.views) })),
  };
}
