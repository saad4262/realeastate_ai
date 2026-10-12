import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { integrationAccount, type Db } from '@repo/db';

/**
 * Zoom's event notifications to the app (ADR 0037). Two events matter:
 *
 *  - `endpoint.url_validation`: Zoom checks the URL when it is saved and every
 *    72 hours after. The answer is the plain token and its HMAC.
 *  - `app_deauthorized`: a person removed the app in their Zoom account. Zoom
 *    has already ended the grant; we delete every connection to that Zoom
 *    user, and their tokens with it.
 *
 * Every request must carry a valid `x-zm-signature`. Zoom's webhook guide
 * (checked 2026-10-12): `v0=` + hex HMAC-SHA256, keyed with the app's Secret
 * Token, over `v0:<x-zm-request-timestamp>:<raw body>`. Without the Secret
 * Token configured the endpoint answers 503 (Zoom retries 5xx), never 200.
 *
 * Zoom wants an answer within three seconds. The delete is one indexed
 * statement, so it runs before the answer, not after it.
 */

export type ZoomWebhookResponse = { status: number; body: Record<string, unknown> };

/** How far Zoom's timestamp may be from our clock before the request is treated as a replay. */
export const ZOOM_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

export function zoomWebhookSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim() || null;
}

const hmacHex = (secret: string, message: string) => createHmac('sha256', secret).update(message).digest('hex');

export function verifyZoomSignature(opts: {
  secret: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowMs: number;
}): boolean {
  const { timestamp, signature } = opts;
  if (!timestamp || !signature || !/^\d{1,13}$/.test(timestamp)) return false;
  if (Math.abs(opts.nowMs - Number(timestamp) * 1000) > ZOOM_WEBHOOK_MAX_SKEW_MS) return false;
  const expected = Buffer.from(`v0=${hmacHex(opts.secret, `v0:${timestamp}:${opts.rawBody}`)}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Delete every connection to this Zoom user — the person's own and an
 * agency's, in any agency. One statement, so there is nothing to roll back.
 */
export async function deleteZoomConnections(db: Db, zoomUserId: string): Promise<number> {
  const gone = await db
    .delete(integrationAccount)
    .where(and(eq(integrationAccount.provider, 'zoom'), eq(integrationAccount.externalAccountId, zoomUserId)))
    .returning({ id: integrationAccount.id });
  return gone.length;
}

type ZoomEvent = { event?: unknown; payload?: { plainToken?: unknown; user_id?: unknown; client_id?: unknown } };

export async function handleZoomWebhook(opts: {
  db: () => Db;
  rawBody: string;
  headers: { signature: string | null; timestamp: string | null };
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<ZoomWebhookResponse> {
  const env = opts.env ?? process.env;
  const secret = zoomWebhookSecretFromEnv(env);
  if (!secret) return { status: 503, body: { ok: false, error: 'not configured' } };

  const signed = verifyZoomSignature({
    secret,
    rawBody: opts.rawBody,
    timestamp: opts.headers.timestamp,
    signature: opts.headers.signature,
    nowMs: opts.nowMs ?? Date.now(),
  });
  if (!signed) return { status: 401, body: { ok: false, error: 'unauthorised' } };

  let event: ZoomEvent;
  try {
    const parsed: unknown = JSON.parse(opts.rawBody);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    event = parsed as ZoomEvent;
  } catch {
    return { status: 400, body: { ok: false, error: 'not an event' } };
  }

  if (event.event === 'endpoint.url_validation') {
    const plainToken = event.payload?.plainToken;
    if (typeof plainToken !== 'string' || !plainToken) return { status: 400, body: { ok: false, error: 'no plainToken' } };
    return { status: 200, body: { plainToken, encryptedToken: hmacHex(secret, plainToken) } };
  }

  if (event.event === 'app_deauthorized') {
    const userId = event.payload?.user_id;
    if (typeof userId !== 'string' || !userId) return { status: 400, body: { ok: false, error: 'no user_id' } };
    // Signed with our Secret Token, so it is our app — but a development and a
    // production app can share one endpoint; only our client id's grant is ours.
    const ourClient = env.ZOOM_OAUTH_CLIENT_ID?.trim();
    const theirClient = event.payload?.client_id;
    if (ourClient && typeof theirClient === 'string' && theirClient !== ourClient) {
      return { status: 200, body: { ok: true, outcome: 'ignored' } };
    }
    const deleted = await deleteZoomConnections(opts.db(), userId);
    return { status: 200, body: { ok: true, outcome: 'deauthorized', deleted } };
  }

  return { status: 200, body: { ok: true, outcome: 'ignored' } };
}
