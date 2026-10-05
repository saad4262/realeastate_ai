import { after, NextResponse, type NextRequest } from 'next/server';
import { handleInboundWebhook } from '@repo/core/mail';
import { getWebDb } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resend Inbound: an email arrived at MAIL_INBOUND_DOMAIN (docs/adr/0016).
 *
 * Everything is decided in packages/core (`handleInboundWebhook`) — the
 * signature check, the routing, who may have written it. This route reads the
 * RAW body, because the Svix signature is over the exact bytes and parsing
 * first would break it, and hands the sends to `after()` so Resend gets its
 * answer without waiting on our outbound mail.
 *
 * Outside the middleware matcher on purpose: a machine caller has no session,
 * and the signature is its only credential (ARCHITECTURE § 9).
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const result = await handleInboundWebhook({
    db: getWebDb,
    rawBody,
    headers: {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
  });

  const followUp = result.followUp;
  if (followUp) {
    after(async () => {
      try {
        await followUp();
      } catch (err) {
        console.error('[mail] inbound follow-up failed', err instanceof Error ? err.message : err);
      }
    });
  }

  return NextResponse.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}
