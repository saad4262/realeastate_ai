import { describe, expect, it } from 'vitest';
import type { EmailMessage } from '../email/transport';
import { base64url, buildMime, gmailApi, gmailError, headerText, plainAddress } from './gmail';
import { ProviderError } from './provider-http';
import { senderLine } from '../mail/sender';

/** ADR 0026: one-to-one mail through the person's Gmail, gmail.send only. */

const msg = (over: Partial<EmailMessage> = {}): EmailMessage =>
  ({
    kind: 'transactional',
    to: { email: 'buyer@example.com', name: 'Pat Buyer' },
    from: { email: 'agent@gmail.com', name: 'Sam Agent · Smoke Realty' },
    replyTo: { email: 't+abc.sig@reply.example.com', name: 'Sam Agent · Smoke Realty' },
    subject: 'Re: 14 Henry Street',
    text: 'Hello Pat',
    html: '<p>Hello Pat</p>',
    threading: { inReplyTo: '<m1@mail.example.com>', references: ['<m1@mail.example.com>'] },
    ...over,
  }) as EmailMessage;

const headersOf = (raw: string) => raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n');

describe('the message Gmail sends', () => {
  it('From is the Gmail account, Reply-To is the signed thread address, threaded, both parts base64', () => {
    const raw = buildMime(msg(), { boundary: 'B' });
    const h = headersOf(raw);
    expect(h.find((x) => x.startsWith('From:'))).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <agent@gmail\.com>$/);
    expect(h.find((x) => x.startsWith('From:'))).toMatch(/<agent@gmail\.com>$/);
    expect(h.find((x) => x.startsWith('Reply-To:'))).toMatch(/<t\+abc\.sig@reply\.example\.com>$/);
    expect(h).toContain('In-Reply-To: <m1@mail.example.com>');
    expect(raw).toContain(Buffer.from('Hello Pat').toString('base64'));
    expect(h.some((x) => /^(Bcc|Cc):/i.test(x))).toBe(false);
  });

  it('no subject, name or body can add a header or a recipient', () => {
    const raw = buildMime(
      msg({
        subject: 'Hi\r\nBcc: victim@example.com',
        to: { email: 'buyer@example.com', name: 'Pat\r\nCc: x@example.com' },
        text: 'line\r\nBcc: y@example.com',
      }),
      { boundary: 'B' },
    );
    const h = headersOf(raw);
    expect(h.filter((x) => /^(Bcc|Cc):/i.test(x))).toEqual([]);
    expect(h.find((x) => x.startsWith('Subject:'))).toBe('Subject: Hi Bcc: victim@example.com');
    expect(() => buildMime(msg({ to: { email: 'a@b.com>\r\nBcc: c@d.com' } }))).toThrow(/not valid/);
    expect(() => buildMime(msg({ to: { email: 'a@b.com, c@d.com' } }))).toThrow(/not valid/);
  });

  it('non-ASCII is encoded; bulk (marketing) mail is refused outright', () => {
    expect(headerText('Café · Sydney')).toMatch(/^=\?UTF-8\?B\?/);
    expect(headerText('plain')).toBe('plain');
    expect(() => buildMime(msg({ kind: 'marketing', listUnsubscribeUrl: 'https://x' } as never))).toThrow(/never sent through Gmail/);
    expect(plainAddress(' a@b.co ')).toBe('a@b.co');
    expect(base64url('ÿ?>')).not.toMatch(/[+/=]/);
  });
});

describe('Gmail’s answers', () => {
  it('quota → rate_limited; 401 → unauthorized; missing permission → reconnect; the token never leaves in a URL', async () => {
    expect(gmailError(429, null).kind).toBe('rate_limited');
    expect(gmailError(403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }).kind).toBe('rate_limited');
    expect(gmailError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }).message).toMatch(/sending limit/);
    expect(gmailError(401, null).kind).toBe('unauthorized');
    expect(gmailError(403, { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } }).message).toMatch(/reconnect/);
    expect(gmailError(500, null)).toBeInstanceOf(ProviderError);

    const seen: { url: string; init: RequestInit }[] = [];
    const api = gmailApi((async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ id: 'g-1' }), { status: 200 });
    }) as never);
    await expect(api.send('tok-123', 'raw')).resolves.toEqual({ id: 'g-1' });
    expect(seen[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(seen[0]!.url).not.toContain('tok-123');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ raw: base64url('raw') });
  });
});

describe('the “Sent from” line', () => {
  it('names the address before anything is sent, and says how to send as yourself', () => {
    expect(senderLine({ via: 'gmail', accountId: 'a', ownerType: 'user', address: 'me@gmail.com' })).toBe('Sent from your Gmail (me@gmail.com)');
    expect(senderLine({ via: 'gmail', accountId: 'a', ownerType: 'agency', address: 'sales@agency.com.au' })).toMatch(/agency’s Gmail/);
    expect(senderLine({ via: 'resend', own: 'not_connected', agencyBlocked: false })).toMatch(/connect your Gmail/);
    expect(senderLine({ via: 'resend', own: 'expired', agencyBlocked: false })).toMatch(/expired/);
  });
});
