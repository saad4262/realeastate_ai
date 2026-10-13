import { NextResponse, type NextRequest } from 'next/server';
import { can } from '@repo/core/permissions';
import { assistantDeps, assistantTurnRequestSchema, runAssistantTurn, type AssistantEvent } from '@repo/ai/assistant';
import { getConsoleDb } from '../../../lib/db';
import { loadListingActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';

/**
 * One turn of the console assistant, as NDJSON (docs/adr/0025, Phase A).
 *
 * Thin by rule (#10): who is asking (the session middleware verified), which
 * console (middleware's header, #12), a parsed request — then the pipeline in
 * packages/ai does everything else, as this person, through packages/core.
 * The route never sees the model client (#3).
 */

/** postgres.js opens raw sockets, so not the edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const frame = (e: AssistantEvent) => `${JSON.stringify(e)}\n`;

function oneFrame(e: AssistantEvent, status = 200) {
  return new Response(frame(e) + frame({ type: 'done' }), {
    status,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  const userId = await actionUserId();
  // With its listing links, as the leads and mail screens do (ADR 0040): a lead on their listing is theirs to read.
  const actor = userId ? await loadListingActor(userId) : null;
  if (!actor?.agencyId || !can(actor, 'assistant:use', { type: 'assistant', agencyId: actor.agencyId })) {
    return oneFrame({ type: 'error', code: 'forbidden', message: 'Sign in to an agency to use the assistant.' }, 403);
  }

  const body = await request.json().catch(() => null);
  const parsed = assistantTurnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return oneFrame({ type: 'error', code: 'upstream', message: 'The assistant is not set up on this server (ANTHROPIC_API_KEY).' });
  }

  const surface = request.headers.get('x-console-surface') === 'agency' ? 'agency' : 'agent';
  const turn = runAssistantTurn({
    apiKey,
    deps: assistantDeps(getConsoleDb(), actor, parsed.data, surface),
    request: parsed.data,
    surface,
    signal: request.signal,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of turn) controller.enqueue(encoder.encode(frame(event)));
      } catch (err) {
        console.error('[assistant] stream failed', err);
        try {
          controller.enqueue(encoder.encode(frame({ type: 'error', code: 'upstream', message: 'The answer stopped unexpectedly. Please try again.' })));
        } catch {
          // The person already closed the panel.
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
