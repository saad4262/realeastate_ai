import { NextResponse } from 'next/server';
import { listNotifications } from '@repo/core/notifications';
import { getConsoleDb } from '../../../lib/db';
import { loadActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';

/**
 * The bell's latest 20 and unread count (ADR 0032 §4). Core narrows the read to
 * the person's own rows and asks can(); nothing here takes an id from the
 * browser. A GET rather than a Server Action because the bell polls it — see
 * api/live/route.ts for what a polled action did to navigation. Marking read is
 * a click, and stays an action.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await actionUserId();
  if (!userId) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  try {
    const actor = await loadActor(userId);
    if (!actor) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    return NextResponse.json(await listNotifications(getConsoleDb(), actor), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // A failure is an empty bell, never an error page.
    console.error('[notifications] list failed', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ rows: [], unread: 0 }, { headers: { 'cache-control': 'no-store' } });
  }
}
