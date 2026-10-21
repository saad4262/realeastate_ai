import { NextResponse } from 'next/server';
import { consoleLiveStamp } from '@repo/core/mail';
import { touchLastSeen } from '@repo/core/platform';
import { getConsoleDb } from '../../../lib/db';
import { loadListingActor } from '../../../lib/load-actor';
import { actionUserId } from '../../../lib/auth-account';

/**
 * The open console's "anything new?" (ADR 0035, instant delivery) — a stamp,
 * never data; LiveRefresh refreshes the page when it changes. The actor is
 * rebuilt from the session, with listing links, as the inbox's scope needs.
 *
 * A GET, not a Server Action, on purpose. The router runs Server Actions in
 * its own queue: a click while one is in flight discards it and marks the
 * router for a full refresh, which empties the Router Cache — so the page you
 * were just on, and every prefetched skeleton, has to come from the server
 * again. Polled every few seconds, that was most clicks. A plain fetch is
 * outside the router and cannot do it.
 */
/**
 * Online for the admin console (ADR 0052): this poll runs every few seconds while a console page is
 * open, so it is also where "last seen" is kept. Written at most once a minute per person per
 * instance (and the SQL refuses a write inside the minute anyway).
 */
const SEEN = Symbol.for('@repo/console.last-seen');
function dueForSeen(userId: string): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const map = (g[SEEN] ??= new Map());
  const now = Date.now();
  if ((map.get(userId) ?? 0) > now - 60_000) return false;
  map.set(userId, now);
  if (map.size > 10_000) map.clear();
  return true;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await actionUserId();
  if (!userId) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (dueForSeen(userId)) await touchLastSeen(getConsoleDb(), userId).catch(() => undefined);
  try {
    const actor = await loadListingActor(userId);
    const stamp = actor ? await consoleLiveStamp(getConsoleDb(), actor) : '';
    return NextResponse.json({ stamp }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    // A missed tick is retried on the next one.
    return NextResponse.json({ stamp: '' }, { headers: { 'cache-control': 'no-store' } });
  }
}
