import { NextResponse } from 'next/server';
import { healthReport } from '@repo/core/observability/health';
import { getWebHealthDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * For uptime monitors (PLATFORM-PLAN 1.14): 200 when the database answers and has every migration this build
 * expects, else 503. Flags only — no versions, hosts or error text — so it is public.
 */
export async function GET() {
  const report = await healthReport(getWebHealthDb());
  return NextResponse.json(report, { status: report.status === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
