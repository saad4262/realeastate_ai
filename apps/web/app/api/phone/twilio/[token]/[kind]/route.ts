import { type NextRequest } from 'next/server';
import { tokenKeysFromEnv } from '@repo/core/integrations';
import { handleTwilioWebhook, phoneDepsFromEnv, voiceFromEnv } from '@repo/core/phone';
import { getWebDb } from '../../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Twilio's webhooks for the agents' numbers (docs/adr/0070): a text in, a text's delivery status, a
 * call in (a missed call, or the forwarding test coming back), and the caller-ID check's answer.
 *
 * Everything is decided in packages/core (`handleTwilioWebhook`): the token in the URL (an HMAC naming
 * one number that only this server can make) and, on a number we run for the agency (ADR 0096),
 * Twilio's signature. Outside the middleware matcher like the other webhooks: a machine caller has no
 * session.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string; kind: string }> }) {
  const { token, kind } = await ctx.params;
  let keys = null;
  try {
    keys = tokenKeysFromEnv();
  } catch {
    keys = null;
  }
  try {
    const form = await request.formData().catch(() => null);
    const params: Record<string, string> = {};
    form?.forEach((v, k) => {
      if (typeof v === 'string') params[k] = v.slice(0, 4000);
    });
    const env = phoneDepsFromEnv();
    const result = await handleTwilioWebhook({
      db: getWebDb, token, kind, params, keys, client: env.client, webhookBase: env.webhookBase, voice: voiceFromEnv().voice,
      signature: request.headers.get('x-twilio-signature'), url: request.url,
    });
    return new Response(result.body, { status: result.status, headers: { 'content-type': result.contentType, 'cache-control': 'no-store' } });
  } catch (err) {
    // A 5xx makes Twilio retry a status callback; an incoming call just hears nothing.
    console.error('[phone] twilio webhook failed', err instanceof Error ? err.message : err);
    return new Response('failed', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
}
