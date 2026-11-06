import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { activityListingIdsSql, PROPERTY_ADDRESS, searchInScopeSql, searchWords, viewInScopeSql } from '../activity/scope';
import type { ReadableContact } from './get-contact';

/**
 * A profile's Activity tab (ADR 0083 §5, §7): what this person did on the public site, within what this actor may see.
 * An account is tied by the contact row, a lead from it, or the same email; the tie is shown, because a typed email
 * proves nothing (ADR 0016). The tie adds to a profile's view of an account; it never merges anything.
 */

/** `select id` of the accounts tied to this contact. */
export function contactAccountIdsSql(contactId: string): SQL {
  return sql`
    select c.user_id as id from contact c where c.id = ${contactId} and c.user_id is not null
    union select l.user_id from lead l where l.contact_id = ${contactId} and l.user_id is not null
    union select u.id from "user" u join contact c on c.id = ${contactId} where c.email is not null and lower(u.email) = lower(c.email)`;
}

/** `confirmed`: their own account did something here, or its email is verified. `email`: only the typed address matches. */
export type AccountTie = 'none' | 'confirmed' | 'email';

function tieSql(contactId: string): SQL {
  return sql`case
    when exists (select 1 from contact c where c.id = ${contactId} and c.user_id is not null)
      or exists (select 1 from lead l where l.contact_id = ${contactId} and l.user_id is not null)
      or exists (select 1 from "user" u join contact c on c.id = ${contactId}
                 where u.verified_email is not null and lower(u.verified_email) = lower(c.email) and lower(u.email) = lower(c.email)) then 'confirmed'
    when exists (select 1 from "user" u join contact c on c.id = ${contactId} where lower(u.email) = lower(c.email)) then 'email'
    else 'none' end`;
}

/** Their rows inside this actor's scope: (kind, at, id, listing_id, query, suburb, state, channel). */
export function siteRowsSql(actor: Actor, contactId: string): SQL {
  const accounts = contactAccountIdsSql(contactId);
  return sql`
    select case when a.kind = 'search' then 'search' else 'view' end as kind, a.created_at as at, a.id, a.listing_id, a.query, a.suburb, a.state, a.channel
    from site_activity a
    where a.user_id in (${accounts}) and ((${viewInScopeSql(actor)}) or (${searchInScopeSql(actor)}))
    union all
    select 'saved', s.created_at, md5(s.user_id::text || s.listing_id::text)::uuid, s.listing_id, null, null, null, null
    from shortlist s
    where s.user_id in (${accounts}) and s.listing_id in (${activityListingIdsSql(actor)})`;
}

export type SiteHistoryRow = { id: string; kind: 'view' | 'search' | 'saved'; at: Date; listingId: string | null; what: string };
export type SiteHistory = {
  tie: AccountTie;
  views: number;
  listings: number;
  searches: number;
  saved: number;
  total: number;
  rows: SiteHistoryRow[];
  page: number;
};

export const SITE_HISTORY_PAGE_SIZE = 50;

/** One statement, one row always, so "no account" and "an account with nothing here" read apart. */
export async function listContactSiteHistory(db: Db, actor: Actor, c: ReadableContact, opts: { page?: number } = {}): Promise<SiteHistory> {
  const page = Math.max(opts.page ?? 1, 1);
  const [r] = await db.execute<{
    tie: AccountTie; views: string; listings: string; searches: string; saved: string; total: string;
    rows: { id: string; kind: SiteHistoryRow['kind']; at: string; listing_id: string | null; address: string | null; query: Record<string, unknown> | null; suburb: string | null; state: string | null; channel: string | null }[] | string | null;
  }>(sql`
    with r as (${siteRowsSql(actor, c.id)})
    select ${tieSql(c.id)} as tie,
      (select count(*) from r where kind = 'view') as views,
      (select count(distinct listing_id) from r where kind = 'view') as listings,
      (select count(*) from r where kind = 'search') as searches,
      (select count(*) from r where kind = 'saved') as saved,
      (select count(*) from r) as total,
      (select json_agg(x order by x.at desc) from (
        select r.id, r.kind, r.at, r.listing_id, ${PROPERTY_ADDRESS} as address, r.query, r.suburb, r.state, r.channel
        from r
        left join listing li on li.id = r.listing_id
        left join property p on p.id = li.property_id
        order by r.at desc
        limit ${SITE_HISTORY_PAGE_SIZE} offset ${(page - 1) * SITE_HISTORY_PAGE_SIZE}
      ) x) as rows`);
  const rows = typeof r?.rows === 'string' ? (JSON.parse(r.rows) as Exclude<NonNullable<typeof r>['rows'], string | null>) : (r?.rows ?? []);
  return {
    tie: r?.tie ?? 'none',
    views: Number(r?.views ?? 0),
    listings: Number(r?.listings ?? 0),
    searches: Number(r?.searches ?? 0),
    saved: Number(r?.saved ?? 0),
    total: Number(r?.total ?? 0),
    page,
    rows: rows.map((x) => ({
      id: x.id,
      kind: x.kind,
      at: new Date(x.at),
      listingId: x.listing_id,
      what: x.kind === 'search' ? searchWords(x.query, { suburb: x.suburb, state: x.state, channel: x.channel }) : (x.address ?? 'A listing'),
    })),
  };
}
