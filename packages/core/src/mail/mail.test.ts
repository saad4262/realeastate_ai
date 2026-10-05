import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildConversationEmail, buildReplyNoticeEmail, replySubject } from '../email/conversation';
import { resendTransport } from '../email/resend-transport';
import { can, type Actor } from '../permissions';
import {
  agencyMailAddress,
  bareAddress,
  displayName,
  mailConfigFromEnv,
  parseAgencyMailAddress,
  parseThreadReplyAddress,
  threadReplyAddress,
  type MailConfig,
} from './address';
import { decodeHtmlField, htmlToText, snippet, stripQuotedReply } from './body';
import { routeRecipients } from './inbound';
import { parseMailFolder, receivedEmailSchema, replyInputSchema } from './mail-schema';
import { sandboxedEmailDocument } from './sandbox';
import { mayReadThread, maySendOnThread, type ThreadAccessFacts } from './threads';
import { verifyResendWebhook } from './webhook';
import { handleInboundWebhook } from './webhook-handler';
import { conversationLink, readEmailVerification, signEmailVerification, verifySecretFromEnv } from './verify-email';
import { pullReceivedMail, syncReceivedEmails } from './sync';

const config: MailConfig = { inboundDomain: 'reply.example.com.au', replySecret: 'unit-test-secret' };
const THREAD = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER = '11111111-2222-4333-8444-555555555555';
const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';
const listingA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('reply addresses', () => {
  it('round-trips a thread id through its signed address', () => {
    const address = threadReplyAddress(THREAD, config);
    expect(address).toMatch(/^t\+0f0e0d0c-0b0a-4908-8706-050403020100\.[0-9a-f]{20}@reply\.example\.com\.au$/);
    expect(parseThreadReplyAddress(address, config)).toBe(THREAD);
    // As a mail client writes it: a name, angle brackets, upper case.
    expect(parseThreadReplyAddress(`"Bea" <${address.toUpperCase()}>`, config)).toBe(THREAD);
  });

  it('refuses a thread id with somebody else’s signature on it', () => {
    const forged = threadReplyAddress(THREAD, config).replace(THREAD, OTHER);
    expect(parseThreadReplyAddress(forged, config)).toBeNull();
  });

  it('refuses an address signed with a different secret, or on another domain', () => {
    const elsewhere = threadReplyAddress(THREAD, { ...config, replySecret: 'another-secret' });
    expect(parseThreadReplyAddress(elsewhere, config)).toBeNull();
    const otherDomain = threadReplyAddress(THREAD, config).replace('reply.example.com.au', 'evil.example');
    expect(parseThreadReplyAddress(otherDomain, config)).toBeNull();
  });

  it('reads an agency address, and never mistakes a reply address for one', () => {
    expect(agencyMailAddress('ray-white-pakenham', config)).toBe('ray-white-pakenham@reply.example.com.au');
    expect(parseAgencyMailAddress('Ray-White-Pakenham@reply.example.com.au', config)).toBe('ray-white-pakenham');
    expect(parseAgencyMailAddress(threadReplyAddress(THREAD, config), config)).toBeNull();
    expect(parseAgencyMailAddress('sales@other.example', config)).toBeNull();
  });

  it('prefers a signed thread over an agency address on the same message', () => {
    const route = routeRecipients(
      ['ray-white-pakenham@reply.example.com.au', threadReplyAddress(THREAD, config)],
      config,
    );
    expect(route).toEqual({ threadId: THREAD });
    expect(routeRecipients(['someone@gmail.com'], config)).toBeNull();
  });

  it('is off unless both halves are configured', () => {
    expect(mailConfigFromEnv({})).toBeNull();
    expect(mailConfigFromEnv({ MAIL_INBOUND_DOMAIN: 'reply.example.com.au' })).toBeNull();
    expect(mailConfigFromEnv({ MAIL_REPLY_SECRET: 's' })).toBeNull();
    expect(
      mailConfigFromEnv({ MAIL_INBOUND_DOMAIN: '@Reply.Example.com.au', MAIL_REPLY_SECRET: ' s ' }),
    ).toEqual({ inboundDomain: 'reply.example.com.au', replySecret: 's' });
  });

  it('pulls the bare address and the name out of a From header', () => {
    expect(bareAddress('Bea Buyer <Bea@Example.com>')).toBe('bea@example.com');
    expect(bareAddress(' bea@example.com ')).toBe('bea@example.com');
    expect(displayName('"Bea Buyer" <bea@example.com>')).toBe('Bea Buyer');
    expect(displayName('bea@example.com')).toBeNull();
  });
});

describe('verifyResendWebhook', () => {
  const secretBytes = Buffer.from('a-test-signing-key-of-some-length');
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const body = '{"type":"email.received","data":{"email_id":"e1"}}';
  const sign = (id: string, ts: string, payload: string) =>
    createHmac('sha256', secretBytes).update(`${id}.${ts}.${payload}`).digest('base64');

  it('accepts a correctly signed, recent delivery — including during a key rotation', () => {
    const sig = sign('msg_1', '1790000000', body);
    expect(
      verifyResendWebhook({
        headers: { id: 'msg_1', timestamp: '1790000000', signature: `v1,${sig}` },
        body,
        secret,
        nowSeconds: 1790000010,
      }),
    ).toBe(true);
    expect(
      verifyResendWebhook({
        headers: { id: 'msg_1', timestamp: '1790000000', signature: `v1,b2xkLWtleQ== v1,${sig}` },
        body,
        secret,
        nowSeconds: 1790000010,
      }),
    ).toBe(true);
  });

  it('refuses a changed body, an old timestamp, a missing header and a missing secret', () => {
    const sig = sign('msg_1', '1790000000', body);
    const ok = { id: 'msg_1', timestamp: '1790000000', signature: `v1,${sig}` };
    const base = { body, secret, nowSeconds: 1790000010 };
    expect(verifyResendWebhook({ ...base, headers: ok, body: body.replace('e1', 'e2') })).toBe(false);
    expect(verifyResendWebhook({ ...base, headers: ok, nowSeconds: 1790000000 + 301 })).toBe(false);
    expect(verifyResendWebhook({ ...base, headers: { ...ok, signature: null } })).toBe(false);
    expect(verifyResendWebhook({ ...base, headers: ok, secret: undefined })).toBe(false);
    expect(verifyResendWebhook({ ...base, headers: { ...ok, signature: `v2,${sig}` } })).toBe(false);
  });
});

describe('message bodies', () => {
  it('cuts the Gmail quote, including one wrapped across two lines', () => {
    expect(
      stripQuotedReply('Yes, Saturday works.\n\nOn Fri, 3 Oct 2026 at 10:02, Sara <s@x.com> wrote:\n> Can you come?'),
    ).toBe('Yes, Saturday works.');
    expect(
      stripQuotedReply('Sounds good\n\nOn Fri, 3 Oct 2026 at 10:02 am, Sara Khan <sara@example.com>\nwrote:\n\n> hi'),
    ).toBe('Sounds good');
  });

  it('cuts an Outlook quote', () => {
    expect(stripQuotedReply('Thanks!\n\n-----Original Message-----\nFrom: Sara')).toBe('Thanks!');
    expect(
      stripQuotedReply('Thanks!\n\n________________________________\nFrom: Sara Khan\nSent: Friday'),
    ).toBe('Thanks!');
    expect(stripQuotedReply('Thanks!\nFrom: Sara Khan <s@x.com>\nSent: Friday, 3 October')).toBe('Thanks!');
  });

  it('keeps the whole text when there is nothing to cut — losing an answer is worse', () => {
    expect(stripQuotedReply('Is the garage double?\nAnd is there a shed?')).toBe(
      'Is the garage double?\nAnd is there a shed?',
    );
    // Entirely quoted: give back what there is rather than nothing.
    expect(stripQuotedReply('> only a quote')).toBe('> only a quote');
  });

  it('turns HTML into readable text, dropping style and script', () => {
    expect(
      htmlToText('<style>p{color:red}</style><p>Hello&nbsp;there</p><script>x()</script><p>A &amp; B<br>C</p>'),
    ).toBe('Hello there\nA & B\nC');
  });

  it('decodes a data-URI body and leaves plain markup alone', () => {
    const encoded = `data:text/html;base64,${Buffer.from('<p>Hi</p>').toString('base64')}`;
    expect(decodeHtmlField(encoded)).toBe('<p>Hi</p>');
    expect(decodeHtmlField('<p>Hi</p>')).toBe('<p>Hi</p>');
    expect(decodeHtmlField(null)).toBeNull();
  });

  it('previews the new part on one line', () => {
    expect(snippet('Yes.\n\nSee you then.\n\nOn Fri, Sara wrote:\n> hi')).toBe('Yes. See you then.');
    expect(snippet('x'.repeat(400)).length).toBe(160);
  });
});

describe('schemas', () => {
  it('trims a reply and refuses an empty one', () => {
    expect(replyInputSchema.parse({ body: '  Hi Bea \r\n' }).body).toBe('Hi Bea');
    expect(replyInputSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(replyInputSchema.safeParse({ body: 'x'.repeat(20_001) }).success).toBe(false);
  });

  it('falls back to "all" for a folder that does not exist', () => {
    expect(parseMailFolder('offers')).toBe('offers');
    expect(parseMailFolder('spam')).toBe('all');
    expect(parseMailFolder(undefined)).toBe('all');
  });

  it("accepts Resend's received-email example as documented", () => {
    const parsed = receivedEmailSchema.parse({
      object: 'email',
      id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
      to: ['delivered@resend.dev'],
      from: 'onboarding@resend.dev',
      subject: 'Hello World',
      html: 'Congrats',
      html_format: 'data_uri',
      text: null,
      headers: { from: 'Acme <onboarding@resend.dev>' },
      bcc: [],
      cc: [],
      reply_to: [],
      received_for: ['forwarded@example.com'],
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      message_id: '<111-222-333@email.example.com>',
      attachments: [{ id: 'a1', filename: 'avatar.png', content_type: 'image/png', size: 4096 }],
    });
    expect(parsed.received_for).toEqual(['forwarded@example.com']);
    expect(parsed.authentication?.dmarc).toBe('pass');
  });
});

describe('who may read and answer a conversation', () => {
  const owner: Actor = { userId: 'owner', agencyId: agencyA, membershipRole: 'owner' };
  const agentOnListing: Actor = {
    userId: 'agent',
    agencyId: agencyA,
    membershipRole: 'agent',
    listingAgentOf: [listingA],
  };
  const otherAgent: Actor = { userId: 'other', agencyId: agencyA, membershipRole: 'agent' };
  const readOnly: Actor = {
    userId: 'ro',
    agencyId: agencyA,
    membershipRole: 'read_only',
    listingAgentOf: [listingA],
  };
  const outsider: Actor = { userId: 'b-owner', agencyId: agencyB, membershipRole: 'owner' };

  const enquiry: ThreadAccessFacts = {
    id: THREAD,
    agencyId: agencyA,
    leadId: 'lead-1',
    leadKind: 'enquiry',
    assignedTo: null,
    listingId: listingA,
  };

  it('the agent on the listing reads and answers an unassigned enquiry; another agent does neither', () => {
    expect(maySendOnThread(agentOnListing, enquiry)).toBe(true);
    expect(mayReadThread(otherAgent, enquiry)).toBe(false);
    expect(maySendOnThread(otherAgent, enquiry)).toBe(false);
  });

  it('once assigned to someone else, the listing agent may still read it but not answer it', () => {
    const assigned = { ...enquiry, assignedTo: 'other' };
    expect(mayReadThread(agentOnListing, assigned)).toBe(true);
    expect(maySendOnThread(agentOnListing, assigned)).toBe(false);
    expect(maySendOnThread(otherAgent, assigned)).toBe(true);
  });

  it('a private offer’s conversation is for owners and admins only', () => {
    const offer = { ...enquiry, leadKind: 'offer' as const, listingId: null };
    expect(mayReadThread(owner, offer)).toBe(true);
    expect(mayReadThread({ ...agentOnListing }, { ...offer, assignedTo: 'agent' })).toBe(false);
  });

  it('mail to the agency’s own address is for owners and admins only', () => {
    const general = { ...enquiry, leadId: null, leadKind: null, listingId: null };
    expect(maySendOnThread(owner, general)).toBe(true);
    expect(mayReadThread(agentOnListing, general)).toBe(false);
  });

  it('never crosses an agency', () => {
    expect(mayReadThread(outsider, enquiry)).toBe(false);
    expect(maySendOnThread(outsider, { ...enquiry, leadId: null, leadKind: null })).toBe(false);
  });

  it('mail:send is lead:update and mail:read is lead:read, for every role', () => {
    const roles = ['owner', 'admin', 'agent', 'assistant', 'property_manager', 'read_only'] as const;
    const resources = [
      { type: 'mail_thread', id: THREAD, agencyId: agencyA, listingId: listingA },
      { type: 'mail_thread', id: THREAD, agencyId: agencyA, listingId: listingA, ownerId: 'x' },
      { type: 'mail_thread', id: THREAD, agencyId: agencyA, listingId: null },
      { type: 'mail_thread', agencyId: agencyB },
    ];
    for (const role of roles) {
      const actor: Actor = { userId: 'x', agencyId: agencyA, membershipRole: role, listingAgentOf: [listingA] };
      for (const resource of resources) {
        expect(can(actor, 'mail:send', resource)).toBe(can(actor, 'lead:update', resource));
        expect(can(actor, 'mail:read', resource)).toBe(can(actor, 'lead:read', resource));
      }
    }
    // read_only still gets the lead:update answer — the same rule, deliberately.
    expect(maySendOnThread(readOnly, enquiry)).toBe(can(readOnly, 'lead:update', { type: 'lead', id: 'lead-1', agencyId: agencyA, listingId: listingA }));
  });

  it('a buyer reads only threads matched to their own account', () => {
    expect(can({ userId: 'bea' }, 'mail:read_own', { type: 'mail_thread', ownerId: 'bea' })).toBe(true);
    expect(can({ userId: 'bea' }, 'mail:read_own', { type: 'mail_thread', ownerId: 'sam' })).toBe(false);
    // Being the largest account on the platform is no claim on a buyer's mail.
    expect(can(owner, 'mail:read_own', { type: 'mail_thread', agencyId: agencyA, ownerId: 'bea' })).toBe(false);
  });
});

describe('conversation emails', () => {
  const base = {
    to: { email: 'bea@example.com', name: 'Bea' },
    from: { email: 'mail@example.com.au', name: 'Sara Khan · Ray White' },
    replyTo: { email: threadReplyAddress(THREAD, config) },
    postalAddress: '1 Test St, Pakenham VIC 3810',
    subject: 'Enquiry about 12 Example St',
    body: 'Hi Bea,\n\nYes, the garage is double. <b>Come Saturday?</b>',
    authorName: 'Sara Khan',
    agencyName: 'Ray White',
  };

  it('is what the agent wrote, escaped, with the thread as its Reply-To and the sender in both parts', () => {
    const m = buildConversationEmail(base);
    expect(m.kind).toBe('transactional');
    expect(m.subject).toBe('Re: Enquiry about 12 Example St');
    expect(m.replyTo?.email).toBe(base.replyTo.email);
    expect(m.text).toContain('Yes, the garage is double. <b>Come Saturday?</b>');
    expect(m.html).toContain('&lt;b&gt;Come Saturday?&lt;/b&gt;');
    expect(m.html).not.toContain('<b>Come');
    expect(m.text).toContain('Sara Khan · Ray White, 1 Test St, Pakenham VIC 3810');
    expect(m.html).toContain('1 Test St, Pakenham VIC 3810');
  });

  it('never stacks "Re:"', () => {
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE:Hello')).toBe('RE:Hello');
    expect(replySubject('Hello')).toBe('Re: Hello');
  });

  it('the agent’s notice says replying answers the buyer only when it can', () => {
    const notice = buildReplyNoticeEmail({
      to: { email: 'sara@example.com' },
      from: { email: 'mail@example.com.au', name: 'Platform' },
      replyTo: { email: threadReplyAddress(THREAD, config) },
      postalAddress: '1 Test St',
      subject: 'Enquiry about 12 Example St',
      writer: 'Bea',
      body: 'Saturday is great',
      threadUrl: `http://agents.test/my-inbox?thread=${THREAD}`,
    });
    expect(notice.text).toContain('Reply to this email and your answer goes straight to them');
    expect(notice.text).toContain(`http://agents.test/my-inbox?thread=${THREAD}`);

    const withoutInbound = buildReplyNoticeEmail({
      to: { email: 'sara@example.com' },
      from: { email: 'mail@example.com.au', name: 'Platform' },
      replyTo: null,
      postalAddress: '1 Test St',
      subject: 'x',
      writer: 'Bea',
      body: 'y',
      threadUrl: 'http://agents.test',
    });
    expect(withoutInbound.replyTo).toBeUndefined();
    expect(withoutInbound.text).not.toContain('straight to them');
  });

  it('sends reply_to and the threading headers in the request Resend actually receives', async () => {
    let sent: Record<string, unknown> | null = null;
    const transport = resendTransport({
      apiKey: 'test-key',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await transport.send(
      buildConversationEmail({
        ...base,
        threading: { inReplyTo: '<abc@mail.gmail.com>', references: ['<abc@mail.gmail.com>'] },
      }),
    );
    expect(sent!.reply_to).toEqual([base.replyTo.email]);
    expect(sent!.headers).toEqual({
      'In-Reply-To': '<abc@mail.gmail.com>',
      References: '<abc@mail.gmail.com>',
    });
  });
});

describe('sandboxedEmailDocument', () => {
  it('puts a no-network policy before anything the email says', () => {
    const doc = sandboxedEmailDocument('<img src="https://tracker.example/p.gif"><script>alert(1)</script>');
    const policyAt = doc.indexOf('Content-Security-Policy');
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(policyAt).toBeLessThan(doc.indexOf('tracker.example'));
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('img-src data: cid:');
    expect(doc).toContain('<base target="_blank">');
  });
});

describe('handleInboundWebhook', () => {
  const key = Buffer.from('webhook-test-key-bytes');
  const env = {
    RESEND_WEBHOOK_SECRET: `whsec_${key.toString('base64')}`,
    MAIL_INBOUND_DOMAIN: 'reply.example.com.au',
    MAIL_REPLY_SECRET: 'unit-test-secret',
    RESEND_API_KEY: 'test-key',
    ALERT_EMAIL_FROM: 'mail@example.com.au',
    ALERT_SENDER_NAME: 'Test Co',
    ALERT_SENDER_ADDRESS: '1 Test St',
    ALERTS_DRY_RUN: '1',
  } as NodeJS.ProcessEnv;
  const now = 1790000000;
  const signed = (body: string) => ({
    id: 'msg_1',
    timestamp: String(now),
    signature: `v1,${createHmac('sha256', key).update(`msg_1.${now}.${body}`).digest('base64')}`,
  });
  const noDb = () => {
    throw new Error('the database must not be touched');
  };

  it('refuses an unsigned request without opening the database', async () => {
    const body = '{"type":"email.received","data":{"email_id":"e1"}}';
    const result = await handleInboundWebhook({
      db: noDb,
      rawBody: body,
      headers: { id: 'msg_1', timestamp: String(now), signature: 'v1,bm9wZQ==' },
      env,
      nowSeconds: now,
    });
    expect(result.status).toBe(401);
    expect(result.followUp).toBeNull();
  });

  it('refuses everything when no webhook secret is configured', async () => {
    const body = '{"type":"email.received","data":{"email_id":"e1"}}';
    const result = await handleInboundWebhook({
      db: noDb,
      rawBody: body,
      headers: signed(body),
      env: { ...env, RESEND_WEBHOOK_SECRET: undefined },
      nowSeconds: now,
    });
    expect(result.status).toBe(401);
  });

  it('acknowledges other event types and switched-off inbound with 200, so Resend stops retrying', async () => {
    const delivered = '{"type":"email.delivered","data":{"email_id":"e1"}}';
    expect(
      (await handleInboundWebhook({ db: noDb, rawBody: delivered, headers: signed(delivered), env, nowSeconds: now }))
        .body.outcome,
    ).toBe('ignored');

    const received = '{"type":"email.received","data":{"email_id":"e1"}}';
    const off = await handleInboundWebhook({
      db: noDb,
      rawBody: received,
      headers: signed(received),
      env: { ...env, MAIL_INBOUND_DOMAIN: undefined, MAIL_REPLY_SECRET: undefined },
      nowSeconds: now,
    });
    expect(off.status).toBe(200);
    expect(off.body.outcome).toBe('ignored');
  });

  it('asks for a retry (503) when the body cannot be fetched — before any write', async () => {
    const body = '{"type":"email.received","data":{"email_id":"e1"}}';
    let asked = '';
    const result = await handleInboundWebhook({
      db: noDb,
      rawBody: body,
      headers: signed(body),
      env,
      nowSeconds: now,
      fetchImpl: (async (url: string) => {
        asked = url;
        return new Response('busy', { status: 500 });
      }) as unknown as typeof fetch,
    });
    expect(asked).toBe('https://api.resend.com/emails/receiving/e1');
    expect(result.status).toBe(503);
  });
});

describe('email verification tokens', () => {
  const USER = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const now = 1790000000;

  it('round-trips the account and its address, lower-cased', () => {
    const token = signEmailVerification(USER, 'Bea@Example.com', 'k', now);
    expect(readEmailVerification(token, 'k', now + 60)).toEqual({ userId: USER, email: 'bea@example.com' });
  });

  it('refuses an expired, re-keyed or edited token', () => {
    const token = signEmailVerification(USER, 'bea@example.com', 'k', now);
    expect(readEmailVerification(token, 'k', now + 24 * 60 * 60 + 1)).toBeNull();
    expect(readEmailVerification(token, 'other-key', now)).toBeNull();
    const [, sig] = token.split('.');
    const swapped = Buffer.from(`${USER}:mallory@example.com:${now + 999}`).toString('base64url');
    expect(readEmailVerification(`${swapped}.${sig}`, 'k', now)).toBeNull();
  });

  it('cannot be passed off as a reply address signature, or the reverse', () => {
    // Same key, different prefixes: neither token verifies as the other.
    const token = signEmailVerification(USER, 'bea@example.com', config.replySecret, now);
    expect(parseThreadReplyAddress(token, config)).toBeNull();
    expect(readEmailVerification(threadReplyAddress(USER, config), config.replySecret, now)).toBeNull();
  });

  it('falls back to the unsubscribe secret, and is null with neither', () => {
    expect(verifySecretFromEnv({ MAIL_REPLY_SECRET: 'a', ALERT_UNSUBSCRIBE_SECRET: 'b' })).toBe('a');
    expect(verifySecretFromEnv({ ALERT_UNSUBSCRIBE_SECRET: 'b' })).toBe('b');
    expect(verifySecretFromEnv({})).toBeNull();
  });
});

describe('syncReceivedEmails', () => {
  const deps = {
    mailer: {
      sender: { from: { email: 'mail@example.com.au', name: 'Test Co' }, postalAddress: '1 Test St' },
      transport: { send: async () => ({ ok: true as const, id: 'x' }) },
    },
    config,
  };
  const noDb = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } }) as never;

  it('lists, and fetches nothing, when no received email is addressed to us', async () => {
    const asked: string[] = [];
    const result = await syncReceivedEmails(noDb, deps, 'key', {
      now: new Date('2026-10-03T00:00:00Z'),
      fetchImpl: (async (url: string) => {
        asked.push(url);
        return new Response(
          JSON.stringify({
            has_more: false,
            data: [
              { id: 'a', to: ['sales@quotemydecking.example'], created_at: '2026-10-02T00:00:00Z' },
              { id: 'b', to: ['other@elsewhere.example'], created_at: '2026-10-02T00:00:00Z' },
            ],
          }),
        );
      }) as unknown as typeof fetch,
    });
    // Neither is on MAIL_INBOUND_DOMAIN, so neither is fetched and the
    // database is never asked — one list call is the whole cost.
    expect(asked).toEqual(['https://api.resend.com/emails/receiving?limit=100']);
    expect(result).toEqual({ listed: 2, outcomes: [] });
  });

  it('stops paging at mail older than the lookback', async () => {
    let pages = 0;
    await syncReceivedEmails(noDb, deps, 'key', {
      now: new Date('2026-10-03T00:00:00Z'),
      fetchImpl: (async () => {
        pages += 1;
        return new Response(
          JSON.stringify({
            has_more: true,
            data: [{ id: `old-${pages}`, to: ['x@elsewhere.example'], created_at: '2026-08-01T00:00:00Z' }],
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(pages).toBe(1);
  });

  it('reports "not configured" without touching the database or the network', async () => {
    const result = await pullReceivedMail({
      db: () => {
        throw new Error('the database must not be touched');
      },
      env: { RESEND_API_KEY: 'k' },
      fetchImpl: (async () => {
        throw new Error('no network');
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured', followUp: null });
  });
});

describe('the website link in an agency reply', () => {
  it('proves the mailbox for whichever account signs in with that address', () => {
    const link = conversationLink('http://web.test/', '0f0e0d0c-0b0a-4908-8706-050403020100', 'Bea@Example.com', 'k');
    expect(link).toMatch(/^http:\/\/web\.test\/account\/messages\/verify\?t=.+&thread=0f0e0d0c-/);
    const token = decodeURIComponent(/t=([^&]+)/.exec(link)![1]!);
    expect(readEmailVerification(token, 'k')).toEqual({ userId: '*', email: 'bea@example.com' });
  });

  it('appears in both parts of the email, under the sign-off', () => {
    const m = buildConversationEmail({
      to: { email: 'bea@example.com' },
      from: { email: 'mail@example.com.au', name: 'Sara · Ray White' },
      replyTo: { email: 'sara@example.com' },
      postalAddress: '1 Test St',
      subject: 'Enquiry',
      body: 'Hi',
      authorName: 'Sara',
      agencyName: 'Ray White',
      viewUrl: 'http://web.test/account/messages/verify?t=abc&thread=1',
    });
    expect(m.text).toContain('View this conversation on the website: http://web.test/account/messages/verify?t=abc&thread=1');
    expect(m.html).toContain('href="http://web.test/account/messages/verify?t=abc&amp;thread=1"');
  });
});
