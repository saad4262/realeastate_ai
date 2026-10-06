import { randomBytes } from 'node:crypto';
import type { EmailAddress, EmailMessage } from '../email/transport';
import { PROVIDER_TIMEOUT_MS, ProviderError, str, type Fetch } from './provider-http';

/**
 * Sending through a connected Gmail (ADR 0026), with `gmail.send` only:
 * `users.messages.send` with the whole RFC 822 message, base64url — checked
 * against the Gmail API reference on 2026-10-06. Nothing is ever read.
 *
 * The message is built HERE from the same EmailMessage the platform transport
 * sends, so a reply looks the same whichever way it leaves. Every header value
 * is ours: names and subjects have line breaks removed and non-ASCII encoded,
 * addresses must be plain addresses — a body or subject can never add a
 * header (no Bcc, no Cc, no second To).
 */

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export type GmailApi = {
  /** Sends the raw RFC 822 message as the token's account; returns Gmail's message id. */
  send(token: string, raw: string): Promise<{ id: string }>;
};

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** A plain address, or refuse — never something that could carry a second header or recipient. */
export function plainAddress(email: string): string {
  const e = email.trim();
  if (!ADDRESS.test(e) || e.length > 254) throw new ProviderError('failed', 'An email address in this message is not valid');
  return e;
}

/** RFC 2047 for a header word that is not plain ASCII; line breaks never survive. */
export function headerText(v: string): string {
  const flat = v.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

function mailbox(a: EmailAddress): string {
  const email = plainAddress(a.email);
  if (!a.name) return email;
  const name = headerText(a.name.replace(/["\\]/g, ''));
  return name.startsWith('=?') ? `${name} <${email}>` : `"${name}" <${email}>`;
}

function base64Lines(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

const MESSAGE_ID = /^<[^<>\s]{1,500}>$/;

/**
 * The RFC 822 message for Gmail. Only a one-to-one (transactional) message
 * may go this way: bulk mail stays on the platform sender (ADR 0026 §4).
 */
export function buildMime(message: EmailMessage, opts: { boundary?: string } = {}): string {
  if (message.kind !== 'transactional') throw new ProviderError('failed', 'Bulk email is never sent through Gmail');
  const boundary = opts.boundary ?? `lah_${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${mailbox(message.from)}`,
    `To: ${mailbox(message.to)}`,
    ...(message.replyTo ? [`Reply-To: ${mailbox(message.replyTo)}`] : []),
    `Subject: ${headerText(message.subject)}`,
    ...(message.threading && MESSAGE_ID.test(message.threading.inReplyTo)
      ? [
          `In-Reply-To: ${message.threading.inReplyTo}`,
          `References: ${message.threading.references.filter((r) => MESSAGE_ID.test(r)).join(' ')}`,
        ]
      : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export function base64url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

const QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']);

/**
 * Gmail's error, as a ProviderError: 401 → `unauthorized` (renew once); 429,
 * or 403 with a rate/daily-limit reason → `rate_limited`; 403 for a missing
 * permission → `failed` with "reconnect"; anything else → `failed`. The body
 * is read for its reason word only, never echoed.
 */
export function gmailError(status: number, body: unknown): ProviderError {
  const e = (body as { error?: { status?: unknown; errors?: { reason?: unknown }[] } } | null)?.error;
  const reason = typeof e?.errors?.[0]?.reason === 'string' ? (e.errors[0].reason as string) : '';
  const word = typeof e?.status === 'string' ? e.status : '';
  if (status === 401) return new ProviderError('unauthorized', 'Gmail refused the connection', status);
  if (status === 429 || QUOTA_REASONS.has(reason) || word === 'RESOURCE_EXHAUSTED') {
    return new ProviderError('rate_limited', "Gmail's sending limit was reached", status);
  }
  if (status === 403 && /insufficient|scope|permission/i.test(`${reason} ${word}`)) {
    return new ProviderError('failed', 'Gmail permission is missing — reconnect Gmail', status);
  }
  return new ProviderError('failed', `Gmail answered ${status}${reason ? ` (${reason.slice(0, 40)})` : ''}`, status);
}

export function gmailApi(fetchImpl: Fetch = fetch): GmailApi {
  return {
    async send(token, raw) {
      let res: Response;
      try {
        res = await fetchImpl(GMAIL_SEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ raw: base64url(raw) }),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          cache: 'no-store',
        });
      } catch {
        throw new ProviderError('failed', 'Gmail could not be reached');
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) throw gmailError(res.status, body);
      const id = str(body?.id);
      if (!id) throw new ProviderError('failed', 'Gmail sent back something unexpected');
      return { id };
    },
  };
}

/** The dev stub's Gmail: records, never sends (ADR 0026, Dev). */
export const stubGmailSent: { raw: string }[] = [];
export function stubGmailApi(): GmailApi {
  return {
    async send(_token, raw) {
      stubGmailSent.push({ raw });
      if (stubGmailSent.length > 50) stubGmailSent.shift();
      return { id: `stub-gmail-${randomBytes(8).toString('hex')}` };
    },
  };
}
