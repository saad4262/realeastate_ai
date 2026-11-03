import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { listing, listingPriceChange, property, propertyWatch, propertyWatchEvent, user, type Db } from '@repo/db';
import { pausedConsumerSkills } from '../consumer-skills/catalog';
import { escapeHtml, requireSenderFooter, watchUnsubscribeUrl, type EmailTransport, type MarketingMessage, type SenderIdentity } from '../email';
import { priceText } from '../due-diligence/records';
import { watchEvents, standingOf } from './detect';
import { currentCampaigns, DEFAULT_TIME_ZONE } from './watch';

/**
 * Property Monitor's tick (ADR 0080, C4 decisions 2 and 4), on the alerts cron. Two halves:
 *
 * 1. Check: each watch at most once an hour, only for buyers with Property Monitor switched on and not blocked.
 *    What changed since the last check becomes events (detect.ts) and the watch remembers what it reported.
 * 2. Email: one message a day at 8 am in the buyer's time zone, only when something happened, with every event
 *    not yet emailed. Marked emailed after the provider accepts it; the idempotency key makes a retry the same send.
 *
 * Paused for everyone (`CONSUMER_SKILLS_PAUSED`): nothing is checked or sent; watches resume where they were.
 */

export const WATCH_CHECK_MINUTES = 55;
export const WATCH_BATCH = 300;
export const WATCH_EMAIL_HOUR = 8;
export const WATCH_EMAIL_BATCH = 100;

export type WatchTickDeps = {
  transport: EmailTransport;
  sender: SenderIdentity;
  baseUrl: string;
  unsubscribeSecret: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

export type WatchTickReport = { checked: number; events: number; emailed: number; skipped?: string };

/** Switched on, row present — Property Monitor is off until a buyer turns it on (ADR 0080). */
const monitorOn = (userIdColumn: typeof propertyWatch.userId | typeof propertyWatchEvent.userId) =>
  sql`exists (select 1 from consumer_skill_switch s where s.user_id = ${userIdColumn} and s.skill_key = 'property_monitor' and s.enabled)`;

/** The hour and the date at `now` in a zone. Pure. */
export function localClock(now: Date, timeZone: string): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { hour: Number(get('hour')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

export async function runWatchTick(db: Db, deps: WatchTickDeps): Promise<WatchTickReport> {
  const now = deps.now?.() ?? new Date();
  if (pausedConsumerSkills(deps.env ?? process.env).has('property_monitor')) return { checked: 0, events: 0, emailed: 0, skipped: 'paused' };
  const checked = await checkWatches(db, now);
  const emailed = await emailDigests(db, deps, now);
  return { checked: checked.checked, events: checked.events, emailed };
}

async function checkWatches(db: Db, now: Date): Promise<{ checked: number; events: number }> {
  const due = await db
    .select({ userId: propertyWatch.userId, propertyId: propertyWatch.propertyId, seenListingId: propertyWatch.seenListingId, seenStatus: propertyWatch.seenStatus, checkedAt: propertyWatch.checkedAt })
    .from(propertyWatch)
    .innerJoin(user, eq(user.id, propertyWatch.userId))
    .where(and(lt(propertyWatch.checkedAt, new Date(now.getTime() - WATCH_CHECK_MINUTES * 60_000)), isNull(user.blockedAt), monitorOn(propertyWatch.userId)))
    .orderBy(asc(propertyWatch.checkedAt), asc(propertyWatch.userId), asc(propertyWatch.propertyId))
    .limit(WATCH_BATCH);
  if (!due.length) return { checked: 0, events: 0 };

  const propertyIds = [...new Set(due.map((w) => w.propertyId))];
  const oldest = due.reduce((m, w) => (w.checkedAt < m ? w.checkedAt : m), due[0]!.checkedAt);
  const [current, changes] = await Promise.all([
    currentCampaigns(db, propertyIds),
    db
      .select({ propertyId: listing.propertyId, listingId: listingPriceChange.listingId, changedAt: listingPriceChange.changedAt, oldDisplay: listingPriceChange.oldDisplay, oldFrom: listingPriceChange.oldFrom, oldTo: listingPriceChange.oldTo, newDisplay: listingPriceChange.newDisplay, newFrom: listingPriceChange.newFrom, newTo: listingPriceChange.newTo })
      .from(listingPriceChange)
      .innerJoin(listing, eq(listing.id, listingPriceChange.listingId))
      .where(and(inArray(listing.propertyId, propertyIds), gt(listingPriceChange.changedAt, oldest)))
      .orderBy(asc(listingPriceChange.changedAt), asc(listingPriceChange.id)),
  ]);

  let events = 0;
  for (const w of due) {
    const c = current.get(w.propertyId) ?? null;
    const lines = [
      ...changes
        .filter((p) => p.propertyId === w.propertyId && p.changedAt > w.checkedAt)
        .map((p) => ({ kind: 'price_changed', listingId: p.listingId, text: `Price changed from ${priceText(p.oldDisplay, p.oldFrom, p.oldTo)} to ${priceText(p.newDisplay, p.newFrom, p.newTo)}.`, happenedAt: p.changedAt })),
      ...watchEvents({ listingId: w.seenListingId, status: w.seenStatus as never }, c).map((e) => ({ ...e, happenedAt: now })),
    ];
    await db.transaction(async (tx) => {
      if (lines.length) await tx.insert(propertyWatchEvent).values(lines.map((l) => ({ userId: w.userId, propertyId: w.propertyId, listingId: l.listingId, kind: l.kind, text: l.text, happenedAt: l.happenedAt })));
      await tx
        .update(propertyWatch)
        .set({ seenListingId: c?.listingId ?? w.seenListingId, seenStatus: standingOf(c), checkedAt: now })
        .where(and(eq(propertyWatch.userId, w.userId), eq(propertyWatch.propertyId, w.propertyId)));
    });
    events += lines.length;
  }
  return { checked: due.length, events };
}

export type DigestGroup = { address: string; link: string; lines: { text: string; on: string }[] };

/** The daily email (decision 4). Marketing kind: it carries the unsubscribe the Spam Act asks for, which switches Property Monitor off. */
export function buildWatchDigest(input: { to: string; sender: SenderIdentity; baseUrl: string; unsubscribeUrl: string; groups: DigestGroup[] }): MarketingMessage {
  requireSenderFooter(input.sender.from, input.sender.postalAddress, 'Property Monitor');
  const count = input.groups.reduce((n, g) => n + g.lines.length, 0);
  const subject = `${count} ${count === 1 ? 'change' : 'changes'} on addresses you watch`;
  const base = input.baseUrl.replace(/\/$/, '');
  const font = "font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;";
  const html = `<div style="max-width:600px;margin:0 auto;">
  <h1 style="${font}font-size:20px;font-weight:700;margin:0 0 16px;">${escapeHtml(subject)}</h1>
  ${input.groups
    .map(
      (g) => `<h2 style="${font}font-size:16px;font-weight:700;margin:18px 0 4px;"><a href="${escapeHtml(g.link)}" style="color:#0b3d2e;">${escapeHtml(g.address)}</a></h2>
  ${g.lines.map((l) => `<p style="${font}margin:2px 0;">${escapeHtml(l.on)} — ${escapeHtml(l.text)}</p>`).join('\n  ')}`,
    )
    .join('\n  ')}
  <p style="${font}font-size:12px;color:#8c8577;margin:24px 0 0;">You get this because Property Monitor is on. <a href="${escapeHtml(`${base}/account/watching`)}">Watching</a> · <a href="${escapeHtml(input.unsubscribeUrl)}">Turn off Property Monitor</a><br>${escapeHtml(input.sender.from.name)} · ${escapeHtml(input.sender.postalAddress)}</p>
</div>`;
  const text = [
    subject,
    '',
    ...input.groups.flatMap((g) => [g.address, ...g.lines.map((l) => `  ${l.on} — ${l.text}`), `  ${g.link}`, '']),
    `Watching: ${base}/account/watching`,
    `Turn off Property Monitor: ${input.unsubscribeUrl}`,
    `${input.sender.from.name} · ${input.sender.postalAddress}`,
  ].join('\n');
  return { kind: 'marketing', to: { email: input.to }, from: input.sender.from, subject, html, text, listUnsubscribeUrl: input.unsubscribeUrl, tags: { feature: 'property_monitor' } };
}

async function emailDigests(db: Db, deps: WatchTickDeps, now: Date): Promise<number> {
  const waiting = await db
    .select({ userId: propertyWatchEvent.userId, email: user.email, timeZone: sql<string>`min(${propertyWatch.timeZone})` })
    .from(propertyWatchEvent)
    .innerJoin(user, eq(user.id, propertyWatchEvent.userId))
    .innerJoin(propertyWatch, and(eq(propertyWatch.userId, propertyWatchEvent.userId), eq(propertyWatch.propertyId, propertyWatchEvent.propertyId)))
    .where(and(isNull(propertyWatchEvent.emailedAt), isNull(user.blockedAt), monitorOn(propertyWatchEvent.userId)))
    .groupBy(propertyWatchEvent.userId, user.email)
    .orderBy(asc(propertyWatchEvent.userId))
    .limit(WATCH_EMAIL_BATCH);

  let sent = 0;
  for (const who of waiting) {
    const clock = localClock(now, who.timeZone || DEFAULT_TIME_ZONE);
    if (clock.hour !== WATCH_EMAIL_HOUR || !who.email) continue;
    const rows = await db
      .select({ id: propertyWatchEvent.id, propertyId: propertyWatchEvent.propertyId, text: propertyWatchEvent.text, happenedAt: propertyWatchEvent.happenedAt, street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`, suburb: property.suburb, state: property.state })
      .from(propertyWatchEvent)
      .innerJoin(property, eq(property.id, propertyWatchEvent.propertyId))
      .where(and(eq(propertyWatchEvent.userId, who.userId), isNull(propertyWatchEvent.emailedAt)))
      .orderBy(asc(propertyWatchEvent.propertyId), asc(propertyWatchEvent.happenedAt), asc(propertyWatchEvent.id));
    if (!rows.length) continue;
    const base = deps.baseUrl.replace(/\/$/, '');
    const groups = new Map<string, DigestGroup>();
    for (const r of rows) {
      const g = groups.get(r.propertyId) ?? { address: [r.street?.trim(), `${r.suburb} ${r.state}`].filter(Boolean).join(', '), link: `${base}/property/${r.propertyId}`, lines: [] };
      g.lines.push({ text: r.text, on: r.happenedAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: who.timeZone || DEFAULT_TIME_ZONE }) });
      groups.set(r.propertyId, g);
    }
    const message = buildWatchDigest({ to: who.email, sender: deps.sender, baseUrl: base, unsubscribeUrl: watchUnsubscribeUrl(base, who.userId, deps.unsubscribeSecret), groups: [...groups.values()] });
    const result = await deps.transport.send({ ...message, idempotencyKey: `watch-digest:${who.userId}:${clock.date}` });
    if (!result.ok) continue;
    await db.update(propertyWatchEvent).set({ emailedAt: now }).where(inArray(propertyWatchEvent.id, rows.map((r) => r.id)));
    sent += 1;
  }
  return sent;
}
