import { NextResponse, type NextRequest } from 'next/server';
import { resolvePlace, suggestPlaces } from '@repo/core/geo';
import { getWebDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * Location autocomplete for the public search box.
 *
 * Unlike the console's equivalent there is no session to hide behind: this is
 * an open endpoint in front of a provider that bills per call. Everything
 * below exists because of that.
 */

/** Requests allowed per IP per window. Generous for typing, useless for scraping. */
const LIMIT = 30;
const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };

/**
 * Held on globalThis because Next re-evaluates modules on hot reload, and a
 * module-level Map would reset the limit on every edit in development.
 *
 * Per instance, not shared: behind several instances the real ceiling is LIMIT
 * times the instance count. That is a ceiling on accidental cost, not a
 * security control — a determined caller rotates IPs anyway. The protection
 * that actually matters is the cache in packages/core, which means a repeated
 * query costs nothing no matter who asks.
 */
const BUCKETS = Symbol.for('@repo/web.place-rate-limit');

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
    // Sweep here rather than on a timer: the map only grows while requests
    // arrive, so this is the only moment it needs tidying.
    if (map.size > 5000) {
      for (const [key, bucket] of map) if (bucket.resetAt < now) map.delete(key);
    }
    return false;
  }

  current.count += 1;
  return current.count > LIMIT;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = searchParams.get('q')?.trim() ?? '';
  const id = searchParams.get('id')?.trim() ?? '';

  if (!query && !id) {
    return NextResponse.json({ suggestions: [] });
  }

  if (overLimit(request)) {
    // 429 rather than an empty list: an empty list reads as "no such suburb",
    // which is a different and wrong thing to tell someone.
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  try {
    const db = getWebDb();

    if (id) {
      const place = await resolvePlace(db, id);
      return NextResponse.json({ place });
    }

    const suggestions = await suggestPlaces(db, query, {
      // A buyer searches a suburb, a postcode or a region — never a specific
      // street address, which would also be the most expensive lookup of the
      // three and the one most worth abusing.
      kinds: ['locality', 'postcode', 'region'],
      // Offering a suburb with nothing live in it produces an empty results
      // page that reads as a broken site.
      liveOnly: true,
    });
    return NextResponse.json({ suggestions });
  } catch {
    // The search box must keep working without suggestions; text search does
    // not depend on this endpoint at all.
    return NextResponse.json({ suggestions: [] });
  }
}
