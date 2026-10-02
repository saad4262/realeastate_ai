import { NextResponse, type NextRequest } from 'next/server';
import {
  chatRequestSchema,
  PROMPT_VERSION,
  runPropertyChat,
  trackAiRunQuietly,
  type ChatEvent,
  type ChatTurnResult,
  type ToolContext,
} from '@repo/ai/chat';
import { appendTurn } from '@repo/core/chat';
import {
  listSchedules,
  requireDraftSecret,
  updateSchedule,
} from '@repo/core/schedules';
import { getWebDb } from '../../../lib/db';
import { ensureConsumerAccount } from '../../../lib/account';
import { currentWebUser } from '../../../lib/session';
import {
  cachedFilterOptions,
  cachedListing,
  cachedNearbyMarket,
  cachedRecentSales,
  cachedPlace,
  cachedSearch,
} from '../../../lib/cached';

/** postgres.js opens raw sockets, so this cannot run on the edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A three-round turn can outlast a platform's default 10s function timeout. */
export const maxDuration = 60;

/**
 * The property chat.
 *
 * Everything about the conversation — the prompt, the tools, the loop — lives
 * in @repo/ai (non-negotiable #3). This handler rate-limits, validates, wires
 * the cached readers in, and serialises whatever the pipeline yields. That is
 * plumbing, not business logic (#10).
 */

/**
 * Requests per IP per minute.
 *
 * Far tighter than the places endpoint, because this one is in front of a
 * metered model rather than a cached geocoder. Read the comment there and then
 * read this one: an in-process counter is a ceiling on ACCIDENTAL cost. It is
 * not a security control — a determined caller rotates IPs, and behind several
 * instances the real ceiling is this times the instance count. The backstop
 * that actually matters is a spend cap set in the Anthropic console.
 */
const LIMIT = 10;
const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };

const BUCKETS = Symbol.for('@repo/web.chat-rate-limit');
const DAILY = Symbol.for('@repo/web.chat-daily-cap');

function buckets(): Map<string, Bucket> {
  const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  return (g[BUCKETS] ??= new Map());
}

function overLimit(request: NextRequest): boolean {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  const now = Date.now();
  const map = buckets();
  const current = map.get(ip);

  if (!current || current.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (map.size > 5000) {
      for (const [key, bucket] of map) if (bucket.resetAt < now) map.delete(key);
    }
    return false;
  }

  current.count += 1;
  return current.count > LIMIT;
}

/**
 * Turns this process will serve today.
 *
 * The per-IP limit stops one visitor; this stops all of them. It is the only
 * thing between a quiet afternoon and a bill, short of the console cap.
 */
function overDailyCap(): boolean {
  const cap = Number(process.env.AI_CHAT_DAILY_TURN_CAP ?? 2000);
  const g = globalThis as unknown as Record<symbol, Bucket | undefined>;
  const now = Date.now();
  const current = g[DAILY];

  if (!current || current.resetAt < now) {
    g[DAILY] = { count: 1, resetAt: now + 86_400_000 };
    return false;
  }

  current.count += 1;
  return current.count > cap;
}

function frame(event: ChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function errorResponse(event: ChatEvent, status: number): NextResponse {
  return NextResponse.json(event, { status });
}

/**
 * The readers the tools use.
 *
 * All four go through apps/web/lib/cached.ts. The pipeline takes them as
 * functions precisely so @repo/ai never imports unstable_cache — that is a
 * Next API, and the package should not know which framework called it.
 */
/**
 * The scheduling half of the tool context, or WHY it cannot run.
 *
 * The two reasons are reported separately on purpose. This used to return
 * `undefined` for both, and an anonymous visitor asking to be emailed
 * daily was told "scheduling isn't available at the moment" — which is
 * false, unactionable, and reads as a broken feature when the fix is to
 * sign in. Seen in a real conversation.
 */
function schedulingContext(userId: string | null): ToolContext['scheduling'] {
  if (!userId) return { state: 'signed_out' };

  let draftSecret: string;
  try {
    draftSecret = requireDraftSecret();
  } catch {
    // ALERT_UNSUBSCRIBE_SECRET is unset. Nobody in the conversation can
    // fix that, so the model must not send the visitor off to try.
    return { state: 'unconfigured' };
  }

  const db = getWebDb();
  const actor = { userId };

  return {
    state: 'ready',
    draftSecret,
    listSchedules: async () =>
      (await listSchedules(db, actor)).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        status: s.status,
      })),
    /**
     * Pause, never delete, and `can()` decides inside `updateSchedule`.
     *
     * The id reaching here came from `listSchedules` for this same actor,
     * so it is already theirs — but the check is not skipped on that
     * basis. A model choosing which id to act on is exactly the situation
     * where the authorisation should not be inferred from context.
     */
    pauseSchedule: async (id: string) => {
      try {
        await updateSchedule(db, actor, id, { status: 'paused' });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function toolContext(userId: string | null): ToolContext {
  const db = getWebDb();
  return {
    db,
    scheduling: schedulingContext(userId),
    places: new Map(),
    resolvePlace: (query) => cachedPlace(query),
    search: async (query) => {
      const { rows, down } = await cachedSearch(query);
      /**
       * A database that is down must not read as "nothing matched".
       *
       * cachedSearch degrades to an empty list so a page still renders, which
       * is right for a page. Here it would have the guide tell a visitor there
       * are no homes in their suburb, confidently and wrongly. Throwing lets
       * dispatchTool say the database could not be reached.
       */
      if (down) throw new Error('database unavailable');
      return rows;
    },
    getListing: (id) => cachedListing(id),
    nearbyMarket: (query) => cachedNearbyMarket(query),
    recentSales: (query) => cachedRecentSales(query),
  };
}

/**
 * Save the exchange, if there is somebody to save it for.
 *
 * Both turns in one transaction: half an exchange in the record — a
 * question with no answer — is worse than none, because reopening the
 * thread would replay it to the model as though the guide had said nothing.
 *
 * Failure is swallowed on purpose. A visitor who asked about a house has
 * already had their answer streamed to them; losing the transcript is a
 * smaller harm than a 500 after a successful turn, and the same trade
 * `trackAiRunQuietly` makes one line above.
 */
async function persistTurn(input: {
  userId: string | null;
  threadId: string | null;
  userMessage: string;
  answer: string;
  citations: { query: unknown; matched: number; shown: number }[];
  resultsFrame: unknown;
  salesFrame: unknown;
  deepLink: string | null;
}): Promise<string | null> {
  if (!input.userId) return null;
  if (!input.threadId && !input.answer.trim()) return null;

  try {
    /**
     * The `public.user` row has to exist before anything can reference it.
     *
     * Normally the sign-in action created it. This is the belt: a session
     * minted before that existed, or a row removed underneath us, would
     * otherwise fail the foreign key and lose the transcript silently —
     * which is exactly how this was found.
     */
    await ensureConsumerAccount();

    const db = getWebDb();
    const actor = { userId: input.userId };

    return await db.transaction(async (tx) => {
      const { threadId } = await appendTurn(tx, actor, {
        threadId: input.threadId,
        role: 'user',
        text: input.userMessage,
      });

      await appendTurn(tx, actor, {
        threadId,
        role: 'assistant',
        text: input.answer,
        searches: input.citations.length > 0 ? input.citations : null,
        resultsFrame: input.resultsFrame,
        salesFrame: input.salesFrame,
        deepLink: input.deepLink,
      });

      return threadId;
    });
  } catch (err) {
    console.error('[chat] failed to save the conversation', err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  // Before validation, so a flood of malformed bodies is cheap too.
  if (overLimit(request)) {
    return errorResponse(
      { type: 'error', code: 'rate_limited', message: 'Too many messages. Wait a moment.' },
      429,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(
      { type: 'error', code: 'bad_request', message: 'Could not read that message.' },
      400,
    );
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      { type: 'error', code: 'bad_request', message: 'That message could not be understood.' },
      400,
    );
  }

  /**
   * The key and the cap come AFTER validation, cheaply.
   *
   * Validation is pure CPU on a body of at most a thousand characters, and
   * doing it first means a malformed request is told it was malformed rather
   * than being told the service is down — which was the wrong answer, and the
   * one that would have sent someone looking at the deployment.
   */
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(
      {
        type: 'error',
        code: 'unconfigured',
        message: 'The property guide is not available right now. Try the search page instead.',
      },
      503,
    );
  }

  if (overDailyCap()) {
    return errorResponse(
      {
        type: 'error',
        code: 'daily_cap',
        message: 'The property guide is resting for today. Try the search page instead.',
      },
      503,
    );
  }

  /**
   * Read once, here, and passed down.
   *
   * The scheduling tools and the transcript writer both need it, and
   * `currentWebUser` is a header read with no I/O — but calling it twice
   * would make it look like two different questions were being asked.
   */
  const sessionUser = await currentWebUser();
  const sessionUserId = sessionUser?.id ?? null;

  let catalogue: { suburbs: string[]; propertyTypes: string[] };
  let tools: ToolContext;
  try {
    catalogue = await cachedFilterOptions();
    tools = toolContext(sessionUserId);
  } catch {
    return errorResponse(
      {
        type: 'error',
        code: 'upstream',
        message: 'The property database could not be reached. Please try again shortly.',
      },
      503,
    );
  }

  const db = tools.db;

  /**
   * The thread to append to, as a header rather than a body field.
   *
   * `chatRequestSchema` is `.strict()` and describes what the MODEL is
   * given; a thread id is app plumbing and has no business in it. Widening
   * that schema for storage would blur the one boundary it exists to hold.
   * An id the session does not own is refused in appendTurn.
   */
  const threadId = request.headers.get('x-chat-thread')?.trim() || null;

  const turn = runPropertyChat({
    apiKey,
    request: parsed.data,
    catalogue,
    tools,
    signal: request.signal,
    track: (row) =>
      trackAiRunQuietly(db, {
        feature: 'property-chat',
        model: row.model,
        usage: row.usage,
        latencyMs: row.latencyMs,
        entityId: row.entityId,
        promptVersion: PROMPT_VERSION,
      }),
  });

  /**
   * One buffered object for callers that cannot stream.
   *
   * pnpm smoke uses this, which is what keeps the NDJSON parser from being
   * written twice — once for the browser and once for a test runner that would
   * then be testing its own copy rather than the one that ships.
   */
  if (request.headers.get('accept')?.includes('application/json')) {
    const collected: ChatTurnResult = {
      id: '',
      text: '',
      results: [],
      sales: [],
      tools: [],
      state: null,
      suggestions: [],
      error: null,
      stopReason: null,
      rounds: 0,
    };

    for await (const event of turn) {
      switch (event.type) {
        case 'turn':
          collected.id = event.id;
          break;
        case 'text':
          collected.text += event.delta;
          break;
        case 'results':
          collected.results.push(event);
          break;
        case 'sales':
          collected.sales.push(event);
          break;
        case 'tool':
          // Name and label only. The tool's RESULT is never collected — it is
          // the model's working, not the visitor's answer, and some of it
          // (coordinates, ids) is deliberately kept out of reach.
          collected.tools.push({ name: event.name, label: event.label });
          break;
        case 'state':
          collected.state = event;
          break;
        case 'suggestions':
          collected.suggestions = event.items;
          break;
        case 'error':
          collected.error = event;
          break;
        case 'done':
          collected.stopReason = event.stopReason;
          collected.rounds = event.rounds;
          break;
      }
    }

    return NextResponse.json(collected, { headers: { 'cache-control': 'no-store' } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * Collected as the stream goes out, and written once at the end.
       *
       * Only for a signed-in visitor — see persistTurn. An anonymous
       * conversation is not stored at all, which is both the smaller privacy
       * surface and the honest behaviour for somebody who has not said who
       * they are.
       */
      let answer = '';
      const citations: { query: unknown; matched: number; shown: number }[] = [];
      let lastResults: unknown = null;
      // Saved too, or reopening the thread loses the sold cards, their map and
      // the "View all sold" link that the answer above them points at.
      let lastSales: unknown = null;
      let lastLink: string | null = null;

      try {
        for await (const event of turn) {
          controller.enqueue(encoder.encode(frame(event)));

          if (event.type === 'text') answer += event.delta;
          else if (event.type === 'results') {
            citations.push({
              query: event.query,
              matched: event.matched,
              shown: event.listings.length,
            });
            lastResults = event;
            lastLink = event.deepLink;
          } else if (event.type === 'sales') {
            lastSales = event;
          } else if (event.type === 'state' && event.deepLink) {
            lastLink = event.deepLink;
          }
        }

        const savedId = await persistTurn({
          userId: sessionUserId,
          threadId,
          userMessage: parsed.data.message,
          answer,
          citations,
          resultsFrame: lastResults,
          salesFrame: lastSales,
          deepLink: lastLink,
        });

        // After `done`, so a client that stops reading early loses only the
        // id and never a word of the answer.
        if (savedId) {
          controller.enqueue(encoder.encode(frame({ type: 'saved', threadId: savedId })));
        }
      } catch (err) {
        console.error('[chat] stream failed', err);
        try {
          controller.enqueue(
            encoder.encode(
              frame({
                type: 'error',
                code: 'upstream',
                message: 'The answer stopped unexpectedly. Please try again.',
              }),
            ),
          );
        } catch {
          // The client is already gone; there is nobody to tell.
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      // The visitor closed the tab. request.signal is what the pipeline reads;
      // returning ends the iteration and its finally block still runs.
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      // no-transform and x-accel-buffering are the two that stop a proxy
      // buffering the whole body and handing the browser a fake stream.
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
