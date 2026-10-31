import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { assistantTask, proposedAction, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor } from '../permissions';
import { visibleContactIdsSql } from '../contacts/visibility';
import { describeRequirement, type RequirementChannel } from '../contacts/contact-schema';
import { hasMarketingConsentSql } from '../template-email/consent';
import { classify } from '../template-email/batches';
import type { SkipReason } from '../template-email/schema';
import { activateTask } from '../assistant/task-state';
import { agencyTimeZone } from '../widgets/registry';
import { instantToLocalInput, localInputToInstant } from '../time/local-input';
import { briefFitsSql, describeTarget, LISTING_CHANNEL, LISTING_EXPRS, LISTING_PRICE_RANGE, targetExprs, type BuyerTarget } from './match';

/**
 * A listing's matching buyers (ADR 0060): the tab, the Listings table's counts, and the call task — all on
 * `briefFitsSql`, the same rule as the assistant's find_buyers, over contacts the person may read.
 */

export class BuyerMatchError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'BuyerMatchError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** At most this many buyers on one call task, as in one email batch. */
export const MAX_BUYERS_PER_CALL_TASK = 20;
/** The tab lists at most this many briefs. */
const TAB_LIMIT = 200;

function mayReadContacts(actor: Actor): boolean {
  return Boolean(actor.agencyId) && can(actor, 'contact:read', { type: 'contact', agencyId: actor.agencyId as string });
}

/**
 * The brief's contact and their assignee: the joins every query shares (needs `br`). The table keeps its own
 * name, `contact`, because hasMarketingConsentSql reads `"contact"."…"`.
 */
const BRIEF_CONTACT = sql`join contact on contact.id = br.contact_id and contact.agency_id = br.agency_id
    left join "user" u on u.id = contact.assigned_to`;
/** Only contacts this person may read, never archived or merged. */
function visibleWhere(actor: Actor): SQL {
  return sql`contact.archived_at is null and contact.merged_into_id is null and contact.id in (${visibleContactIdsSql(actor)})`;
}

/** A listing's figures as a target — for the words above the results. Null if not this agency's. */
export async function listingTarget(db: DbOrTx, agencyId: string, listingId: string): Promise<BuyerTarget | null> {
  if (!UUID.test(listingId)) return null;
  const [li] = await db.execute<{ channel: string; low: string | null; high: string | null; bedrooms: number | null; bathrooms: string | null; property_type: string | null; suburb: string | null; address: string }>(sql`
    select ${LISTING_CHANNEL} as channel, pr.low::text as low, pr.high::text as high,
      coalesce(li.bedrooms, p.bedrooms) as bedrooms, coalesce(li.bathrooms, p.bathrooms)::text as bathrooms,
      coalesce(li.property_type, p.property_type) as property_type, p.suburb,
      concat_ws(', ', nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), ''), p.suburb) as address
    from listing li join property p on p.id = li.property_id ${LISTING_PRICE_RANGE}
    where li.id = ${listingId} and li.agency_id = ${agencyId}`);
  if (!li) return null;
  const n = (v: string | null) => (v === null ? null : Number(v));
  return {
    channel: li.channel === 'rent' ? 'rent' : 'sale',
    suburb: li.suburb,
    low: n(li.low),
    high: n(li.high),
    bedrooms: li.bedrooms,
    bathrooms: n(li.bathrooms),
    propertyType: li.property_type ? li.property_type.toLowerCase() : null,
    address: li.address,
    priceUnknown: li.low === null && li.high === null,
  };
}

export type BuyerRow = {
  requirement_id: string;
  contact_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  opted_out: boolean;
  consent: unknown;
  assigned_to: string | null;
  assignee_name: string | null;
  channel: string;
  price_min: string | null;
  price_max: string | null;
  min_bedrooms: number | null;
  min_bathrooms: string | null;
  suburbs: string[] | null;
  property_types: string[] | null;
  enquired: boolean;
  total: number;
};

/**
 * The fitting briefs, one row each, most specific first: briefs naming a suburb, then the most recently
 * changed. A listing is matched from its own columns (LISTING_EXPRS); words from their values.
 */
export async function queryBuyers(db: DbOrTx, actor: Actor, source: { listingId: string } | { target: BuyerTarget }, limit: number): Promise<BuyerRow[]> {
  const agencyId = actor.agencyId as string;
  const fromListing = 'listingId' in source;
  return db.execute<BuyerRow>(sql`
    select br.id as requirement_id, contact.id as contact_id, contact.name, contact.phone, contact.email,
      (contact.email_opt_out_at is not null) as opted_out, ${hasMarketingConsentSql()} as consent,
      contact.assigned_to, u.name as assignee_name,
      br.channel::text as channel, br.price_min::text as price_min, br.price_max::text as price_max,
      br.min_bedrooms, br.min_bathrooms::text as min_bathrooms, br.suburbs, br.property_types,
      ${fromListing ? sql`exists (select 1 from lead l where l.contact_id = contact.id and l.listing_id = li.id)` : sql`false`} as enquired,
      count(*) over()::int as total
    from ${fromListing ? sql`listing li join property p on p.id = li.property_id ${LISTING_PRICE_RANGE} join buyer_requirement br on br.agency_id = li.agency_id` : sql`buyer_requirement br`}
    ${BRIEF_CONTACT}
    where br.agency_id = ${agencyId}
      ${fromListing ? sql`and li.id = ${source.listingId} and li.agency_id = ${agencyId}` : sql``}
      and ${visibleWhere(actor)}
      and ${sql.join(briefFitsSql(fromListing ? LISTING_EXPRS : targetExprs(source.target)), sql` and `)}
    order by (cardinality(br.suburbs) > 0) desc, br.updated_at desc, br.id
    limit ${limit}`);
}

const num = (v: string | null) => (v === null ? null : Number(v));

/** A brief in the Requirements tab's words, from its figures — never its free-text note. */
export function briefWords(r: Pick<BuyerRow, 'channel' | 'price_min' | 'price_max' | 'min_bedrooms' | 'min_bathrooms' | 'suburbs' | 'property_types'>): string {
  return describeRequirement({
    channel: r.channel as RequirementChannel,
    priceMin: num(r.price_min),
    priceMax: num(r.price_max),
    minBedrooms: r.min_bedrooms,
    minBathrooms: num(r.min_bathrooms),
    suburbs: r.suburbs ?? [],
    propertyTypes: r.property_types ?? [],
  });
}

export type MatchedBuyer = {
  contactId: string;
  name: string;
  phone: string | null;
  /** Their first fitting brief, in words. */
  brief: string;
  assigneeName: string | null;
  enquired: boolean;
  /** Null: they may be emailed (bulk email's own rule, ADR 0043). Otherwise why not. */
  skipReason: SkipReason | null;
};

export type ListingBuyers = { listingId: string; address: string; searched: string; priceUnknown: boolean; buyers: MatchedBuyer[] };

/** The Matching buyers tab: one row per buyer (their most specific fitting brief), each with whether they can be emailed. */
export async function listingBuyers(db: DbOrTx, actor: Actor, listingId: string): Promise<ListingBuyers> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'listing:read', { type: 'listing', id: listingId, agencyId }) || !mayReadContacts(actor)) {
    throw new BuyerMatchError('forbidden', 'You do not have access to this listing’s buyers.');
  }
  const target = await listingTarget(db, agencyId, listingId);
  if (!target) throw new BuyerMatchError('not_found', 'That listing was not found.');
  const rows = await queryBuyers(db, actor, { listingId }, TAB_LIMIT);
  const seen = new Set<string>();
  const buyers: MatchedBuyer[] = [];
  for (const r of rows) {
    if (seen.has(r.contact_id)) continue;
    seen.add(r.contact_id);
    buyers.push({
      contactId: r.contact_id,
      name: r.name,
      phone: r.phone,
      brief: briefWords(r),
      assigneeName: r.assigned_to ? (r.assigned_to === actor.userId ? 'you' : r.assignee_name ?? 'a team member') : null,
      enquired: Boolean(r.enquired),
      // Archived and merged contacts are not listed at all, so `archived` is false here.
      skipReason: classify({ archived: false, optedOut: Boolean(r.opted_out), consent: r.consent === true || r.consent === 't', email: r.email }),
    });
  }
  return { listingId, address: target.address ?? '', searched: describeTarget(target), priceUnknown: Boolean(target.priceUnknown), buyers };
}

/**
 * The Listings table's Buyers column: for each listing, how many buyers (contacts, not briefs) fit. ONE
 * statement for the whole page — never one per row.
 */
export async function matchingBuyerCounts(db: DbOrTx, actor: Actor, listingIds: readonly string[]): Promise<Record<string, number>> {
  const ids = [...new Set(listingIds)].filter((id) => UUID.test(id)).slice(0, 500);
  if (!ids.length || !mayReadContacts(actor)) return {};
  const agencyId = actor.agencyId as string;
  const rows = await db.execute<{ id: string; n: number }>(sql`
    select li.id, (
      select count(distinct contact.id)::int
      from buyer_requirement br ${BRIEF_CONTACT}
      where br.agency_id = li.agency_id and ${visibleWhere(actor)}
        and ${sql.join(briefFitsSql(LISTING_EXPRS), sql` and `)}
    ) as n
    from listing li join property p on p.id = li.property_id ${LISTING_PRICE_RANGE}
    where li.agency_id = ${agencyId} and li.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.n)]));
}

/** 9 am tomorrow on the agency's clock. Pure. */
export function nineTomorrow(now: Date, timeZone: string): Date {
  const today = instantToLocalInput(now, timeZone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return localInputToInstant(`${tomorrow}T09:00`, timeZone) ?? new Date(now.getTime() + DAY_MS);
}

/** The task's words: a title, and one line per buyer with their phone. Pure. */
export function callTaskText(address: string, buyers: readonly Pick<MatchedBuyer, 'name' | 'phone' | 'brief'>[]): { title: string; body: string } {
  const n = buyers.length;
  return {
    title: `Call ${n} matched buyer${n === 1 ? '' : 's'} for ${address}`.slice(0, 300),
    body: buyers.map((b) => `${b.name} · ${b.phone ?? 'no phone on file'} — wants ${b.brief}`).join('\n'),
  };
}

/**
 * Remind me to call (ADR 0060 §6, the user's decision 3): ONE task with one reminder at 9 am tomorrow,
 * its note listing every buyer — never a reminder per buyer. The same machinery as create_reminder: an
 * assistant task whose single `remind` step notifies its owner when due. Pressing the button is the
 * approval; a second press for the same buyers and time makes nothing new.
 */
export async function scheduleBuyerCallTask(
  db: Db,
  actor: Actor,
  listingId: string,
  contactIds: readonly string[],
  now = new Date(),
): Promise<{ taskId: string | null; at: Date; already: boolean }> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'assistant:use', { type: 'assistant', agencyId })) throw new BuyerMatchError('forbidden', 'You cannot make tasks here.');
  const ids = [...new Set(contactIds)];
  if (!ids.length) throw new BuyerMatchError('invalid', 'Pick at least one buyer.');
  if (ids.length > MAX_BUYERS_PER_CALL_TASK) throw new BuyerMatchError('invalid', `Pick at most ${MAX_BUYERS_PER_CALL_TASK} buyers for one call list.`);
  if (ids.some((id) => !UUID.test(id))) throw new BuyerMatchError('invalid', 'Those buyers were not found.');

  // Only buyers who still fit and whom this person may see — re-read, never taken from the browser.
  const lb = await listingBuyers(db, actor, listingId);
  const chosen = lb.buyers.filter((b) => ids.includes(b.contactId));
  if (chosen.length !== ids.length) throw new BuyerMatchError('conflict', 'Some of those buyers no longer fit this listing. Refresh the list and try again.');

  const at = nineTomorrow(now, await agencyTimeZone(db, agencyId));
  const { title, body } = callTaskText(lb.address, chosen);
  const href = `${isAgencyAdminRole(actor.membershipRole) ? '/live-listings' : '/listings'}/${listingId}/edit?tab=buyers`;
  const endsAt = new Date(now.getTime() + 30 * DAY_MS);
  const key = `buyer-call:${listingId}:${actor.userId}:${at.toISOString()}:${createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16)}`;

  try {
    return await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(assistantTask)
        .values({ agencyId, userId: actor.userId, conversationId: null, title: title.slice(0, 200), status: 'proposed', endsAt })
        .returning({ id: assistantTask.id });
      const made = await tx
        .insert(proposedAction)
        .values({
          agencyId,
          userId: actor.userId,
          conversationId: null,
          contactId: null,
          tool: 'remind',
          args: { tool: 'remind', text: title, email: false, body, href },
          card: { title, contact: { id: '', name: '' }, lines: [{ label: 'Buyers', value: body }], notes: [] },
          status: 'blocked',
          runAt: at,
          idempotencyKey: key,
          expiresAt: endsAt,
          taskId: task!.id,
          taskSeq: 1,
        })
        .onConflictDoNothing({ target: proposedAction.idempotencyKey })
        .returning({ id: proposedAction.id });
      if (!made.length) throw new BuyerMatchError('conflict', 'already');
      await activateTask(tx, task!.id, actor.userId, now);
      return { taskId: task!.id, at, already: false };
    });
  } catch (err) {
    // The same buyers, the same time: made before — the rolled-back task leaves nothing behind.
    if (err instanceof BuyerMatchError && err.message === 'already') return { taskId: null, at, already: true };
    throw err;
  }
}
