import { NextResponse, type NextRequest } from 'next/server';
import { recordSiteActivity } from '@repo/core/activity';
import { touchLastSeen } from '@repo/core/platform';
import { getWebDb } from '../../../lib/db';
import { currentWebUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * A search or a listing view, reported by the browser after the page rendered
 * (ADR 0051). `/search` and `/listing/[id]` keep no session (middleware.ts),
 * so this route — inside the matcher — is where the visitor is known: signed
 * in, the row names them; otherwise it is only counted.
 *
 * The body says WHAT, never WHO and never which agency: identity is the
 * verified session, and a listing's agency comes from the listing (core).
 * Rate-limited per IP; always answers 204, so it reveals nothing.
 */

const PER_IP = 120;
const WINDOW_MS = 60_000;
type Bucket = { count: number; resetAt: number };
const BUCKETS = Symbol.for('@repo/web.activity-rate-limit');

function overLimit(request: NextRequest): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  const map = (g[BUCKETS] ??= new Map());
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  const b = map.get(ip);
  if (!b || b.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (map.size > 5000) for (const [k, v] of map) if (v.resetAt < now) map.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > PER_IP;
}

/** Crawlers that run scripts still say who they are; their visits are not interest. */
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit/i;

const DONE = () => new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });

export async function POST(request: NextRequest) {
  if (overLimit(request) || BOT.test(request.headers.get('user-agent') ?? '')) return DONE();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return DONE();
  }
  try {
    const user = await currentWebUser();
    // A presence ping (ADR 0052): last seen for a signed-in visitor, nothing for anyone else.
    if ((body as { kind?: unknown } | null)?.kind === 'ping') {
      if (user) await touchLastSeen(getWebDb(), user.id);
      return DONE();
    }
    await recordSiteActivity(getWebDb(), { userId: user?.id ?? null }, body);
  } catch (err) {
    console.error('[activity] not recorded', err instanceof Error ? err.message : err);
  }
  return DONE();
}
