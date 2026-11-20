import { NextResponse, type NextRequest } from 'next/server';
import { DashboardError, getDashboardData, type DashboardData } from '@repo/core/dashboards';
import { getConsoleDb } from '../../../../../lib/db';
import { loadActor } from '../../../../../lib/load-actor';
import { actionUserId } from '../../../../../lib/auth-account';
import { apiError } from '@repo/core/http/api-error';

/**
 * A dashboard's figures, for the live page (ADR 0027 §7). The session decides
 * who is asking; core decides what they may see. Unchanged since the version
 * the page holds → 304. A 15-second cache per viewer and dashboard means ten
 * open TVs cost one round of queries.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_MS = 15_000;
const cache = ((globalThis as { __dashboardCache?: Map<string, { at: number; data: DashboardData }> }).__dashboardCache ??= new Map());

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await actionUserId();
  const actor = userId ? await loadActor(userId) : null;
  if (!actor?.agencyId) return apiError(401, 'Not signed in');
  const { id } = await params;
  const key = `${actor.userId}:${id}`;
  let data = cache.get(key);
  if (!data || Date.now() - data.at > CACHE_MS) {
    try {
      data = { at: Date.now(), data: await getDashboardData(getConsoleDb(), actor, id) };
    } catch (err) {
      if (err instanceof DashboardError) return apiError(404, err.message);
      throw err;
    }
    cache.set(key, data);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  const etag = `"${data.data.version}"`;
  if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { etag } });
  return NextResponse.json(data.data, { headers: { etag, 'cache-control': 'no-store' } });
}
