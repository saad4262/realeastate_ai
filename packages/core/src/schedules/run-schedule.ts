import { eq, sql } from 'drizzle-orm';
import { scheduleRun, searchSchedule, type Db } from '@repo/db';
import {
  buildScheduleDigestEmail,
  templateSummary,
  type EmailTransport,
  type SenderIdentity,
} from '../email';
import { unsubscribeUrl } from '../email/unsubscribe';
import { describeSavedQuery, savedQueryToPath, type SavedSearchQuery } from '../listings/search-url';
import type { PublicListingSummary, PublicSearchQuery } from '../listings/search-listings';
import type { ResolvedPlace } from '../geo/place-schema';
import { pruneOldChats } from '../chat/threads';
import { checkAiBudget } from './budget';
import { claimDueSchedules, DEFAULT_CLAIM_LIMIT, type ClaimedSchedule } from './claim';
import { sweepAbandonedRuns } from './sweep-runs';

/** How many listings a run snapshots. The email shows five; the page shows all. */
const SNAPSHOT_LIMIT = 24;

/** Three consecutive failures and the schedule stops claiming. */
const FAILURE_LIMIT = 3;

export type AlertSummaryFacts = {
  description: string;
  matched: number;
  newCount: number;
  /** Already formatted. There is no number here for a model to work on. */
  listings: { headline: string; address: string; price: string; specs: string | null }[];
};

export type AlertSummary =
  | { source: 'model'; text: string }
  | { source: 'template'; text: null };

export type ScheduleDeps = {
  /** The UNCACHED search. See the note in runOneSchedule. */
  search: (query: PublicSearchQuery) => Promise<PublicListingSummary[]>;
  /** Resolve a suburb centre, as /search does. `null` when unavailable. */
  resolvePlace: (query: string) => Promise<ResolvedPlace | null>;
  /** The model, or nothing. Absent means every run uses the template sentence. */
  summarise?: (
    facts: AlertSummaryFacts,
    ctx: { runId: string; userId: string },
  ) => Promise<AlertSummary>;
  transport: EmailTransport;
  sender: SenderIdentity;
  /** Absolute origin for links in the email — NEXT_PUBLIC_WEB_URL. */
  baseUrl: string;
  unsubscribeSecret: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

export type ScheduleRunOutcome = {
  runId: string;
  scheduleId: string;
  status: 'delivered' | 'empty' | 'failed';
  matched: number;
  newCount: number;
  emailStatus: 'sent' | 'failed' | 'skipped';
  summarySource: 'model' | 'template' | 'none';
  error?: string;
};

export type TickReport = {
  claimed: number;
  delivered: number;
  empty: number;
  failed: number;
  emailsSent: number;
  emailsSkipped: number;
  budget: 'ok' | 'global_cap';
  /** Conversations destroyed for being past the retention window. */
  chatsPruned: number;
  /** Runs a previous tick claimed and never finished. Normally 0. */
  runsSwept: number;
  durationMs: number;
};

/**
 * Turn a stored search into one the database can run.
 *
 * The centre is resolved here, at run time, rather than being read out of the
 * stored row. A saved coordinate is a snapshot of what the geocoder thought
 * months ago; `place_cache` is what /search consults on every request, and
 * doing the same thing means a re-geocode improves every saved search at
 * once instead of leaving them all stale.
 *
 * A geocoder outage costs the radius, not the search — exactly the fallback
 * apps/web/app/search/page.tsx already takes.
 */
export async function toRuntimeQuery(
  stored: SavedSearchQuery,
  resolvePlace: ScheduleDeps['resolvePlace'],
): Promise<PublicSearchQuery> {
  const { radiusKm, lat, lng, ...rest } = stored;
  const query: PublicSearchQuery = { ...rest, limit: SNAPSHOT_LIMIT };

  if (!radiusKm) return query;

  if (stored.suburb) {
    try {
      const centre = await resolvePlace(
        [stored.suburb, stored.state, stored.postcode, 'Australia'].filter(Boolean).join(', '),
      );
      if (centre) {
        return {
          ...query,
          near: { lat: Number(centre.latitude), lng: Number(centre.longitude), radiusKm },
        };
      }
    } catch {
      // Fall through to the suburb-only search below.
    }
    return query;
  }

  // No suburb to look up means the visitor picked a street address, which is
  // the one case /search trusts the URL's own coordinates in.
  if (lat !== undefined && lng !== undefined) {
    return { ...query, near: { lat, lng, radiusKm } };
  }

  return query;
}

/**
 * Run one claimed schedule: search, summarise, send, record.
 *
 * ## The order is the rule
 *
 * ARCHITECTURE § 8 — network calls happen before the transaction opens,
 * never inside one. So the search (SQL), the model and the mail provider all
 * happen with no transaction held, and a single short write at the end
 * records what happened.
 *
 * ## The one duplicate this design accepts
 *
 * A crash between "sent" and "recorded" re-sends one email on a later tick.
 * That is the right way round and it is deliberate: a duplicate is a
 * nuisance, a silently missing alert is a broken product. The unique index
 * on `(schedule_id, scheduled_for)` keeps it to one repeat rather than a
 * loop.
 */
export async function runOneSchedule(
  db: Db,
  deps: ScheduleDeps,
  claimed: ClaimedSchedule,
): Promise<ScheduleRunOutcome> {
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const description = describeSavedQuery(claimed.query);

  try {
    /**
     * Deliberately the uncached reader.
     *
     * `cachedSearch` has a 30-second TTL, which is right for a page somebody
     * is looking at and wrong for a once-a-day email: a run must see the
     * database as it is at 8 PM, not as it was for whoever loaded /search a
     * moment earlier. ARCHITECTURE § 6 covers the write side of this; the
     * read side is that a background job has no page whose staleness budget
     * applies to it.
     */
    const runtimeQuery = await toRuntimeQuery(claimed.query, deps.resolvePlace);
    const listings = await deps.search(runtimeQuery);

    const listingIds = listings.map((l) => l.id);
    const previous = new Set(claimed.previousListingIds);
    const newIds = listingIds.filter((id) => !previous.has(id));

    /**
     * Every run sends, including one that found nothing new.
     *
     * This used to return here without emailing, and the reasoning is worth
     * keeping on the record because it was not wrong: a recurring "no
     * change" message is the fastest way to teach somebody to ignore a
     * sender, and it burns list reputation — enough spam complaints and the
     * sending domain stops reaching anybody's inbox, including for the
     * digests that DO carry news.
     *
     * The product owner asked for it anyway, explicitly and twice, and it is
     * their call: the recipient set this schedule up themselves, which is
     * the consent the Spam Act asks for, and every message still carries the
     * sender identity, the postal address and a working one-click
     * unsubscribe. That is what makes it lawful; whether it is wise is a
     * judgement about their own list.
     *
     * `status` stays `empty`, because it describes what the SEARCH found and
     * that has not changed. What changed is that an empty run is now also a
     * delivery — which is why `/alerts` lists what was emailed rather than
     * what was `delivered`, and why `claimDueSchedules` still anchors the
     * "what is new" diff on the last genuinely delivered run rather than on
     * the last email.
     */
    const foundSomethingNew = newIds.length > 0;

    // ---- the model, if there is budget and a summariser at all -----------
    let summary: AlertSummary = { source: 'template', text: null };

    /**
     * No prose for a digest with no news.
     *
     * `templateSummary` already writes the right sentence for it — "No new
     * listings since we last looked. 3 still match …" — and there is nothing
     * for a model to add to that. It matters at this cadence: a 10-minute
     * schedule is 144 runs a day, and paying for a paragraph on the ~140 of
     * them that say "nothing changed" is the whole per-user budget spent on
     * the least interesting sentence in the product.
     */
    if (deps.summarise && foundSomethingNew) {
      const budget = await checkAiBudget(db, { userId: claimed.userId, now, env });
      if (budget.allowed) {
        summary = await deps.summarise(
          {
            description,
            matched: listings.length,
            newCount: newIds.length,
            listings: listings.slice(0, 5).map(toFacts),
          },
          { runId: claimed.runId, userId: claimed.userId },
        );
      }
      /**
       * Over budget still delivers. Only the prose is metered — the search is
       * SQL and costs nothing — so a cap costs a plainer sentence rather than
       * somebody's alert. ADR 0010 says so; this is where it is true.
       */
    }

    const summaryText =
      summary.source === 'model' && summary.text
        ? summary.text
        : templateSummary({ newCount: newIds.length, matched: listings.length, description });

    // ---- the email -------------------------------------------------------
    const message = buildScheduleDigestEmail({
      to: { email: claimed.email },
      from: deps.sender.from,
      postalAddress: deps.sender.postalAddress,
      scheduleName: claimed.name,
      description,
      matched: listings.length,
      newCount: newIds.length,
      listings,
      summary: summaryText,
      summarySource: summary.source,
      resultsUrl: `${deps.baseUrl.replace(/\/$/, '')}${savedQueryToPath(claimed.query)}`,
      unsubscribeUrl: unsubscribeUrl(
        deps.baseUrl,
        claimed.scheduleId,
        claimed.userId,
        deps.unsubscribeSecret,
      ),
    });

    const sent = await deps.transport.send(message);

    await finishRun(db, claimed, {
      // `delivered` means the run had news to deliver. An emailed run that
      // found nothing is still `empty` — the email went, the search was
      // empty, and those are two different facts in two different columns.
      status: foundSomethingNew ? 'delivered' : 'empty',
      matched: listings.length,
      newCount: newIds.length,
      listingIds,
      listings,
      summary: summaryText,
      summarySource: summary.source,
      emailStatus: sent.ok ? 'sent' : 'failed',
      emailError: sent.ok ? null : sent.error,
      now,
    });

    return {
      runId: claimed.runId,
      scheduleId: claimed.scheduleId,
      /**
       * `delivered` even when the email failed, and that is not a fudge.
       * The run produced results and they are on /alerts — the in-app channel
       * succeeded. `email_status` records the channel that did not, which is
       * the honest shape: one delivery failing is not the run failing.
       *
       * `empty` when the search found nothing new, whether or not the email
       * went. Same distinction as the row above.
       */
      status: foundSomethingNew ? 'delivered' : 'empty',
      matched: listings.length,
      newCount: newIds.length,
      emailStatus: sent.ok ? 'sent' : 'failed',
      summarySource: summary.source,
      ...(sent.ok ? {} : { error: sent.error }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Run failed';

    await db.transaction(async (tx) => {
      await tx
        .update(scheduleRun)
        .set({
          status: 'failed',
          error: message.slice(0, 500),
          finishedAt: now,
          updatedAt: sql`now()`,
        })
        .where(eq(scheduleRun.id, claimed.runId));

      const failures = claimed.consecutiveFailures + 1;
      await tx
        .update(searchSchedule)
        .set({
          consecutiveFailures: failures,
          /**
           * Three in a row and it stops claiming.
           *
           * `failing` rather than `paused`, because they mean opposite
           * things — one is a decision somebody made, the other is the
           * system giving up — and a dashboard that shows them the same way
           * is how a broken alert becomes a silent one.
           */
          ...(failures >= FAILURE_LIMIT ? { status: 'failing' as const } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(searchSchedule.id, claimed.scheduleId));
    });

    return {
      runId: claimed.runId,
      scheduleId: claimed.scheduleId,
      status: 'failed',
      matched: 0,
      newCount: 0,
      emailStatus: 'skipped',
      summarySource: 'none',
      error: message,
    };
  }
}

function toFacts(listing: PublicListingSummary) {
  // Requires the formatters rather than the raw columns: the model is handed
  // strings, so there is no number in its input to round or recompute (#4).
  return {
    headline: listing.headline ?? '',
    address: `${listing.address}, ${listing.suburb} ${listing.state}`,
    price: listing.priceDisplay ?? '',
    specs: null as string | null,
  };
}

async function finishRun(
  db: Db,
  claimed: ClaimedSchedule,
  outcome: {
    status: 'delivered' | 'empty';
    matched: number;
    newCount: number;
    listingIds: string[];
    listings: PublicListingSummary[];
    summary: string | null;
    summarySource: 'model' | 'template' | 'none';
    emailStatus: 'sent' | 'failed' | 'skipped';
    emailError?: string | null;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(scheduleRun)
      .set({
        status: outcome.status,
        matched: outcome.matched,
        newCount: outcome.newCount,
        listingIds: outcome.listingIds,
        listings: outcome.listings,
        summary: outcome.summary,
        summarySource: outcome.summarySource,
        emailStatus: outcome.emailStatus,
        emailedAt: outcome.emailStatus === 'sent' ? outcome.now : null,
        emailError: outcome.emailError ?? null,
        finishedAt: outcome.now,
        updatedAt: sql`now()`,
      })
      .where(eq(scheduleRun.id, claimed.runId));

    // A run that got this far is a working schedule, whatever the email did.
    await tx
      .update(searchSchedule)
      .set({ consecutiveFailures: 0, updatedAt: sql`now()` })
      .where(eq(searchSchedule.id, claimed.scheduleId));
  });
}

/**
 * One cron tick: claim a batch, run each, report.
 *
 * Both metered things — the model and the mail provider — arrive as ports,
 * which is what lets `pnpm smoke` drive this whole pipeline for free with
 * `fakeTransport()` and no summariser. Dry mode is not a separate code path;
 * it is the injection point already in the signature.
 */
export async function runScheduleTick(
  db: Db,
  deps: ScheduleDeps,
  /** `ownerId` narrows the tick to one person — see claimDueSchedules. */
  opts: { limit?: number; ownerId?: string } = {},
): Promise<TickReport> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;

  const report: TickReport = {
    claimed: 0,
    delivered: 0,
    empty: 0,
    failed: 0,
    emailsSent: 0,
    emailsSkipped: 0,
    budget: 'ok',
    chatsPruned: 0,
    runsSwept: 0,
    durationMs: 0,
  };

  /**
   * Retention, enforced here because here is the thing that already runs on
   * a clock.
   *
   * APP 11.2 requires personal information no longer needed to be
   * destroyed, and a retention policy whose enforcement is a cron nobody
   * set up is a policy that exists only in a document. It runs before the
   * budget check on purpose: deleting old data is free, and must not be
   * skipped because the model budget happens to be spent.
   */
  try {
    report.chatsPruned = await pruneOldChats(db, { now });
  } catch (err) {
    // A failed prune must not cost anybody their alert.
    console.error('[scheduler] chat retention sweep failed', err);
  }

  /**
   * Close out any run a previous tick claimed and never finished.
   *
   * Same placement and same reasoning as the prune above: it costs one
   * UPDATE, it must not be skipped when the model budget is spent, and a
   * failure here must not cost anybody their alert. Self-healing, so a
   * crashed deploy does not leave rows nobody will ever look for.
   */
  try {
    report.runsSwept = await sweepAbandonedRuns(db, { now });
  } catch (err) {
    console.error('[scheduler] abandoned-run sweep failed', err);
  }

  /**
   * The global cap is checked before anything is claimed.
   *
   * Claiming and then refusing would burn the slot: the cursor moves, the run
   * row exists, and the person silently misses a day. Not claiming leaves
   * `next_run_at` in the past, so the next tick after the window rolls over
   * picks it up.
   */
  const budget = await checkAiBudget(db, { now, env });
  if (!budget.allowed && budget.reason === 'global_cap') {
    report.budget = 'global_cap';
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  const claimed = await claimDueSchedules(db, {
    now,
    limit: opts.limit ?? DEFAULT_CLAIM_LIMIT,
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
  });
  report.claimed = claimed.length;

  for (const schedule of claimed) {
    const outcome = await runOneSchedule(db, deps, schedule);

    if (outcome.status === 'delivered') report.delivered += 1;
    else if (outcome.status === 'empty') report.empty += 1;
    else report.failed += 1;

    if (outcome.emailStatus === 'sent') report.emailsSent += 1;
    else if (outcome.emailStatus === 'skipped') report.emailsSkipped += 1;
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}
