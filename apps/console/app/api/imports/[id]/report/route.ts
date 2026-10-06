import { NextResponse, type NextRequest } from 'next/server';
import { ImportError, importReportCsv } from '@repo/core/imports';
import { getConsoleDb } from '../../../../../lib/db';
import { loadActor } from '../../../../../lib/load-actor';
import { actionUserId } from '../../../../../lib/auth-account';

/** The row-by-row report as a CSV download (ADR 0029). The importer or an admin — core decides. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await actionUserId();
  const actor = userId ? await loadActor(userId) : null;
  if (!actor?.agencyId) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;
  try {
    const csv = await importReportCsv(getConsoleDb(), actor, id);
    return new NextResponse(csv, {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="import-report-${id.slice(0, 8)}.csv"`, 'cache-control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof ImportError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
