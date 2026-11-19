import { NextResponse } from 'next/server';
import { alertLines } from '@repo/core/observability/health';
import { getWebDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * PLATFORM-PLAN 1.23: for the uptime monitor that pages a phone. 200 when every alert line is ok, 503 when one is
 * not (or the database cannot answer). Flags only — no counts, ids or text — so it is public, like /api/health.
 */
export async function GET() {
  const report = await alertLines(getWebDb()).catch(() => null);
  if (!report) return NextResponse.json({ status: 'alert', lines: { database: 'alert' } }, { status: 503, headers: { 'cache-control': 'no-store' } });
  return NextResponse.json(report, { status: report.status === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
