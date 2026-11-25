import { NextResponse, type NextRequest } from 'next/server';
import { resolvePlace, suggestPlaces } from '@repo/core/geo';
import { getWebDb } from '../../../lib/db';
import { apiError } from '@repo/core/http/api-error';

export const dynamic = 'force-dynamic';

/**
 * Location autocomplete for the public search box.
 *
 * Unlike the console's equivalent there is no session to hide behind: this is
 * an open endpoint in front of a provider that bills per call. Everything
 * below exists because of that.
 */

/**
 * Requests allowed per IP per window. Generous for typing, useless for scraping.
 * 60, not 30: the home box takes up to ten suburbs, typed letter by letter, and
 * a refusal there reads as "no such suburb" (ADR 0099).
 */
const LIMIT = 60;
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
    return apiError(429, 'Too many requests');
  }

  try {
    const db = getWebDb();

    if (id) {
      const place = await resolvePlace(db, id);
      return NextResponse.json({ place });
    }

    // The home page's Address tab (ADR 0099) asks for street addresses: the
    // priciest lookup, still behind the per-IP limit above and the cache.
    const addresses = searchParams.get('kind') === 'address';
    const suggestions = await suggestPlaces(db, query, {
      // Otherwise a buyer searches a suburb, a postcode or a region.
      kinds: addresses ? ['address'] : ['locality', 'postcode', 'region'],
      // Offering a suburb with nothing live in it produces an empty results
      // page that reads as a broken site. An address is a lookup, not a search.
      liveOnly: !addresses,
    });
    return NextResponse.json({ suggestions });
  } catch {
    // The search box must keep working without suggestions; text search does
    // not depend on this endpoint at all.
    return NextResponse.json({ suggestions: [] });
  }
}
