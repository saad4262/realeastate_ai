import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { visibleContactIdsSql } from '../contacts/visibility';
import { activityListingIdsSql, PROPERTY_ADDRESS, searchInScopeSql, searchWords, viewInScopeSql } from './scope';

/**
 * The Listing activity page (ADR 0083): who looked at this agency's listings, or at an agent's own. Signed-in people by
 * name, everyone else a count; the agency's own members are left out, or an agent checking their ad reads as interest.
 * Three statements: the totals, the listings, one page of people.
 */

export class ListingActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingActivityError';
  }
}

export const LISTING_ACTIVITY_DAYS = [7, 30, 90] as const;
export type ListingActivityDays = (typeof LISTING_ACTIVITY_DAYS)[number];
export const LISTING_ACTIVITY_PAGE_SIZE = 50;

export function parseActivityDays(raw: unknown): ListingActivityDays {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (LISTING_ACTIVITY_DAYS as readonly number[]).includes(n) ? (n as ListingActivityDays) : 30;
}

export type ListingActivityTotals = { views: number; people: number; anonymousViews: number; searches: number };
export type ListingActivityListing = { listingId: string; address: string; views: number; people: number; saves: number; enquiries: number };
export type ListingActivityPerson = {
  userId: string;
  name: string;
  email: string;
  /** Their customer record here, when this actor may open one. */
  contactId: string | null;
  kind: 'view' | 'search' | 'saved';
  what: string;
  at: Date;
};
export type ListingActivityPage = {
  days: ListingActivityDays;
  totals: ListingActivityTotals;
  listings: ListingActivityListing[];
  people: ListingActivityPerson[];
  peopleTotal: number;
  page: number;
};

export async function getListingActivity(
  db: Db,
  actor: Actor,
  opts: { days?: ListingActivityDays; page?: number } = {},
): Promise<ListingActivityPage> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'listing_activity:read', { type: 'listing', agencyId })) {
    throw new ListingActivityError('You do not have access to listing activity.');
  }
  const days = opts.days ?? 30;
  const page = Math.max(opts.page ?? 1, 1);
  const since = sql`now() - make_interval(days => ${days}::int)`;
  const notStaff = sql`(a.user_id is null or not exists (select 1 from membership m where m.user_id = a.user_id and m.agency_id = ${agencyId}))`;
  const view = viewInScopeSql(actor);
  const search = searchInScopeSql(actor);

  const [totalsRows, listingRows, peopleRows] = await Promise.all([
    db.execute<{ views: string; people: string; anonymous: string; searches: string }>(sql`
      select
        count(*) filter (where ${view}) as views,
        count(distinct a.user_id) filter (where ${view}) as people,
        count(*) filter (where ${view} and a.user_id is null) as anonymous,
        count(*) filter (where ${search}) as searches
      from site_activity a
      where a.created_at >= ${since} and ${notStaff}`),
    db.execute<{ listing_id: string; address: string | null; views: string; people: string; saves: string; enquiries: string }>(sql`
      select v.listing_id, ${PROPERTY_ADDRESS} as address, v.views, v.people,
        (select count(*) from shortlist s where s.listing_id = v.listing_id and s.created_at >= ${since}
           and not exists (select 1 from membership m where m.user_id = s.user_id and m.agency_id = ${agencyId})) as saves,
        (select count(*) from lead l where l.listing_id = v.listing_id and l.kind <> 'offer' and l.created_at >= ${since}) as enquiries
      from (
        select a.listing_id, count(*) as views, count(distinct a.user_id) as people
        from site_activity a
        where a.created_at >= ${since} and ${notStaff} and ${view}
        group by a.listing_id
        order by views desc
        limit 50
      ) v
      join listing li on li.id = v.listing_id join property p on p.id = li.property_id
      order by v.views desc`),
    db.execute<{ user_id: string; name: string | null; email: string; contact_id: string | null; kind: 'view' | 'search' | 'saved'; address: string | null; query: Record<string, unknown> | null; suburb: string | null; state: string | null; channel: string | null; at: Date | string; total: string }>(sql`
      with acts as (
        select a.user_id, case when a.kind = 'search' then 'search' else 'view' end as kind, a.listing_id, a.query, a.suburb, a.state, a.channel, a.created_at as at
        from site_activity a
        where a.user_id is not null and a.created_at >= ${since} and ${notStaff} and ((${view}) or (${search}))
        union all
        select s.user_id, 'saved', s.listing_id, null, null, null, null, s.created_at
        from shortlist s
        where s.created_at >= ${since} and s.listing_id in (${activityListingIdsSql(actor)})
          and not exists (select 1 from membership m where m.user_id = s.user_id and m.agency_id = ${agencyId})
      )
      select r.user_id, u.name, u.email, ct.id as contact_id, r.kind, ${PROPERTY_ADDRESS} as address, r.query, r.suburb, r.state, r.channel, r.at, count(*) over() as total
      from acts r
      join "user" u on u.id = r.user_id
      left join listing li on li.id = r.listing_id
      left join property p on p.id = li.property_id
      left join lateral (
        select c.id from contact c
        where c.agency_id = ${agencyId} and c.merged_into_id is null and c.id in (${visibleContactIdsSql(actor)})
          and (c.user_id = u.id or lower(c.email) = lower(u.email) or exists (select 1 from lead l where l.contact_id = c.id and l.user_id = u.id))
        order by c.created_at
        limit 1
      ) ct on true
      order by r.at desc
      limit ${LISTING_ACTIVITY_PAGE_SIZE} offset ${(page - 1) * LISTING_ACTIVITY_PAGE_SIZE}`),
  ]);

  const t = totalsRows[0];
  return {
    days,
    page,
    totals: { views: Number(t?.views ?? 0), people: Number(t?.people ?? 0), anonymousViews: Number(t?.anonymous ?? 0), searches: Number(t?.searches ?? 0) },
    listings: [...listingRows].map((r) => ({
      listingId: r.listing_id,
      address: r.address ?? 'Address not shown',
      views: Number(r.views),
      people: Number(r.people),
      saves: Number(r.saves),
      enquiries: Number(r.enquiries),
    })),
    people: [...peopleRows].map((r) => ({
      userId: r.user_id,
      name: r.name?.trim() || r.email,
      email: r.email,
      contactId: r.contact_id,
      kind: r.kind,
      what: r.kind === 'search' ? searchWords(r.query, { suburb: r.suburb, state: r.state, channel: r.channel }) : (r.address ?? 'A listing'),
      at: new Date(r.at),
    })),
    peopleTotal: Number(peopleRows[0]?.total ?? 0),
  };
}
