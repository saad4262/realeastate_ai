import { randomUUID } from 'node:crypto';
import { PROVIDER_TIMEOUT_MS, ProviderError, type Fetch } from './provider-http';

/**
 * Sending through a connected Outlook (ADR 0076; Microsoft Graph `POST /me/sendMail`, checked 2026-10-31):
 * the SAME RFC 822 message the Gmail path builds (`buildMime`), base64 in a `text/plain` body — so threading
 * headers survive — saved to Sent Items, `202 Accepted`. `Mail.Send` only: the mailbox is never read.
 *
 * Graph answers a send with no id, so ours is a fresh uuid: `outlook:<uuid>` keeps provider ids unique across
 * transports, and a message that may already have left is never sent twice (send.ts marks it failed instead).
 */

export const OUTLOOK_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

export type OutlookMailApi = {
  /** Sends the raw RFC 822 message as the token's account; returns our id for the send. */
  send(token: string, raw: string): Promise<{ id: string }>;
};

const THROTTLED = new Set(['ErrorExceededMessageLimit', 'ApplicationThrottled', 'MailboxConcurrency', 'TooManyRequests']);

/**
 * Graph's error, as a ProviderError: 401 → `unauthorized` (renew once); 429 or a throttling code →
 * `rate_limited`; 403 → `failed` with "reconnect" (the send permission is missing, or the organisation
 * blocks it); anything else → `failed`. The body is read for its code only, never echoed.
 */
export function outlookError(status: number, body: unknown): ProviderError {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  const word = typeof code === 'string' ? code.slice(0, 60) : '';
  if (status === 401) return new ProviderError('unauthorized', 'Outlook refused the connection', status);
  if (status === 429 || THROTTLED.has(word)) return new ProviderError('rate_limited', "Outlook's sending limit was reached", status);
  if (status === 403) return new ProviderError('failed', 'Outlook did not allow the send — reconnect Outlook, or ask your IT admin to allow it', status);
  return new ProviderError('failed', `Outlook answered ${status}${word ? ` (${word})` : ''}`, status);
}

export function outlookMailApi(fetchImpl: Fetch = fetch): OutlookMailApi {
  return {
    async send(token, raw) {
      let res: Response;
      try {
        res = await fetchImpl(OUTLOOK_SEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
          body: Buffer.from(raw, 'utf8').toString('base64'),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          cache: 'no-store',
        });
      } catch {
        throw new ProviderError('failed', 'Outlook could not be reached');
      }
      if (res.status !== 202 && !res.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        throw outlookError(res.status, body);
      }
      return { id: randomUUID() };
    },
  };
}

/** The dev stub's Outlook: records, never sends. */
export const stubOutlookSent: { raw: string }[] = [];
export function stubOutlookMailApi(): OutlookMailApi {
  return {
    async send(_token, raw) {
      stubOutlookSent.push({ raw });
      if (stubOutlookSent.length > 50) stubOutlookSent.shift();
      return { id: randomUUID() };
    },
  };
}
