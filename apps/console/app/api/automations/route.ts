import { NextResponse, type NextRequest } from 'next/server';
import { automationStatus, runningAutomationCount, skillsPanel } from '@repo/core/automation-status';
import { AUTOMATION_KEY, automationDetail, automationsOfChat } from '@repo/core/recurring';
import { getConsoleDb } from '../../../lib/db';
import { loadActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';
import { apiError } from '@repo/core/http/api-error';

/**
 * The top bar's two panels (ADR 0088). `?count=1` is the Automations badge, `?view=skills` the Skills panel; with neither, Automations. Core narrows every
 * read to what this person may see and takes no id from the browser. A GET because it is polled: see
 * api/live/route.ts for what a polled action did to navigation.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store' };

export async function GET(request: NextRequest) {
  const userId = await actionUserId();
  if (!userId) return apiError(401, 'Not signed in');
  try {
    const actor = await loadActor(userId);
    if (!actor) return apiError(401, 'Not signed in');
    const db = getConsoleDb();
    if (request.nextUrl.searchParams.get('count') === '1') {
      const count = await runningAutomationCount(db, actor);
      return count === null ? apiError(403, 'Forbidden') : NextResponse.json({ count }, { headers: HEADERS });
    }
    // One automation in full, or the ones made in one chat (the panel beside it). Each is narrowed to this person in core.
    const detail = request.nextUrl.searchParams.get('detail');
    if (detail !== null) {
      if (!AUTOMATION_KEY.test(detail)) return apiError(404, 'Not found');
      const d = await automationDetail(db, actor, detail);
      return d ? NextResponse.json(d, { headers: HEADERS }) : apiError(404, 'Not found');
    }
    const chat = request.nextUrl.searchParams.get('chat');
    if (chat !== null) return NextResponse.json(await automationsOfChat(db, actor, chat), { headers: HEADERS });
    if (request.nextUrl.searchParams.get('view') === 'skills') {
      const panel = await skillsPanel(db, actor);
      return panel ? NextResponse.json(panel, { headers: HEADERS }) : apiError(403, 'Forbidden');
    }
    const status = await automationStatus(db, actor);
    return status ? NextResponse.json(status, { headers: HEADERS }) : apiError(403, 'Forbidden');
  } catch (err) {
    // A failure is an empty panel, never an error page.
    console.error('[automations] read failed', err instanceof Error ? err.message : 'unknown');
    return apiError(503, 'Unavailable', { headers: HEADERS });
  }
}
