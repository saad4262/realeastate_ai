import { createHmac, timingSafeEqual } from 'node:crypto';
import { EmailError } from './transport';

/**
 * The unsubscribe token.
 *
 * ## Why a signed token and not a column
 *
 * The obvious design is a random secret stored on the schedule row. This is
 * derived instead — an HMAC over the ids the server already holds — which
 * means there is nothing to generate, nothing to migrate, nothing to garbage
 * collect and nothing that can drift out of step with the row it protects.
 *
 * ## Why it never expires
 *
 * The Spam Act requires the unsubscribe facility to stay functional for at
 * least 30 days after the message is sent, and people unsubscribe from mail
 * they find months later. An expiring token turns a legal obligation into a
 * support ticket, so there is no TTL here on purpose. Do not add one.
 *
 * ## What it can do
 *
 * Pause one schedule belonging to one user. It is not a session: it cannot
 * read anything, cannot change anything else, and naming a schedule that is
 * not the signed one produces a verification failure rather than an action.
 */
function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function signature(scheduleId: string, userId: string, secret: string): string {
  // Both ids are in the payload. Signing only the schedule id would let a
  // token keep working if the row were ever reassigned, and the pause below
  // matches on both.
  return base64url(createHmac('sha256', secret).update(`${scheduleId}:${userId}`).digest());
}

export function signUnsubscribeToken(
  scheduleId: string,
  userId: string,
  secret: string,
): string {
  const payload = base64url(Buffer.from(`${scheduleId}:${userId}`, 'utf8'));
  return `${payload}.${signature(scheduleId, userId, secret)}`;
}

export type UnsubscribeClaim =
  | { ok: true; scheduleId: string; userId: string }
  | { ok: false };

export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribeClaim {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false };

  const [payload, offered] = parts as [string, string];

  let decoded: string;
  try {
    decoded = fromBase64url(payload).toString('utf8');
  } catch {
    return { ok: false };
  }

  const [scheduleId, userId] = decoded.split(':');
  if (!scheduleId || !userId) return { ok: false };

  const expected = signature(scheduleId, userId, secret);

  /**
   * `timingSafeEqual` THROWS on buffers of different lengths, which would
   * turn a malformed token into a 500 and also leak the expected length
   * through the difference between a crash and a refusal. Length is checked
   * first, then the contents in constant time.
   */
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { ok: false };
  if (!timingSafeEqual(a, b)) return { ok: false };

  return { ok: true, scheduleId, userId };
}

/**
 * No default, ever.
 *
 * A default secret is a token anybody who has read this repository can mint
 * for anybody else's alert.
 */
export function requireUnsubscribeSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ALERT_UNSUBSCRIBE_SECRET?.trim();
  if (!secret) {
    throw new EmailError('Alert email is not configured: ALERT_UNSUBSCRIBE_SECRET not set');
  }
  return secret;
}

export function unsubscribeUrl(
  baseUrl: string,
  scheduleId: string,
  userId: string,
  secret: string,
): string {
  const token = signUnsubscribeToken(scheduleId, userId, secret);
  return `${baseUrl.replace(/\/$/, '')}/unsubscribe?t=${encodeURIComponent(token)}`;
}
