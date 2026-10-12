import { describe, expect, it } from 'vitest';
import { buildConversationEmail } from '../email/conversation';
import { buildTeamMessageEmail } from '../email/team-notices';
import { can, type Actor } from '../permissions';
import { figuresIn } from '../assistant/write-tools';
import { parseTeamReplyAddress, parseThreadReplyAddress, teamReplyAddress, threadReplyAddress, type MailConfig } from './address';
import { routeRecipients } from './inbound';
import { composeInputSchema, teamMessageStartSchema } from './mail-schema';

/** ADR 0035: a new email to a contact, team messages, and the assistant's figures check. */

const config: MailConfig = { inboundDomain: 'reply.example.com.au', replySecret: 'unit-test-secret' };
const THREAD = '0f0e0d0c-0b0a-4908-8706-050403020100';
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const sara = '33333333-3333-4333-8333-333333333333';
const omar = '44444444-4444-4444-8444-444444444444';
const lee = '55555555-5555-4555-8555-555555555555';

const member = (userId: string, role: Actor['membershipRole'], agencyId = A): Actor => ({ userId, agencyId, membershipRole: role });

describe('team reply addresses (ADR 0035 §3)', () => {
  it('round-trip, and are signed apart from a conversation’s', () => {
    const team = teamReplyAddress(THREAD, config);
    expect(team).toMatch(/^m\+0f0e0d0c-0b0a-4908-8706-050403020100\.[0-9a-f]{20}@reply\.example\.com\.au$/);
    expect(parseTeamReplyAddress(`"Sara" <${team.toUpperCase()}>`, config)).toBe(THREAD);
    // The same id's conversation signature does not open the team thread, nor the reverse.
    const sigOf = (a: string) => a.split('.')[1]!.split('@')[0]!;
    const forged = `m+${THREAD}.${sigOf(threadReplyAddress(THREAD, config))}@${config.inboundDomain}`;
    expect(parseTeamReplyAddress(forged, config)).toBeNull();
    expect(parseThreadReplyAddress(`t+${THREAD}.${sigOf(team)}@${config.inboundDomain}`, config)).toBeNull();
    expect(parseTeamReplyAddress(team.replace('reply.example', 'evil.example'), config)).toBeNull();
  });

  it('routes to the team thread — never to an agency named "m"', () => {
    expect(routeRecipients([teamReplyAddress(THREAD, config)], config)).toEqual({ teamThreadId: THREAD });
    expect(routeRecipients([threadReplyAddress(THREAD, config), teamReplyAddress(THREAD, config)], config)).toEqual({ threadId: THREAD });
  });
});

describe('who may write (ADR 0035)', () => {
  const contact = { type: 'contact', id: 'c1', agencyId: A, ownerId: omar };

  it('a new email to a contact: its assignee or an owner/admin, never read-only or another agency', () => {
    expect(can(member(omar, 'agent'), 'mail:compose', contact)).toBe(true);
    expect(can(member(sara, 'owner'), 'mail:compose', contact)).toBe(true);
    expect(can(member(sara, 'admin'), 'mail:compose', contact)).toBe(true);
    expect(can(member(lee, 'agent'), 'mail:compose', contact)).toBe(false);
    expect(can(member(omar, 'read_only'), 'mail:compose', contact)).toBe(false);
    expect(can(member(sara, 'owner', B), 'mail:compose', contact)).toBe(false);
  });

  it('a team conversation: only the people on it — not even the owner', () => {
    const thread = { type: 'team_thread', id: 't1', agencyId: A, participantIds: [omar, lee] };
    expect(can(member(omar, 'agent'), 'team_message:read', thread)).toBe(true);
    expect(can(member(lee, 'agent'), 'team_message:send', thread)).toBe(true);
    expect(can(member(sara, 'owner'), 'team_message:read', thread)).toBe(false);
    expect(can(member(omar, 'agent', B), 'team_message:read', thread)).toBe(false);
    expect(can(member(omar, 'agent'), 'team_message:read', { ...thread, participantIds: undefined })).toBe(false);
  });

  it('read-only members read team messages but write none', () => {
    const page = { type: 'team_thread', agencyId: A };
    const thread = { ...page, id: 't1', participantIds: [lee] };
    expect(can(member(lee, 'read_only'), 'team_message:read', thread)).toBe(true);
    expect(can(member(lee, 'read_only'), 'team_message:send', thread)).toBe(false);
    expect(can(member(lee, 'read_only'), 'team_message:send', page)).toBe(false);
    expect(can(member(lee, 'agent'), 'team_message:send', page)).toBe(true);
    expect(can({ userId: lee }, 'team_message:read', page)).toBe(false);
  });
});

describe('the contracts', () => {
  it('a new email needs a subject and a body; whitespace is not either', () => {
    expect(composeInputSchema.safeParse({ subject: '  Inspection  moved ', body: ' Hi\r\n' }).data).toEqual({ subject: 'Inspection moved', body: 'Hi' });
    expect(composeInputSchema.safeParse({ subject: '   ', body: 'Hi' }).success).toBe(false);
    expect(composeInputSchema.safeParse({ subject: 'x'.repeat(201), body: 'Hi' }).success).toBe(false);
    expect(composeInputSchema.safeParse({ subject: 'Hi', body: '\n\n' }).success).toBe(false);
  });

  it('a team message names 1–10 people by id — never an address', () => {
    expect(teamMessageStartSchema.safeParse({ to: [omar], subject: 's', body: 'b' }).success).toBe(true);
    expect(teamMessageStartSchema.safeParse({ to: [], subject: 's', body: 'b' }).success).toBe(false);
    expect(teamMessageStartSchema.safeParse({ to: ['omar@example.com'], subject: 's', body: 'b' }).success).toBe(false);
    expect(teamMessageStartSchema.safeParse({ to: Array.from({ length: 11 }, () => omar), subject: 's', body: 'b' }).success).toBe(false);
  });
});

describe('the emails', () => {
  const base = {
    to: { email: 'ahmed@example.com', name: 'Ahmed' },
    from: { email: 'hello@localagenthub.com.au', name: 'Omar · Harbour Realty' },
    replyTo: { email: threadReplyAddress(THREAD, config), name: 'Omar · Harbour Realty' },
    postalAddress: '1 George St, Sydney NSW 2000',
    subject: 'Saturday’s inspection',
    body: 'Hi Ahmed,\n\nThe inspection has moved to Saturday.',
    authorName: 'Omar',
    agencyName: 'Harbour Realty',
  };

  it('a new email: its own subject, the unsubscribe link, no claim they enquired — and still one-to-one', () => {
    const email = buildConversationEmail({ ...base, opening: { optOutUrl: 'https://site.example/unsubscribe?t=abc' } });
    expect(email.kind).toBe('transactional');
    expect(email.subject).toBe('Saturday’s inspection');
    expect(email.text).toContain('Unsubscribe: https://site.example/unsubscribe?t=abc');
    expect(email.html).toContain('https://site.example/unsubscribe?t=abc');
    expect(email.text).not.toMatch(/in reply to your enquiry/);
  });

  it('a reply is unchanged: "Re:", no unsubscribe link', () => {
    const email = buildConversationEmail(base);
    expect(email.subject).toBe('Re: Saturday’s inspection');
    expect(email.text).not.toMatch(/Unsubscribe/);
  });

  it('a team message: the words in full, escaped, with the way back', () => {
    const email = buildTeamMessageEmail({
      to: { email: 'sara@example.com' },
      from: { email: 'hello@localagenthub.com.au', name: 'LocalAgentHub' },
      replyTo: { email: teamReplyAddress(THREAD, config), name: 'Contract' },
      postalAddress: '1 George St, Sydney NSW 2000',
      agencyName: 'Harbour Realty',
      writer: 'Omar <b>',
      subject: 'Smith contract',
      body: 'Signed <script>x</script>',
      others: ['Lee'],
      threadUrl: 'https://agency.example/messages?thread=1',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain('Signed <script>x</script>');
    expect(email.text).toContain('https://agency.example/messages?thread=1');
    expect(email.replyTo?.email).toMatch(/^m\+/);
  });
});

describe('figures the assistant wrote are listed for checking (ADR 0035 §4)', () => {
  it('finds prices, dates, times and percentages; none in plain words', () => {
    expect(figuresIn('The price guide is $950,000 and the inspection is 14 Oct at 10:30am, up 3.5%.')).toEqual(['$950,000', '14', '10:30am', '3.5%']);
    expect(figuresIn('Hi Ahmed, thanks for your time today.')).toEqual([]);
    expect(figuresIn('Call me on 0418 920 441.')).toEqual(['0418', '920', '441']);
  });
});
