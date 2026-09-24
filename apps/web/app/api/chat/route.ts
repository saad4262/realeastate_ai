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
import { getWebDb } from '../../../lib/db';
import { cachedFilterOptions, cachedListing, cachedPlace, cachedSearch } from '../../../lib/cached';

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
function toolContext(): ToolContext {
  const db = getWebDb();
  return {
    db,
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
  };
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

  let catalogue: { suburbs: string[]; propertyTypes: string[] };
  let tools: ToolContext;
  try {
    catalogue = await cachedFilterOptions();
    tools = toolContext();
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
      state: null,
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
        case 'state':
          collected.state = event;
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
      try {
        for await (const event of turn) {
          controller.enqueue(encoder.encode(frame(event)));
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
