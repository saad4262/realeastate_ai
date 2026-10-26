import { NextResponse, type NextRequest } from 'next/server';
import { authoriseCronRequest } from '@repo/core/schedules';
import { runOpportunityScan } from '@repo/core/opportunities';
import { getWebDb } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Five SQL reads and one write; it needs seconds, not minutes. */
export const maxDuration = 60;

/**
 * The hourly opportunity scan (ADR 0054). Same door as the other ticks — `CRON_SECRET`, and
 * nothing read from the request. It claims nothing and writes with `on conflict do nothing`, so a
 * retry or an overlapping run finds what is already there. Counts only in the answer: it is read
 * from a cron log.
 */
async function handler(request: NextRequest) {
  const auth = authoriseCronRequest(request.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const report = await runOpportunityScan(getWebDb());
    return NextResponse.json({ ok: true, ...report }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'opportunity scan failed' }, { status: 503 });
  }
}

export { handler as GET, handler as POST };
