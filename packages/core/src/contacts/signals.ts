import { and, eq, ne, sql } from 'drizzle-orm';
import { lead, mailMessage, mailThread, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { PROPERTY_ADDRESS, viewInScopeSql } from '../activity/scope';
import { LISTING_EXPRS, LISTING_PRICE_RANGE, briefFitsSql } from '../buyer-matching/match';
import { PUBLIC_STATUS } from '../listings/search-listings';
import { leadScopeFilters } from '../leads/list-leads';
import { threadScopeFilters } from '../mail/threads';
import { belongsToContactSql, numberScopeSql } from './communications';
import type { ContactTab } from './contact-schema';
import type { ReadableContact } from './get-contact';
import { FIRST_REPLY_SQL } from './lead-summary';
import { contactAccountIdsSql } from './site-history';

/**
 * "What to do next" on a profile (ADR 0083 §8): fixed rules over facts SQL read, the reason always shown. No model, no
 * stored score: the facts are read each time, each under its own tab's scope, so a nudge never points at a row the person
 * cannot open.
 */

export type ContactSignalFacts = {
  lastFromThemAt: Date | null;
  lastFromThemChannel: 'email' | 'sms' | 'call' | null;
  lastFromUsAt: Date | null;
  inbound7: number;
  inbound30: number;
  enquiries7: number;
  enquiries30: number;
  /** Any lead or inbound message, ever. */
  everActive: boolean;
  views7: number;
  views30: number;
  /** The listing they opened most this week. */
  topView: { address: string; views: number } | null;
  /** The oldest open lead nobody has replied to. */
  unansweredLeadAt: Date | null;
  matchingListings: number;
  nextAction: string | null;
  nextActionAt: Date | null;
};

export type Engagement = 'hot' | 'warm' | 'quiet' | 'none';
export type Nudge = { key: string; text: string; tab: ContactTab };
export type ContactSignals = { engagement: Engagement; why: string; nudges: Nudge[] };

export const ENGAGEMENT_LABELS: Record<Engagement, string> = { hot: 'Hot', warm: 'Warm', quiet: 'Quiet', none: 'No activity yet' };

const DAY_MS = 86_400_000;
/** A week's views that read as interest on their own. */
const HOT_VIEWS = 3;
/** A listing opened this often in a week is worth saying out loud. */
const REPEAT_VIEWS = 2;
const QUIET_AFTER_DAYS = 30;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 hours", "2 days". Pure. */
export function agoWords(at: Date, now: Date): string {
  const min = Math.max(Math.round((now.getTime() - at.getTime()) / 60_000), 0);
  if (min < 60) return plural(Math.max(min, 1), 'minute');
  if (min < 48 * 60) return plural(Math.round(min / 60), 'hour');
  return plural(Math.round(min / (24 * 60)), 'day');
}

const CHANNEL_WORD: Record<NonNullable<ContactSignalFacts['lastFromThemChannel']>, string> = { email: 'email', sms: 'text', call: 'call' };
const CHANNEL_TAB: Record<NonNullable<ContactSignalFacts['lastFromThemChannel']>, ContactTab> = { email: 'emails', sms: 'sms', call: 'calls' };

/** Pure: the rules, tested without a database. */
export function profileSignals(f: ContactSignalFacts, now: Date): ContactSignals {
  const direct7 = f.enquiries7 + f.inbound7;
  const parts = (enquiries: number, inbound: number, views: number, days: number) =>
    `${[enquiries ? plural(enquiries, 'enquiry', 'enquiries') : null, inbound ? plural(inbound, 'message') : null, views ? plural(views, 'listing view') : null].filter(Boolean).join(', ')} in the last ${days} days.`;

  let engagement: Engagement;
  let why: string;
  if (direct7 > 0 || f.views7 >= HOT_VIEWS) {
    engagement = 'hot';
    why = parts(f.enquiries7, f.inbound7, f.views7, 7);
  } else if (f.enquiries30 + f.inbound30 + f.views30 > 0) {
    engagement = 'warm';
    why = parts(f.enquiries30, f.inbound30, f.views30, 30);
  } else if (f.everActive) {
    engagement = 'quiet';
    why = f.lastFromThemAt ? `Last heard from ${agoWords(f.lastFromThemAt, now)} ago.` : `Nothing from them in the last ${QUIET_AFTER_DAYS} days.`;
  } else {
    engagement = 'none';
    why = 'No enquiries, messages or listing views yet.';
  }

  const nudges: Nudge[] = [];
  if (f.lastFromThemAt && f.lastFromThemChannel && (!f.lastFromUsAt || f.lastFromThemAt > f.lastFromUsAt)) {
    nudges.push({ key: 'reply', text: `Waiting on a reply: their ${CHANNEL_WORD[f.lastFromThemChannel]} came ${agoWords(f.lastFromThemAt, now)} ago`, tab: CHANNEL_TAB[f.lastFromThemChannel] });
  }
  if (f.nextActionAt && f.nextActionAt < now) {
    nudges.push({ key: 'overdue', text: `Next action is overdue by ${agoWords(f.nextActionAt, now)}${f.nextAction ? `: ${f.nextAction}` : ''}`, tab: 'overview' });
  }
  if (f.unansweredLeadAt) {
    nudges.push({ key: 'lead', text: `An open lead has had no reply for ${agoWords(f.unansweredLeadAt, now)}`, tab: 'enquiries' });
  }
  if (f.matchingListings > 0) {
    nudges.push({ key: 'match', text: `${plural(f.matchingListings, 'live listing')} ${f.matchingListings === 1 ? 'fits' : 'fit'} their brief`, tab: 'requirements' });
  }
  if (f.topView && f.topView.views >= REPEAT_VIEWS) {
    nudges.push({ key: 'view', text: `Opened ${f.topView.address} ${f.topView.views} times this week`, tab: 'activity' });
  }
  const lastTouch = [f.lastFromUsAt, f.lastFromThemAt].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];
  if (f.everActive && lastTouch && now.getTime() - lastTouch.getTime() > QUIET_AFTER_DAYS * DAY_MS) {
    nudges.push({ key: 'quiet', text: `No contact for ${agoWords(lastTouch, now)}`, tab: 'timeline' });
  }
  return { engagement, why, nudges };
}

/** The facts, in one statement. */
export async function contactSignalFacts(
  db: Db,
  actor: Actor,
  c: ReadableContact,
  next: { nextAction: string | null; nextActionAt: Date | null },
): Promise<ContactSignalFacts> {
  const thread = (direction: 'in' | 'out', channel: string) =>
    db
      .select({ channel: sql<string>`${channel}`.as('channel'), at: sql<Date>`${mailMessage.createdAt}`.as('at') })
      .from(mailMessage)
      .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
      .leftJoin(lead, eq(lead.id, mailThread.leadId))
      .where(and(eq(mailThread.contactId, c.id), eq(mailMessage.direction, direction), ...threadScopeFilters(db, actor)));
  const texts = (direction: 'in' | 'out') => sql`
    select 'sms' as channel, m.created_at as at from sms_message m join phone_number pn on pn.id = m.phone_number_id
    where m.agency_id = ${c.agencyId} and m.direction = ${direction} and ${belongsToContactSql('m.contact_id', 'm.counterpart', c.id)} and ${numberScopeSql(actor, c.agencyId)}`;
  const leads = and(eq(lead.contactId, c.id), ...leadScopeFilters(db, actor));
  const open = and(eq(lead.contactId, c.id), ne(lead.status, 'closed'), ...leadScopeFilters(db, actor));
  const views = sql`select a.listing_id, a.created_at from site_activity a where a.user_id in (${contactAccountIdsSql(c.id)}) and ${viewInScopeSql(actor)}`;

  const [r] = await db.execute<Record<string, string | boolean | null>>(sql`
    with inbound as (
      (${thread('in', 'email')})
      union all (${texts('in')})
      union all (select 'call', pc.created_at from phone_call pc join phone_number pn on pn.id = pc.phone_number_id
        where pc.agency_id = ${c.agencyId} and pc.kind = 'missed' and ${belongsToContactSql('pc.contact_id', 'pc.from_e164', c.id)} and ${numberScopeSql(actor, c.agencyId)})
    ), outbound as (
      (${thread('out', 'email')})
      union all (${texts('out')})
      union all (select 'call', a.occurred_at from activity a where a.contact_id = ${c.id} and a.agency_id = ${c.agencyId} and a.kind = 'call_logged')
    ), v as (${views}), top_view as (
      select v.listing_id, count(*) as n from v where v.created_at >= now() - interval '7 days' group by v.listing_id order by n desc, v.listing_id limit 1
    )
    select
      (select max(at) from inbound) as last_in,
      (select channel from inbound order by at desc limit 1) as last_channel,
      (select max(at) from outbound) as last_out,
      (select count(*) from inbound where at >= now() - interval '7 days') as inbound7,
      (select count(*) from inbound where at >= now() - interval '30 days') as inbound30,
      (select count(*) from "lead" where ${leads} and "lead".created_at >= now() - interval '7 days') as enquiries7,
      (select count(*) from "lead" where ${leads} and "lead".created_at >= now() - interval '30 days') as enquiries30,
      (exists (select 1 from inbound) or exists (select 1 from "lead" where ${leads})) as ever,
      (select count(*) from v where v.created_at >= now() - interval '7 days') as views7,
      (select count(*) from v where v.created_at >= now() - interval '30 days') as views30,
      (select tv.n from top_view tv) as top_n,
      (select ${PROPERTY_ADDRESS} from top_view tv join listing li on li.id = tv.listing_id join property p on p.id = li.property_id) as top_address,
      (select min("lead".created_at) from "lead" where ${open} and ${FIRST_REPLY_SQL} is null) as unanswered,
      (select count(*) from listing li join property p on p.id = li.property_id ${LISTING_PRICE_RANGE}
        where li.agency_id = ${c.agencyId} and li.status = ${PUBLIC_STATUS}
          and exists (select 1 from buyer_requirement br where br.contact_id = ${c.id} and br.agency_id = ${c.agencyId} and ${and(...briefFitsSql(LISTING_EXPRS))})) as matching`);
  const n = (v: unknown) => Number(v ?? 0);
  const when = (v: unknown) => (v ? new Date(v as string) : null);
  const channel = r?.last_channel;
  return {
    lastFromThemAt: when(r?.last_in),
    lastFromThemChannel: channel === 'email' || channel === 'sms' || channel === 'call' ? channel : null,
    lastFromUsAt: when(r?.last_out),
    inbound7: n(r?.inbound7),
    inbound30: n(r?.inbound30),
    enquiries7: n(r?.enquiries7),
    enquiries30: n(r?.enquiries30),
    everActive: Boolean(r?.ever),
    views7: n(r?.views7),
    views30: n(r?.views30),
    topView: r?.top_address && r?.top_n ? { address: String(r.top_address), views: n(r.top_n) } : null,
    unansweredLeadAt: when(r?.unanswered),
    matchingListings: n(r?.matching),
    nextAction: next.nextAction,
    nextActionAt: next.nextActionAt,
  };
}

export type MatchingListing = { id: string; address: string; price: string | null };

/** The first few of the agency's live listings that fit an active brief. One statement. */
export async function listMatchingListings(db: Db, c: ReadableContact, limit = 5): Promise<MatchingListing[]> {
  const rows = await db.execute<{ id: string; address: string | null; price: string | null }>(sql`
    select li.id, ${PROPERTY_ADDRESS} as address, li.price_display as price
    from listing li join property p on p.id = li.property_id ${LISTING_PRICE_RANGE}
    where li.agency_id = ${c.agencyId} and li.status = ${PUBLIC_STATUS}
      and exists (select 1 from buyer_requirement br where br.contact_id = ${c.id} and br.agency_id = ${c.agencyId} and ${and(...briefFitsSql(LISTING_EXPRS))})
    order by li.created_at desc
    limit ${limit}`);
  return rows.map((r) => ({ id: r.id, address: r.address ?? 'A listing', price: r.price }));
}
