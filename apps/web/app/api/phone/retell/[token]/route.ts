import { type NextRequest } from 'next/server';
import { tokenKeysFromEnv } from '@repo/core/integrations';
import { handleRetellWebhook, voiceFromEnv } from '@repo/core/phone';
import { getWebDb } from '../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Retell's webhook for the platform's AI call-back agent (docs/adr/0072): a call ended (transcript,
 * recording) and was analysed (summary, priority). Everything is decided in packages/core
 * (`handleRetellWebhook`): the token in the URL, which only this server can make; Retell's own
 * signature when RETELL_VERIFY_SIGNATURE=1; and a call id we placed, carrying our own id. The RAW body
 * is read because the signature is over the exact bytes.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  let keys = null;
  try {
    keys = tokenKeysFromEnv();
  } catch {
    keys = null;
  }
  const rawBody = await request.text();
  try {
    const voice = voiceFromEnv();
    const result = await handleRetellWebhook({
      db: getWebDb,
      token,
      rawBody,
      signature: request.headers.get('x-retell-signature'),
      keys,
      apiKey: voice.apiKey,
      verifySignature: voice.verifySignature,
    });
    return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // A 5xx makes Retell retry.
    console.error('[phone] retell webhook failed', err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error: 'failed' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
