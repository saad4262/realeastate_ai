import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Is this POST really from Resend?
 *
 * Resend signs webhooks the Svix way: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${raw body}`, keyed with the base64 part of a
 * `whsec_…` secret, sent as space-separated `v1,<base64>` entries in
 * `svix-signature` (several during a secret rotation — any one matching is
 * enough). Written out here rather than taking the `svix` package, for the
 * reason resend-transport.ts gives: it is a few lines, and a test can see all
 * of them.
 *
 * The timestamp check is what stops a captured delivery being replayed later.
 * Five minutes either way is Svix's own tolerance.
 *
 * It must be handed the RAW body. Re-serialising parsed JSON changes the bytes
 * and every signature then fails — which is the safe direction to be wrong in,
 * but a confusing one.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function verifyResendWebhook(opts: {
  headers: WebhookHeaders;
  body: string;
  secret: string | undefined;
  /** Seconds since the epoch. Injectable so a test does not depend on the clock. */
  nowSeconds?: number;
}): boolean {
  const { id, timestamp, signature } = opts.headers;
  const secret = opts.secret?.trim();
  // No secret configured refuses everything, the CRON_SECRET rule.
  if (!secret || !id || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sentAt) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  if (key.length === 0) return false;

  const expected = Buffer.from(
    createHmac('sha256', key).update(`${id}.${timestamp}.${opts.body}`).digest('base64'),
    'utf8',
  );

  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const offered = Buffer.from(value, 'utf8');
    return offered.length === expected.length && timingSafeEqual(offered, expected);
  });
}
