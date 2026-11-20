import { type NextRequest, NextResponse } from 'next/server';
import { receiveStripeWebhook } from '@repo/core/billing';
import { getWebDb } from '../../../../lib/db';
import { apiError } from '@repo/core/http/api-error';

/**
 * Stripe's webhook (ADR 0092). Verified by its signature, stored once, enqueued — then 200. Anything that fails
 * before the event is stored is a 500, so Stripe delivers it again. The raw body is read as text: the signature
 * covers the exact bytes.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await receiveStripeWebhook(getWebDb(), { rawBody: await request.text(), signature: request.headers.get('stripe-signature') });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error('[stripe] webhook not stored', err instanceof Error ? err.message : 'unknown');
    return apiError(500, 'not stored');
  }
}
