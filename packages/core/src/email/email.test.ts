import { describe, expect, it } from 'vitest';
import type { PublicListingSummary } from '../listings/search-listings';
import { buildScheduleDigestEmail, templateSummary } from './schedule-digest';
import { buildPrivateOfferEmail } from './private-offer';
import { requireSenderIdentity, resendTransport } from './resend-transport';
import { EmailError, fakeTransport } from './transport';
import { signUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from './unsubscribe';

const SECRET = 'unit-test-secret';
const SCHEDULE = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function listing(over: Partial<PublicListingSummary> = {}): PublicListingSummary {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    address: '12 Example St',
    suburb: 'Pakenham',
    state: 'VIC',
    postcode: '3810',
    channel: 'sale',
    status: 'live',
    headline: 'A quiet street near the station',
    priceDisplay: '$780,000',
    priceFrom: 780000,
    priceTo: null,
    rentPw: null,
    bedrooms: 3,
    bathrooms: 2,
    carSpaces: 1,
    propertyType: 'house',
    landArea: null,
    latitude: null,
    longitude: null,
    distanceKm: null,
    publishedAt: new Date('2026-09-20T00:00:00Z'),
    ...over,
  } as PublicListingSummary;
}

const BASE = {
  to: { email: 'buyer@example.com' },
  from: { email: 'alerts@example.com', name: 'Test Company' },
  postalAddress: '123 Test St, Test City',
  scheduleName: 'Pakenham rentals',
  description: '3+ bed homes to rent in Pakenham',
  matched: 12,
  newCount: 2,
  listings: [listing()],
  summary: 'Two of these back onto the reserve.',
  summarySource: 'model' as const,
  resultsUrl: 'http://web.lvh.me:3000/search?channel=rent&suburb=Pakenham',
  unsubscribeUrl: 'http://web.lvh.me:3000/unsubscribe?t=abc',
};

describe('buildScheduleDigestEmail', () => {
  /**
   * Spam Act 2003. These are not stylistic requirements, and an email that
   * cannot meet them must not be built — so the failure is a throw here
   * rather than a line on a review checklist.
   */
  it('refuses to build a message with no sender identity', () => {
    expect(() => buildScheduleDigestEmail({ ...BASE, postalAddress: '  ' })).toThrow(
      /sender identity/,
    );
    expect(() =>
      buildScheduleDigestEmail({ ...BASE, from: { email: 'a@b.c', name: '' } }),
    ).toThrow(/sender identity/);
  });

  it('refuses to build a message with no unsubscribe link', () => {
    expect(() => buildScheduleDigestEmail({ ...BASE, unsubscribeUrl: '' })).toThrow(
      /unsubscribe/,
    );
  });

  it('puts the unsubscribe and the postal address in BOTH parts', () => {
    const message = buildScheduleDigestEmail(BASE);

    for (const part of [message.html, message.text]) {
      expect(part).toContain(BASE.unsubscribeUrl);
      expect(part).toContain('123 Test St, Test City');
      expect(part).toContain('Test Company');
    }

    // The header is what makes Gmail show its own one-click control.
    expect(message.listUnsubscribeUrl).toBe(BASE.unsubscribeUrl);
  });

  /**
   * #4 at the template boundary. Every figure in the email is rendered from
   * the integers SQL produced; the model's contribution is prose only.
   */
  it('takes its counts from the arguments, not from the summary', () => {
    const message = buildScheduleDigestEmail(BASE);
    expect(message.subject).toContain('2 new listings');
    expect(message.html).toContain('View all 12 results');
  });

  it('renders a price through priceLabel and never as a raw number', () => {
    const message = buildScheduleDigestEmail(BASE);
    expect(message.html).toContain('$780,000');
    expect(message.html).not.toContain('780000');
  });

  /** #7: model-written text reaching a person unreviewed says that it is. */
  it('labels a model-written paragraph and does not label a templated one', () => {
    expect(buildScheduleDigestEmail(BASE).html).toContain('Written by the property guide');
    expect(
      buildScheduleDigestEmail({ ...BASE, summarySource: 'template', summary: null }).html,
    ).not.toContain('Written by the property guide');
  });

  it('escapes a listing that contains markup', () => {
    const message = buildScheduleDigestEmail({
      ...BASE,
      scheduleName: '<script>alert(1)</script>',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('falls back to the templated sentence when there is no summary', () => {
    const message = buildScheduleDigestEmail({ ...BASE, summary: null, summarySource: 'none' });
    expect(message.text).toContain('2 new listings since we last looked');
  });
});

describe('templateSummary', () => {
  it('uses the real figures and reads correctly in the singular', () => {
    expect(templateSummary({ newCount: 1, matched: 4, description: 'homes' })).toContain(
      '1 new listing since',
    );
    expect(templateSummary({ newCount: 0, matched: 4, description: 'homes' })).toContain(
      'No new listings',
    );
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips', () => {
    const token = signUnsubscribeToken(SCHEDULE, USER, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual({
      ok: true,
      scheduleId: SCHEDULE,
      userId: USER,
    });
  });

  it('refuses a tampered payload', () => {
    const token = signUnsubscribeToken(SCHEDULE, USER, SECRET);
    const [, signature] = token.split('.');
    const forged = `${Buffer.from(`${SCHEDULE}:33333333-3333-3333-3333-333333333333`).toString('base64url')}.${signature}`;

    expect(verifyUnsubscribeToken(forged, SECRET).ok).toBe(false);
  });

  it('refuses a token signed with another secret', () => {
    const token = signUnsubscribeToken(SCHEDULE, USER, 'a-different-secret');
    expect(verifyUnsubscribeToken(token, SECRET).ok).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on buffers of different lengths, which would
   * turn a malformed token into a 500 and leak the expected length through
   * the difference between a crash and a refusal.
   */
  it('returns false rather than throwing on a malformed token', () => {
    for (const bad of ['', 'nodot', 'a.b', '....', 'x'.repeat(500)]) {
      expect(() => verifyUnsubscribeToken(bad, SECRET)).not.toThrow();
      expect(verifyUnsubscribeToken(bad, SECRET).ok).toBe(false);
    }
  });

  it('builds a URL the mail client can post to', () => {
    const url = unsubscribeUrl('http://web.lvh.me:3000/', SCHEDULE, USER, SECRET);
    expect(url).toMatch(/^http:\/\/web\.lvh\.me:3000\/unsubscribe\?t=/);
    // No double slash from the trailing slash on the base.
    expect(url).not.toContain('3000//unsubscribe');
  });
});

describe('resendTransport', () => {
  /**
   * Asserts the REQUEST BODY, not the configuration.
   *
   * ARCHITECTURE § 12: a model swap broke /chat completely while 99 unit
   * tests stayed green, because nothing built a request and looked at it.
   */
  it('sends both parts and both unsubscribe headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null;

    const transport = resendTransport({
      apiKey: 'test-key',
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await transport.send(buildScheduleDigestEmail(BASE));
    expect(result).toEqual({ ok: true, id: 'msg_1' });

    const sent = captured as unknown as { url: string; init: RequestInit };
    expect(sent.url).toBe('https://api.resend.com/emails');

    const body = JSON.parse(String(sent.init.body)) as Record<string, unknown>;
    expect(body.from).toBe('Test Company <alerts@example.com>');
    expect(body.to).toEqual(['buyer@example.com']);
    expect(body.text).toBeTruthy();
    expect(body.html).toBeTruthy();

    const headers = body.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBe(`<${BASE.unsubscribeUrl}>`);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('marks a 429 retryable and a 422 not', async () => {
    const make = (status: number) =>
      resendTransport({
        apiKey: 'k',
        fetchImpl: (async () => new Response('nope', { status })) as unknown as typeof fetch,
      });

    const busy = await make(429).send(buildScheduleDigestEmail(BASE));
    const rejected = await make(422).send(buildScheduleDigestEmail(BASE));

    expect(busy).toMatchObject({ ok: false, retryable: true });
    expect(rejected).toMatchObject({ ok: false, retryable: false });
  });

  it('treats a network failure as retryable rather than throwing', async () => {
    const transport = resendTransport({
      apiKey: 'k',
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });

    await expect(transport.send(buildScheduleDigestEmail(BASE))).resolves.toMatchObject({
      ok: false,
      retryable: true,
    });
  });
});

describe('fakeTransport', () => {
  it('records what it was asked to send', async () => {
    const transport = fakeTransport();
    await transport.send(buildScheduleDigestEmail(BASE));
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to.email).toBe('buyer@example.com');
  });
});

describe('requireSenderIdentity', () => {
  const ok = {
    ALERT_EMAIL_FROM: 'alerts@example.com',
    ALERT_SENDER_NAME: 'Example Pty Ltd',
    ALERT_SENDER_ADDRESS: '1 Example St, Sydney NSW 2000',
  } as NodeJS.ProcessEnv;

  it('accepts a real address', () => {
    expect(requireSenderIdentity(ok).from.email).toBe('alerts@example.com');
  });

  /**
   * The fault this exists for, seen in a live deployment.
   *
   * `ALERT_EMAIL_FROM` was the domain with no mailbox. It was non-empty, so
   * the old check passed, and every send was then refused by the provider —
   * recorded honestly on each run, which nobody reads until somebody asks
   * why no email arrived. Present is not the same as usable.
   */
  it('refuses a bare domain, and says what is wrong with it', () => {
    const call = () => requireSenderIdentity({ ...ok, ALERT_EMAIL_FROM: 'quotemydecking.com.au' });

    expect(call).toThrow(/not an email address/);
    // The message has to carry the fix, not just the verdict — this is read
    // in a log by somebody who set the variable and thought it was fine.
    expect(call).toThrow(/alerts@example\.com, not example\.com/);
  });

  it.each(['no-at-sign', 'trailing@', '@leading.com', 'spaces in@example.com', 'a@b'])(
    'refuses %s',
    (value) => {
      expect(() => requireSenderIdentity({ ...ok, ALERT_EMAIL_FROM: value })).toThrow(EmailError);
    },
  );

  it('still reports a missing value as missing rather than as malformed', () => {
    expect(() => requireSenderIdentity({ ...ok, ALERT_EMAIL_FROM: '' })).toThrow(/not set/);
  });
});

/**
 * A transactional notification — an offer arriving in an agency's inbox.
 *
 * The half of the Spam Act that is relaxed here is s.18's unsubscribe, and
 * these tests are what say the relaxation went exactly that far and no further.
 * The digest tests above are the other half of the pair: they still assert that
 * bulk mail refuses to build without an unsubscribe link.
 */
describe('a private offer notification', () => {
  const OFFER = {
    to: { email: 'owner@agency.example', name: 'Agency Owner' },
    from: { email: 'alerts@example.com', name: 'Test Company' },
    postalAddress: '1 Test Street, Sydney NSW 2000',
    propertyAddress: '14 Henry Road, Pakenham, VIC 3810',
    amount: 905_000,
    offeredBy: { name: 'Jane Buyer', email: 'jane@example.test', phone: '0412 884 920' },
    message: 'I have been watching this street and would like to buy.',
    propertyUrl: 'https://example.com/property/p-1',
  };

  /**
   * The reason the type split exists.
   *
   * `List-Unsubscribe-Post` is a promise that the URL accepts an unauthenticated
   * POST and acts on it — and mailbox providers, link scanners and prefetchers
   * all take that promise up. Sending it on a notification nobody subscribed to
   * would ship a one-click way to silently switch an agency's offer alerts off.
   * Both headers are asserted absent, not just the first: one without the other
   * is its own bug.
   */
  it('carries neither unsubscribe header', async () => {
    let captured: { init: RequestInit } | null = null;
    const transport = resendTransport({
      apiKey: 'test-key',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        captured = { init };
        return new Response(JSON.stringify({ id: 'msg_2' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await transport.send(buildPrivateOfferEmail(OFFER));

    const sent = captured as unknown as { init: RequestInit };
    const body = JSON.parse(String(sent.init.body)) as Record<string, unknown>;
    const headers = (body.headers ?? {}) as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBeUndefined();
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('still identifies its sender in both parts', () => {
    // s.17 is NOT what was relaxed. It is cheap and correct on any business
    // mail, and a text/plain part without it identifies nobody.
    const message = buildPrivateOfferEmail(OFFER);
    expect(message.html).toContain('1 Test Street, Sydney NSW 2000');
    expect(message.text).toContain('1 Test Street, Sydney NSW 2000');
    expect(message.html).toContain('Test Company');
    expect(message.text).toContain('Test Company');
    expect(message.text.length).toBeGreaterThan(0);
  });

  it('refuses to build with no sender identity, exactly as the digest does', () => {
    expect(() => buildPrivateOfferEmail({ ...OFFER, postalAddress: '  ' })).toThrow(EmailError);
    expect(() =>
      buildPrivateOfferEmail({ ...OFFER, from: { ...OFFER.from, name: '' } }),
    ).toThrow(EmailError);
  });

  it('puts the figure and the address where the agency will read them', () => {
    const message = buildPrivateOfferEmail(OFFER);
    // This email IS the routing — there is no Leads screen yet — so the offer
    // has to be legible without following a link.
    expect(message.subject).toContain('$905,000');
    expect(message.subject).toContain('14 Henry Road');
    expect(message.html).toContain('$905,000');
    expect(message.text).toContain('$905,000');
    expect(message.text).toContain('jane@example.test');
  });

  it('is labelled transactional, in a word somebody had to type', () => {
    // `kind` has no default, so a builder cannot drift into this branch by
    // omission — it is one word in a diff a reviewer reads.
    expect(buildPrivateOfferEmail(OFFER).kind).toBe('transactional');
    expect(buildScheduleDigestEmail(BASE).kind).toBe('marketing');
  });

  it('escapes what the offerer typed', () => {
    const message = buildPrivateOfferEmail({
      ...OFFER,
      message: '<script>alert(1)</script>',
      offeredBy: { ...OFFER.offeredBy, name: 'Jane "Quote" <b>' },
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).not.toContain('<b>');
  });
});
