import { NextResponse, type NextRequest } from 'next/server';
import { publicListingReviews } from '@repo/core/reviews';
import { getWebDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * The listing's agency's Google rating and reviews (ADR 0028 step 1), for
 * the section on a public listing page. Public on purpose — a visitor has no
 * session — and asked from the browser, so Google's content is never baked
 * into the ISR-cached page: the Places terms let us keep only a place id.
 *
 * Every answer is `no-store`. 204 means "show nothing": a listing that is not
 * live, an agency with no Google listing picked, or Google not answering.
 *
 * Two brakes on a provider that bills per call, per instance: 20 requests a
 * minute per IP, and 120 Google lookups a minute in total — past either, the
 * section simply does not show.
 */

const PER_IP = 20;
const TOTAL = 120;
const WINDOW_MS = 60_000;
type Bucket = { count: number; resetAt: number };
const KEY = Symbol.for('@repo/web.reviews-rate-limit');

function buckets(): Map<string, Bucket> {
  const g = globalThis as unknown as Record<symbol, Map<string, Bucket> | undefined>;
  return (g[KEY] ??= new Map());
}

function take(key: string, limit: number, now: number): boolean {
  const map = buckets();
  const b = map.get(key);
  if (!b || b.resetAt < now) {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (map.size > 5000) for (const [k, v] of map) if (v.resetAt < now) map.delete(k);
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

function overLimit(request: NextRequest): boolean {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  return !take(`ip:${ip}`, PER_IP, now) || !take('total', TOTAL, now);
}

const NONE = () => new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  if (overLimit(request)) return NONE();
  try {
    const reviews = await publicListingReviews(getWebDb(), listingId);
    if (!reviews) return NONE();
    return NextResponse.json(reviews, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NONE();
  }
}
