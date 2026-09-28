import { writeAlertSummary } from '@repo/ai/alert-summary';
import { ALERT_SUMMARY_PROMPT_VERSION } from '@repo/ai/alert-summary';
import { trackAiRunQuietly } from '@repo/ai/usage';
import { requireSenderIdentity, requireResendTransport, dryRunTransport } from '@repo/core/email';
import { requireUnsubscribeSecret } from '@repo/core/email';
import { resolvePlace } from '@repo/core/geo';
import { searchPublicListings } from '@repo/core/listings';
import type { ScheduleDeps } from '@repo/core/schedules';
import { getWebDb } from './db';

/**
 * Everything the scheduler needs, wired to this app's real services.
 *
 * Assembled here rather than in the route handler because #10 keeps logic
 * out of apps/ — the route is a secret check and a function call, and this
 * is the composition root.
 *
 * ## The readers are the UNCACHED ones
 *
 * `searchPublicListings` and `resolvePlace`, not `cachedSearch` and
 * `cachedPlace`. A 30-second Data Cache TTL is right for a page somebody is
 * looking at and wrong for a once-a-day email: the run must see the database
 * as it is at 8 PM, not as it was for whoever last loaded /search.
 * ARCHITECTURE § 6 covers the write side of cross-process cache
 * invalidation; this is the read side of the same idea — a background job
 * has no page whose staleness budget applies to it.
 */
export function schedulerDeps(): ScheduleDeps {
  const db = getWebDb();
  const sender = requireSenderIdentity();
  const unsubscribeSecret = requireUnsubscribeSecret();

  /**
   * `ALERTS_DRY_RUN=1` runs the whole pipeline and sends nothing.
   *
   * Not a separate code path — the transport is already a port, so dry mode
   * is a different value in the same slot. That is what makes it worth
   * trusting: the thing exercised in dry mode is the thing that ships.
   */
  const transport =
    process.env.ALERTS_DRY_RUN === '1' ? dryRunTransport() : requireResendTransport();

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  return {
    search: (query) => searchPublicListings(db, query),
    resolvePlace: (query) => resolvePlace(db, query),
    transport,
    sender,
    baseUrl: process.env.NEXT_PUBLIC_WEB_URL ?? 'http://web.lvh.me:3000',
    unsubscribeSecret,

    /**
     * Absent when there is no key, and absence is meaningful: `runOneSchedule`
     * uses the templated sentence and never calls a model. The alert still
     * goes out. An unconfigured key costs prose, not somebody's delivery.
     */
    ...(apiKey
      ? {
          summarise: async (facts, ctx) =>
            writeAlertSummary({
              apiKey,
              facts,
              runId: ctx.runId,
              userId: ctx.userId,
              track: (row) =>
                trackAiRunQuietly(db, {
                  feature: 'alert-summary',
                  model: row.model,
                  usage: row.usage,
                  latencyMs: row.latencyMs,
                  entityId: row.entityId,
                  userId: row.userId,
                  promptVersion: ALERT_SUMMARY_PROMPT_VERSION,
                }),
            }).then((result) =>
              result.source === 'model'
                ? ({ source: 'model', text: result.text } as const)
                : ({ source: 'template', text: null } as const),
            ),
        }
      : {}),
  };
}
