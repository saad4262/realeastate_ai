import { NextResponse, type NextRequest } from 'next/server';
import { handleZoomWebhook } from '@repo/core/integrations';
import { getWebDb } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Zoom event notifications (docs/adr/0037): the URL check, and the notice that
 * a person removed the app in Zoom — their stored Zoom access is deleted.
 * This is the app's "Deauthorization Notification Endpoint URL" in the Zoom
 * Marketplace.
 *
 * Everything is decided in packages/core (`handleZoomWebhook`), including the
 * `x-zm-signature` check. The RAW body is read because the signature is over
 * the exact bytes. Outside the middleware matcher like the mail webhook: a
 * machine caller has no session, and the signature is its only credential.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  try {
    const result = await handleZoomWebhook({
      db: getWebDb,
      rawBody,
      headers: {
        signature: request.headers.get('x-zm-signature'),
        timestamp: request.headers.get('x-zm-request-timestamp'),
      },
    });
    return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // A 5xx makes Zoom retry (5, 20 and 60 minutes later).
    console.error('[zoom] webhook failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
