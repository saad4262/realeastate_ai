import { NextResponse, type NextRequest } from 'next/server';
import { authoriseCronRequest, runScheduleTick } from '@repo/core/schedules';
import { getWebDb } from '../../../../lib/db';
import { schedulerDeps } from '../../../../lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 60, not 300.
 *
 * 300 needs a paid plan and the tick does not need it: anything not claimed
 * this minute is claimed by the next one, because `next_run_at <= now()`
 * does not expire. A timeout here costs latency, never correctness — which
 * is a better property to have than a longer budget.
 */
export const maxDuration = 60;

/**
 * Run every schedule that is due.
 *
 * ## It accepts nothing
 *
 * No body is read, no query parameter is parsed, no id selects a row. § 9 —
 * a machine caller's authorisation is what the server decides rather than
 * what it accepts. The endpoint looks up what is due itself; the batch size
 * is a constant in packages/core and dry mode is `ALERTS_DRY_RUN` on the
 * deployment, not a parameter somebody can flip from outside.
 *
 * ## Both methods
 *
 * Vercel Cron issues GET with `Authorization: Bearer $CRON_SECRET` and
 * cannot be told to send anything else. POST is for a manual curl or any
 * other pinger. The method is the platform's choice; the secret is what
 * authorises, and there is no method that reaches the work without one.
 *
 * ## It does not 5xx because a schedule failed
 *
 * A 500 makes the platform retry the whole tick, straight back into
 * whatever failed — with a metered model and a mail provider behind it.
 * Individual failures are counted in the response and recorded on the run
 * row; only an unauthorised call or an unreachable database is an error
 * status.
 */
async function handler(request: NextRequest) {
  const auth = authoriseCronRequest(request.headers);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const report = await runScheduleTick(getWebDb(), schedulerDeps());
    // No ids, no addresses, no listing text — this is read from a cron log.
    return NextResponse.json({ ok: true, ...report }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // Configuration and connectivity, i.e. the tick could not start at all.
    const message = err instanceof Error ? err.message : 'Scheduler failed';
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}

export { handler as GET, handler as POST };
