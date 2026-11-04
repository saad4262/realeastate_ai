import { and, asc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { automationEvent, buyerAutomation, searchSchedule, shortlist, user, type Db, type DbOrTx } from '@repo/db';
import { pausedConsumerSkills } from '../consumer-skills/catalog';
import { escapeHtml, requireSenderFooter, type EmailTransport, type MarketingMessage, type SenderIdentity } from '../email';
import { priceText } from '../due-diligence/records';
import { PUBLIC_STATUS, type PublicListingSummary, type PublicSearchQuery } from '../listings/search-listings';
import { savedSearchQuerySchema } from '../listings/search-url';
import { toRuntimeQuery } from '../schedules/run-schedule';
import type { ResolvedPlace } from '../geo/place-schema';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { automationSkillUnsubscribeUrl, automationUnsubscribeUrl } from './unsubscribe';
import { CHECK_MINUTES, describeAutomation, sendableNow, type Trigger } from './rules';

/**
 * Automation's tick (ADR 0080, C8 decisions 8–10), on the alerts cron. Detection is SQL — no model anywhere — over the
 * homes the buyer follows; each thing that happened becomes one event (unique per automation and `dedupe_key`), and
 * its action runs in the same transaction, so an event and what it did are recorded together or not at all. The action
 * touches only the buyer's own shortlist. Emails go at 8 am local, or hourly outside 9 pm–7 am for "as it happens".
 * Only for buyers who switched Automation on (an "acts" skill) and are not blocked; paused for everyone, nothing runs.
 */

export const AUTOMATION_BATCH = 200;
export const EMAIL_BATCH = 100;
const MAX_EVENTS_PER_CHECK = 20;

export type AutomationTickDeps = {
  transport: EmailTransport;
  sender: SenderIdentity;
  baseUrl: string;
  unsubscribeSecret: string;
  /** The runner's uncached public search, for "a new home matches". */
  search: (query: PublicSearchQuery) => Promise<PublicListingSummary[]>;
  resolvePlace: (query: string) => Promise<ResolvedPlace | null>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

export type AutomationTickReport = { checked: number; events: number; emailed: number; skipped?: string };

type Due = typeof buyerAutomation.$inferSelect;
export type DetectedEvent = { dedupeKey: string; listingId: string | null; propertyId: string | null; text: string; happenedAt: Date };

const automationOn = (col: SQL | typeof buyerAutomation.userId | typeof automationEvent.userId) => sql`exists (select 1 from consumer_skill_switch s where s.user_id = ${col} and s.skill_key = 'automation' and s.enabled)`;
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/** The listings an automation is about, for the alias `l`. */
function scopeSql(scope: string, userId: string): SQL {
  const short = sql`l.id in (select s.listing_id from shortlist s where s.user_id = ${userId})`;
  const watched = sql`l.property_id in (select w.property_id from property_watch w where w.user_id = ${userId})`;
  return scope === 'shortlist' ? short : scope === 'watched' ? watched : sql`(${short} or ${watched})`;
}

/** What happened for one automation since it was last checked. One read (a search for a new match). */
export async function detectEvents(db: DbOrTx, a: Due, now: Date, deps: Pick<AutomationTickDeps, 'search' | 'resolvePlace'>): Promise<DetectedEvent[]> {
  const since = a.checkedAt > a.createdAt ? a.checkedAt : a.createdAt;
  const trigger = a.trigger as Trigger;
  const inScope = scopeSql(a.scope, a.userId);
  const rows = async <T>(q: SQL) => (await db.execute(q)) as unknown as T[];
  const at = (v: Date | string) => (v instanceof Date ? v : new Date(v));
  const day = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: a.timeZone });

  switch (trigger) {
    case 'price_reduced': {
      const r = await rows<{ id: string; listing_id: string; property_id: string; changed_at: Date | string; old_display: string | null; old_from: string | null; old_to: string | null; new_display: string | null; new_from: string | null; new_to: string | null }>(sql`
        select c.id, c.listing_id, l.property_id, c.changed_at, c.old_display, c.old_from, c.old_to, c.new_display, c.new_from, c.new_to
        from listing_price_change c join listing l on l.id = c.listing_id
        where ${inScope} and c.changed_at > ${since.toISOString()}::timestamptz and coalesce(c.new_from, c.new_to) < coalesce(c.old_from, c.old_to)
        order by c.changed_at, c.id limit ${MAX_EVENTS_PER_CHECK}`);
      return r.map((x) => ({ dedupeKey: `price:${x.id}`, listingId: x.listing_id, propertyId: x.property_id, text: `Price reduced from ${priceText(x.old_display, x.old_from, x.old_to)} to ${priceText(x.new_display, x.new_from, x.new_to)}.`, happenedAt: at(x.changed_at) }));
    }
    case 'open_home_added': {
      const r = await rows<{ id: string; listing_id: string; property_id: string; starts_at: Date | string; created_at: Date | string }>(sql`
        select i.id, i.listing_id, l.property_id, i.starts_at, i.created_at
        from inspection i join listing l on l.id = i.listing_id
        where ${inScope} and i.kind = 'open' and i.created_at > ${since.toISOString()}::timestamptz and i.starts_at > ${now.toISOString()}::timestamptz and l.status = ${PUBLIC_STATUS}
        order by i.starts_at, i.id limit ${MAX_EVENTS_PER_CHECK}`);
      return r.map((x) => ({ dedupeKey: `open:${x.id}`, listingId: x.listing_id, propertyId: x.property_id, text: `New open home: ${day.format(at(x.starts_at))}.`, happenedAt: at(x.created_at) }));
    }
    case 'under_offer':
    case 'sold':
    case 'not_advertised': {
      const status = trigger === 'under_offer' ? 'under_offer' : trigger === 'sold' ? 'sold' : 'withdrawn';
      // A change made before the automation existed is not news to it; the key makes each home fire once.
      const r = await rows<{ id: string; property_id: string; sold_price: string | null; when: Date | string }>(sql`
        select l.id, l.property_id, l.sold_price, coalesce(${status === 'sold' ? sql`l.sold_date, ` : sql``}l.updated_at) as when
        from listing l
        where ${inScope} and l.status = ${status} and l.updated_at > ${a.createdAt.toISOString()}::timestamptz
        order by l.updated_at, l.id limit ${MAX_EVENTS_PER_CHECK}`);
      const text = (x: { sold_price: string | null }) => (trigger === 'under_offer' ? 'Under offer.' : trigger === 'sold' ? (x.sold_price === null ? 'Sold.' : `Sold for ${AUD.format(Number(x.sold_price))}.`) : 'No longer advertised on this site.');
      return r.map((x) => ({ dedupeKey: `${trigger}:${x.id}`, listingId: x.id, propertyId: x.property_id, text: text(x), happenedAt: at(x.when) }));
    }
    case 'listed': {
      const r = await rows<{ id: string; property_id: string; channel: string; price_display: string | null; price_from: string | null; price_to: string | null; published_at: Date | string }>(sql`
        select l.id, l.property_id, l.channel::text as channel, l.price_display, l.price_from, l.price_to, l.published_at
        from listing l
        where ${inScope} and l.status = ${PUBLIC_STATUS} and l.agency_id not in ${SUSPENDED_AGENCY_IDS} and l.published_at > ${a.createdAt.toISOString()}::timestamptz
        order by l.published_at, l.id limit ${MAX_EVENTS_PER_CHECK}`);
      return r.map((x) => ({ dedupeKey: `listed:${x.id}`, listingId: x.id, propertyId: x.property_id, text: `Listed ${x.channel === 'rent' ? 'for rent' : 'for sale'}: ${priceText(x.price_display, x.price_from, x.price_to)}.`, happenedAt: at(x.published_at) }));
    }
    case 'new_match': {
      if (!a.searchId) return [];
      const [s] = await db.select({ query: searchSchedule.query, name: searchSchedule.name }).from(searchSchedule).where(and(eq(searchSchedule.id, a.searchId), eq(searchSchedule.userId, a.userId))).limit(1);
      const q = savedSearchQuerySchema.safeParse(s?.query);
      if (!q.success) return [];
      const found = await deps.search(await toRuntimeQuery(q.data, deps.resolvePlace));
      return found
        .filter((l) => l.publishedAt && new Date(l.publishedAt) > a.createdAt)
        .slice(0, MAX_EVENTS_PER_CHECK)
        .map((l) => ({ dedupeKey: `match:${l.id}`, listingId: l.id, propertyId: null, text: `New match for “${s!.name}”: ${l.priceDisplay ?? priceText(null, l.priceFrom, l.priceTo)}.`, happenedAt: new Date(l.publishedAt!) }));
    }
  }
}

/** Record one event and do its action, together (decision 9). Returns whether it was new. */
export async function recordEvent(tx: DbOrTx, a: Due, e: DetectedEvent): Promise<boolean> {
  const [made] = await tx
    .insert(automationEvent)
    .values({ automationId: a.id, userId: a.userId, listingId: e.listingId, propertyId: e.propertyId, dedupeKey: e.dedupeKey, text: e.text, happenedAt: e.happenedAt })
    .onConflictDoNothing({ target: [automationEvent.automationId, automationEvent.dedupeKey] })
    .returning({ id: automationEvent.id });
  if (!made) return false;
  if (a.action === 'shortlist_add' && e.listingId) {
    const added = await tx.insert(shortlist).values({ userId: a.userId, listingId: e.listingId }).onConflictDoNothing().returning({ listingId: shortlist.listingId });
    if (added.length) await tx.update(automationEvent).set({ actionTaken: 'added' }).where(eq(automationEvent.id, made.id));
  }
  if (a.action === 'shortlist_remove' && e.listingId) {
    const gone = await tx.delete(shortlist).where(and(eq(shortlist.userId, a.userId), eq(shortlist.listingId, e.listingId))).returning({ note: shortlist.note });
    if (gone.length) await tx.update(automationEvent).set({ actionTaken: 'removed', undo: { note: gone[0]!.note } }).where(eq(automationEvent.id, made.id));
  }
  return true;
}

async function checkAutomations(db: Db, deps: AutomationTickDeps, now: Date): Promise<{ checked: number; events: number }> {
  const due = await db
    .select({ a: buyerAutomation })
    .from(buyerAutomation)
    .innerJoin(user, eq(user.id, buyerAutomation.userId))
    .where(and(eq(buyerAutomation.status, 'active'), lt(buyerAutomation.checkedAt, new Date(now.getTime() - CHECK_MINUTES * 60_000)), isNull(user.blockedAt), automationOn(buyerAutomation.userId)))
    .orderBy(asc(buyerAutomation.checkedAt), asc(buyerAutomation.id))
    .limit(AUTOMATION_BATCH);
  let events = 0;
  for (const { a } of due) {
    // The network (a search) before the transaction; then one short write (ARCHITECTURE § 8).
    const found = await detectEvents(db, a, now, deps).catch((err: unknown) => {
      console.error('[automation] detect failed', a.id, err);
      return null;
    });
    await db.transaction(async (tx) => {
      for (const e of found ?? []) if (await recordEvent(tx, a, e)) events += 1;
      // A failed detection keeps its window: the next check looks again from the same point.
      if (found) await tx.update(buyerAutomation).set({ checkedAt: now }).where(eq(buyerAutomation.id, a.id));
    });
  }
  return { checked: due.length, events };
}

export type AutomationDigest = { automationId: string; when: string; unsubscribeUrl: string; lines: { address: string; link: string; text: string; did: string | null }[] };

export function buildAutomationEmail(input: { to: string; sender: SenderIdentity; baseUrl: string; groups: AutomationDigest[]; skillUnsubscribeUrl: string }): MarketingMessage {
  requireSenderFooter(input.sender.from, input.sender.postalAddress, 'Automation');
  const count = input.groups.reduce((n, g) => n + g.lines.length, 0);
  const subject = `${count} ${count === 1 ? 'update' : 'updates'} from your automations`;
  const base = input.baseUrl.replace(/\/$/, '');
  const font = "font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;";
  const html = `<div style="max-width:600px;margin:0 auto;">
  <h1 style="${font}font-size:20px;font-weight:700;margin:0 0 16px;">${escapeHtml(subject)}</h1>
  ${input.groups
    .map(
      (g) => `<h2 style="${font}font-size:15px;font-weight:700;margin:18px 0 4px;">${escapeHtml(g.when)}</h2>
  ${g.lines.map((l) => `<p style="${font}margin:2px 0;"><a href="${escapeHtml(l.link)}" style="color:#0b3d2e;">${escapeHtml(l.address)}</a> — ${escapeHtml(l.text)}${l.did ? ` ${escapeHtml(l.did)}` : ''}</p>`).join('\n  ')}
  <p style="${font}font-size:12px;margin:2px 0;"><a href="${escapeHtml(g.unsubscribeUrl)}" style="color:#8c8577;">Stop this automation</a></p>`,
    )
    .join('\n  ')}
  <p style="${font}font-size:12px;color:#8c8577;margin:24px 0 0;">You get this because Automation is on. <a href="${escapeHtml(`${base}/account/automations`)}">What your automations did</a> · <a href="${escapeHtml(input.skillUnsubscribeUrl)}">Turn off Automation</a><br>${escapeHtml(input.sender.from.name)} · ${escapeHtml(input.sender.postalAddress)}</p>
</div>`;
  const text = [
    subject,
    '',
    ...input.groups.flatMap((g) => [g.when, ...g.lines.map((l) => `  ${l.address} — ${l.text}${l.did ? ` ${l.did}` : ''}`), `  Stop this automation: ${g.unsubscribeUrl}`, '']),
    `What your automations did: ${base}/account/automations`,
    `Turn off Automation: ${input.skillUnsubscribeUrl}`,
    `${input.sender.from.name} · ${input.sender.postalAddress}`,
  ].join('\n');
  return { kind: 'marketing', to: { email: input.to }, from: input.sender.from, subject, html, text, listUnsubscribeUrl: input.skillUnsubscribeUrl, tags: { feature: 'automation' } };
}

async function emailEvents(db: Db, deps: AutomationTickDeps, now: Date): Promise<number> {
  const waiting = await db
    .select({ userId: automationEvent.userId, email: user.email })
    .from(automationEvent)
    .innerJoin(user, eq(user.id, automationEvent.userId))
    .where(and(isNull(automationEvent.emailedAt), isNull(user.blockedAt), automationOn(automationEvent.userId)))
    .groupBy(automationEvent.userId, user.email)
    .orderBy(asc(automationEvent.userId))
    .limit(EMAIL_BATCH);
  const base = deps.baseUrl.replace(/\/$/, '');
  let sent = 0;
  for (const who of waiting) {
    if (!who.email) continue;
    const rows = await db
      .select({ id: automationEvent.id, text: automationEvent.text, actionTaken: automationEvent.actionTaken, listingId: automationEvent.listingId, propertyId: automationEvent.propertyId, a: buyerAutomation, street: sql<string | null>`(select concat_ws(' ', p.street_number, p.street) || ', ' || p.suburb from property p where p.id = coalesce(${automationEvent.propertyId}, (select l.property_id from listing l where l.id = ${automationEvent.listingId})))` })
      .from(automationEvent)
      .innerJoin(buyerAutomation, eq(buyerAutomation.id, automationEvent.automationId))
      .where(and(eq(automationEvent.userId, who.userId), isNull(automationEvent.emailedAt)))
      .orderBy(asc(automationEvent.automationId), asc(automationEvent.happenedAt), asc(automationEvent.id));
    const ready = rows.filter((r) => sendableNow(r.a.delivery, now, r.a.timeZone));
    if (!ready.length) continue;
    const searchNames = new Map<string, string>();
    const ids = [...new Set(ready.map((r) => r.a.searchId).filter((x): x is string => Boolean(x)))];
    if (ids.length) for (const s of await db.select({ id: searchSchedule.id, name: searchSchedule.name }).from(searchSchedule).where(inArray(searchSchedule.id, ids))) searchNames.set(s.id, s.name);
    const groups = new Map<string, AutomationDigest>();
    for (const r of ready) {
      const g = groups.get(r.a.id) ?? { automationId: r.a.id, when: describeAutomation(r.a, r.a.searchId ? searchNames.get(r.a.searchId) : null).when, unsubscribeUrl: automationUnsubscribeUrl(base, r.a.id, who.userId, deps.unsubscribeSecret), lines: [] };
      g.lines.push({ address: r.street?.trim() || 'A home', link: r.listingId ? `${base}/listing/${r.listingId}` : `${base}/property/${r.propertyId}`, text: r.text, did: r.actionTaken === 'added' ? 'Added to your shortlist.' : r.actionTaken === 'removed' ? 'Taken off your shortlist.' : null });
      groups.set(r.a.id, g);
    }
    const message = buildAutomationEmail({ to: who.email, sender: deps.sender, baseUrl: base, groups: [...groups.values()], skillUnsubscribeUrl: automationSkillUnsubscribeUrl(base, who.userId, deps.unsubscribeSecret) });
    const result = await deps.transport.send({ ...message, idempotencyKey: `automation:${who.userId}:${createHash('sha256').update(ready.map((r) => r.id).sort().join(',')).digest('hex').slice(0, 32)}` });
    if (!result.ok) continue;
    await db.update(automationEvent).set({ emailedAt: now }).where(inArray(automationEvent.id, ready.map((r) => r.id)));
    sent += 1;
  }
  return sent;
}

export async function runAutomationTick(db: Db, deps: AutomationTickDeps): Promise<AutomationTickReport> {
  const now = deps.now?.() ?? new Date();
  if (pausedConsumerSkills(deps.env ?? process.env).has('automation')) return { checked: 0, events: 0, emailed: 0, skipped: 'paused' };
  const checked = await checkAutomations(db, deps, now);
  const emailed = await emailEvents(db, deps, now);
  return { ...checked, emailed };
}

