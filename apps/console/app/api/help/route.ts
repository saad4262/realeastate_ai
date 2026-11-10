import { NextResponse, type NextRequest } from 'next/server';
import { answerHelp } from '@repo/ai/help-bot';
import { buildHelpGuide, checkHelpAllowed, helpHrefs, helpPageContext, helpReplyLinks, helpRequestSchema, type HelpSurface } from '@repo/core/help';
import { SHELLS } from '@/components/shell/surfaces';
import { getConsoleDb } from '../../../lib/db';
import { loadActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';

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
  if (!actor?.agencyId) return NextResponse.json({ error: 'Sign in to an agency to use help.' }, { status: 403 });

  const parsed = helpRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'That message could not be read.' }, { status: 400 });

  const header = request.headers.get('x-console-surface');
  const surface: HelpSurface | null = header === 'agency' || header === 'agent' ? header : null;
  if (!surface) return NextResponse.json({ error: 'Help is not available here.' }, { status: 403 });

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'Help is not set up on this server.' }, { status: 503 });

  const db = getConsoleDb();
  try {
    const gate = await checkHelpAllowed(db, actor);
    if (!gate.allowed) return NextResponse.json({ error: gate.message }, { status: 429 });
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
    if (!text) return NextResponse.json({ error: 'I could not answer that one. Try asking another way.' }, { status: 502 });
    return NextResponse.json({ text, links: helpReplyLinks(text, helpHrefs(surface, groups)) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[help] answer failed', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Help is not available right now. Please try again.' }, { status: 503 });
  }
}
