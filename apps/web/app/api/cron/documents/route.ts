import { NextResponse, type NextRequest } from 'next/server';
import { authoriseCronRequest } from '@repo/core/schedules';
import { runDocumentTick } from '@repo/core/documents/tick';
import { documentReaderFromEnv } from '@repo/ai/document-reader';
import { embedderFromEnv } from '@repo/ai/search-embedder';
import { getWebDb } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 300, not the other ticks' 60: reading a scanned contract is one model call that can take a
 * minute or two, and a run killed half way leaves the document claimed until the stale-claim
 * recovery (15 minutes) puts it back. 300 s is Vercel's ceiling with fluid compute, which is on
 * by default (DEPLOY.md). New documents stop being claimed after two minutes, so one started
 * late still has time to finish.
 */
export const maxDuration = 300;

/**
 * The document tick (ADR 0053): inbound attachments stored, pending documents read, chunks
 * embedded. Same door as the other ticks — `CRON_SECRET`, and nothing read from the request:
 * what is due is looked up in packages/core. Never a 5xx for one document (a retry would rerun
 * the model calls); only an unauthorised call or an unreachable database is an error.
 */
async function handler(request: NextRequest) {
  const auth = authoriseCronRequest(request.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const db = getWebDb();
    const report = await runDocumentTick(db, {
      reader: documentReaderFromEnv(db),
      embedder: embedderFromEnv(db),
      budgetMs: 120_000,
    });
    // Counts only — this is read from a cron log.
    return NextResponse.json({ ok: true, ...report }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'document tick failed' }, { status: 503 });
  }
}

export { handler as GET, handler as POST };
