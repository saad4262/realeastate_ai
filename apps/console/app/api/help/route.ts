import { NextResponse, type NextRequest } from 'next/server';
import { answerHelp } from '@repo/ai/help-bot';
import { buildHelpGuide, checkHelpAllowed, helpHrefs, helpPageContext, helpReplyLinks, helpRequestSchema, type HelpSurface } from '@repo/core/help';
import { SHELLS } from '@/components/shell/surfaces';
import { getConsoleDb } from '../../../lib/db';
import { loadActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';
import { apiError } from '@repo/core/http/api-error';

/**
 * One answer from the help bot (ADR 0088). Thin by rule (#10): who is asking, which console (middleware's
 * header, #12), a parsed request, the gate, then the pipeline in packages/ai. Nothing said here is stored.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const userId = await actionUserId();
  const actor = userId ? await loadActor(userId) : null;
  if (!actor?.agencyId) return apiError(403, 'Sign in to an agency to use help.');

  const parsed = helpRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, 'That message could not be read.');

  const header = request.headers.get('x-console-surface');
  const surface: HelpSurface | null = header === 'agency' || header === 'agent' ? header : null;
  if (!surface) return apiError(403, 'Help is not available here.');

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return apiError(503, 'Help is not set up on this server.');

  const db = getConsoleDb();
  try {
    const gate = await checkHelpAllowed(db, actor);
    if (!gate.allowed) return apiError(429, gate.message ?? 'Help is busy right now. Try again in a minute.');
    const { groups } = SHELLS[surface];
    const text = await answerHelp(
      { apiKey, db },
      {
        guide: buildHelpGuide(surface, groups),
        page: helpPageContext(parsed.data.path, surface, groups),
        role: actor.membershipRole ?? null,
        messages: parsed.data.messages,
        userId: actor.userId,
        agencyId: actor.agencyId,
      },
    );
    if (!text) return apiError(502, 'I could not answer that one. Try asking another way.');
    return NextResponse.json({ text, links: helpReplyLinks(text, helpHrefs(surface, groups)) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[help] answer failed', err instanceof Error ? err.message : 'unknown');
    return apiError(503, 'Help is not available right now. Please try again.');
  }
}
