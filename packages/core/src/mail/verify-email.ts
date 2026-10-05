import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { user, type Db } from '@repo/db';
import { escapeHtml, requireSenderFooter } from '../email/schedule-digest';
import type { EmailTransport, SenderIdentity, TransactionalMessage } from '../email';
import { MailError } from './threads';

/**
 * Proving an address before showing the mail sent to it (docs/adr/0016).
 *
 * Sign-up does not confirm an email in this project — a person can register
 * with any address they like. Matching a buyer's conversations on that address
 * would hand anybody the agency correspondence of whoever really owns it. So
 * the website shows email-matched conversations only once the account has
 * opened a link sent TO that address, which is the one thing a stranger
 * cannot do.
 *
 * The token names the account AND the address, expires in a day, and is only
 * honoured for the signed-in account it names, while that account's address
 * is still the one it names.
 */

export const VERIFY_TTL_SECONDS = 24 * 60 * 60;

/**
 * A link inside an agency's reply lasts longer: the buyer may open it days
 * later. It proves the same thing — this mailbox received it — and names no
 * account (`*`), because a buyer who enquired without one signs up with this
 * address first. It is still only honoured for an account whose sign-in
 * address IS that address.
 */
export const MAILBOX_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The key, or null. MAIL_REPLY_SECRET first; the unsubscribe secret otherwise,
 * so this works wherever alerts already do. The HMAC input is prefixed, so one
 * key signing two kinds of token cannot make one pass as the other.
 */
export function verifySecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.MAIL_REPLY_SECRET?.trim() || env.ALERT_UNSUBSCRIBE_SECRET?.trim() || null;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(`verify-email:${payload}`).digest());
}

export function signEmailVerification(
  userId: string,
  email: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = VERIFY_TTL_SECONDS,
): string {
  const payload = `${userId}:${email.trim().toLowerCase()}:${nowSeconds + ttlSeconds}`;
  return `${b64url(payload)}.${sign(payload, secret)}`;
}

export function readEmailVerification(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { userId: string; email: string } | null {
  const [encoded, offered] = token.split('.');
  if (!encoded || !offered) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload, secret);
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // userId is a uuid (no colons); the address may not contain one either.
  const [userId, email, exp] = payload.split(':');
  if (!userId || !email || !exp) return null;
  if (!(Number(exp) > nowSeconds)) return null;
  return { userId, email };
}

export function buildVerifyEmail(input: {
  to: string;
  from: { email: string; name: string };
  postalAddress: string;
  url: string;
}): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'address check');
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  const lead = 'Open this link to see your conversations with agencies on the website.';
  const why = 'Sent because somebody signed in with this address and asked to see its messages. If that was not you, ignore this email — nothing is shown until the link is opened.';
  return {
    kind: 'transactional',
    to: { email: input.to },
    from: input.from,
    subject: 'Confirm your email to see your messages',
    html: `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f7f4ef;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d9d2c5;border-radius:12px;padding:28px;">
    <h1 style="font:600 20px/1.3 ${FONT};color:#1a1a1a;margin:0 0 10px;">Confirm your email</h1>
    <p style="font:400 15px/1.6 ${FONT};color:#1a1a1a;margin:0 0 18px;">${escapeHtml(lead)}</p>
    <a href="${escapeHtml(input.url)}" style="display:inline-block;padding:12px 22px;background:#0b3d2e;color:#f7f4ef;border-radius:6px;font:600 15px/1 ${FONT};text-decoration:none;">Show my messages</a>
    <p style="font:400 13px/1.5 ${FONT};color:#5c5c5c;margin:18px 0 0;">The link works for 24 hours.</p>
  </div>
  <p style="max-width:520px;margin:16px auto 0;font:400 12px/1.6 ${FONT};color:#8c8577;">${escapeHtml(why)}<br><br>${escapeHtml(input.from.name)}, ${escapeHtml(input.postalAddress)}</p>
</body></html>`,
    text: [
      'Confirm your email',
      '',
      lead,
      input.url,
      '',
      'The link works for 24 hours.',
      '',
      '---',
      why,
      `${input.from.name}, ${input.postalAddress}`,
    ].join('\n'),
    tags: { kind: 'verify-email' },
  };
}

/** Send the link to the account's own address. */
export async function sendEmailVerification(
  mailer: { sender: SenderIdentity; transport: EmailTransport },
  who: { userId: string; email: string },
  opts: { secret: string; baseUrl: string },
): Promise<boolean> {
  const email = who.email.trim().toLowerCase();
  if (!email) throw new MailError('invalid', 'Your account has no email address');
  const token = signEmailVerification(who.userId, email, opts.secret);
  const url = `${opts.baseUrl.replace(/\/$/, '')}/account/messages/verify?t=${encodeURIComponent(token)}`;
  const result = await mailer.transport.send(
    buildVerifyEmail({ to: email, from: mailer.sender.from, postalAddress: mailer.sender.postalAddress, url }),
  );
  return result.ok;
}

/**
 * Record the proof — only for the account the token names, signed in now,
 * whose address is still the one the token names.
 */
export async function confirmEmailVerification(
  db: Db,
  who: { userId: string; email: string },
  token: string,
  secret: string,
): Promise<void> {
  const claim = readEmailVerification(token, secret);
  const current = who.email.trim().toLowerCase();
  if (!claim || (claim.userId !== '*' && claim.userId !== who.userId) || claim.email !== current) {
    throw new MailError('invalid', 'That link has expired or belongs to another account. Send a new one.');
  }
  const updated = await db
    .update(user)
    .set({ verifiedEmail: claim.email, updatedAt: sql`now()` })
    .where(and(eq(user.id, who.userId), sql`lower(${user.email}) = ${claim.email}`))
    .returning({ id: user.id });
  if (updated.length === 0) {
    throw new MailError('invalid', 'That link has expired or belongs to another account. Send a new one.');
  }
}

/** The address this account has proved, if it is still its sign-in address. */
export async function provenAddress(db: Db, who: { userId: string; email: string }): Promise<string | null> {
  const current = who.email.trim().toLowerCase();
  if (!current) return null;
  const [row] = await db
    .select({ verifiedEmail: user.verifiedEmail, email: user.email })
    .from(user)
    .where(eq(user.id, who.userId))
    .limit(1);
  const proved = row?.verifiedEmail?.trim().toLowerCase();
  return proved && proved === current && row!.email.trim().toLowerCase() === current ? current : null;
}

/** The website link an agency's reply carries: opens the thread, and proves the mailbox. */
export function conversationLink(webUrl: string, threadId: string, email: string, secret: string): string {
  const token = signEmailVerification('*', email, secret, undefined, MAILBOX_LINK_TTL_SECONDS);
  return `${webUrl.replace(/\/$/, '')}/account/messages/verify?t=${encodeURIComponent(token)}&thread=${threadId}`;
}
