import { NextResponse, type NextRequest } from 'next/server';
import { automationStatus, runningAutomationCount, skillsPanel } from '@repo/core/automation-status';
import { getConsoleDb } from '../../../lib/db';
import { loadActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';

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
  if (!userId) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  try {
    const actor = await loadActor(userId);
    if (!actor) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const db = getConsoleDb();
    if (request.nextUrl.searchParams.get('count') === '1') {
      const count = await runningAutomationCount(db, actor);
      return count === null ? NextResponse.json({ error: 'Forbidden' }, { status: 403 }) : NextResponse.json({ count }, { headers: HEADERS });
    }
    if (request.nextUrl.searchParams.get('view') === 'skills') {
      const panel = await skillsPanel(db, actor);
      return panel ? NextResponse.json(panel, { headers: HEADERS }) : NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const status = await automationStatus(db, actor);
    return status ? NextResponse.json(status, { headers: HEADERS }) : NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  } catch (err) {
    // A failure is an empty panel, never an error page.
    console.error('[automations] read failed', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Unavailable' }, { status: 503, headers: HEADERS });
  }
}
