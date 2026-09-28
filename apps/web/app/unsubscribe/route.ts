import { NextResponse, type NextRequest } from 'next/server';
import { requireUnsubscribeSecret, verifyUnsubscribeToken } from '@repo/core/email';
import { pauseScheduleByOwner } from '@repo/core/schedules';
import { getWebDb } from '../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One-click unsubscribe.
 *
 * ## Why GET changes state here, when it normally must not
 *
 * A GET that mutates is prefetchable, and mail clients do prefetch. That is
 * a real cost and it is accepted deliberately, because the alternative is
 * worse: the Spam Act requires the unsubscribe to work without the recipient
 * taking further steps and without signing in, so a "click here to confirm"
 * page is not compliant. The resolution is that GET performs it and the
 * confirmation page's first control is a one-click undo — a prefetch that
 * pauses an alert is recoverable in one tap, where a non-compliant
 * unsubscribe is not recoverable at all.
 *
 * POST exists for RFC 8058: Gmail and Outlook send it themselves when the
 * message carries `List-Unsubscribe-Post`, and that is the path most people
 * will actually take.
 *
 * ## Why there is no session check
 *
 * The person clicking is in a mail client, possibly on a device that has
 * never signed in. Requiring a login to unsubscribe is exactly what the Act
 * forbids. The token is the authorisation: an HMAC over the schedule and
 * user ids, verified in constant time, that can do one thing and nothing
 * else.
 */

/**
 * A ceiling on accidental volume, not a security control.
 *
 * Said plainly, the way apps/web/app/api/chat/route.ts says it: this is an
 * in-process Map keyed on an IP, so behind several instances the real
 * ceiling multiplies and a determined caller rotates addresses. The token is
 * what actually protects a schedule; this only stops one client hammering
 * the endpoint. § 9 asks for a limiter on every public write and this is it.
 */
const LIMIT = 20;
const WINDOW_MS = 60_000;
const BUCKETS = Symbol.for('@repo/web.unsubscribe-rate-limit');

type Bucket = { count: number; resetAt: number };

function overLimit(request: NextRequest): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  const map = (g[BUCKETS] ??= new Map());

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  const now = Date.now();
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

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${title}</title>
  <style>
    body { margin:0; background:#f7f4ef; font:400 16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#1a1a1a; }
    .card { max-width:34rem; margin:12vh auto; background:#fff; border:1px solid #d9d2c5; border-radius:12px; padding:2rem; }
    h1 { font-size:1.35rem; margin:0 0 .5rem; }
    p { color:#5c5c5c; margin:.5rem 0; }
    a.btn { display:inline-block; margin-top:1rem; padding:.7rem 1.2rem; background:#0b3d2e; color:#f7f4ef; border-radius:6px; text-decoration:none; font-weight:600; }
    a.plain { color:#5c5c5c; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

async function unsubscribe(request: NextRequest): Promise<{ ok: boolean; scheduleId?: string }> {
  const token = request.nextUrl.searchParams.get('t');
  if (!token) return { ok: false };

  let secret: string;
  try {
    secret = requireUnsubscribeSecret();
  } catch {
    return { ok: false };
  }

  const claim = verifyUnsubscribeToken(token, secret);
  if (!claim.ok) return { ok: false };

  /**
   * Matched on BOTH ids, not just the schedule.
   *
   * The token carries the pair and the update filters on the pair, so a
   * token cannot pause a schedule that has somehow changed hands.
   */
  const paused = await pauseScheduleByOwner(getWebDb(), claim.scheduleId, claim.userId);
  return { ok: paused, scheduleId: claim.scheduleId };
}

/**
 * The mail provider's one-click. No body, no page — it is a machine.
 *
 * It must answer 200 even when the token is stale: a schedule already paused
 * is the outcome the caller wanted, and a 4xx here makes Gmail hide the
 * unsubscribe control for this sender.
 */
export async function POST(request: NextRequest) {
  if (overLimit(request)) return new NextResponse(null, { status: 429 });
  await unsubscribe(request);
  return new NextResponse(null, { status: 200 });
}

export async function GET(request: NextRequest) {
  if (overLimit(request)) {
    return page('Too many requests', '<h1>Too many requests</h1><p>Try again in a minute.</p>', 429);
  }

  const result = await unsubscribe(request);

  if (!result.ok) {
    return page(
      'Link not recognised',
      `<h1>That link did not work</h1>
       <p>It may have already been used, or the alert may have been deleted.
          You can manage every saved search from your account.</p>
       <a class="btn" href="/alerts">Open my alerts</a>`,
      // 200, not 404. A different status for "already unsubscribed" tells an
      // outsider whether a given token was ever real.
      200,
    );
  }

  return page(
    'Unsubscribed',
    `<h1>You are unsubscribed</h1>
     <p>That saved search is paused and will not email you again.</p>
     <p><a class="plain" href="/alerts">Turn it back on</a> from your alerts page — it keeps
        its settings, so resuming takes one click.</p>
     <a class="btn" href="/alerts">Open my alerts</a>`,
  );
}
