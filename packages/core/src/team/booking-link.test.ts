import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { usesBookingLink, unknownMergeFields } from '../template-email/schema';
import { mayEditBookingLink, parseBookingUrl, setBookingLink } from './booking-link';

/** ADR 0107: each person's own booking link — https only, set by them, never by a read-only member. */

const as = (membershipRole: Actor['membershipRole']): Actor => ({ userId: 'u1', agencyId: 'a1', membershipRole });

describe('parseBookingUrl', () => {
  it('takes an https link; empty clears it; anything else is refused with a reason', () => {
    expect(parseBookingUrl('  https://calendly.com/liam  ')).toEqual({ ok: true, url: 'https://calendly.com/liam' });
    expect(parseBookingUrl('')).toEqual({ ok: true, url: null });
    expect(parseBookingUrl('http://calendly.com/liam')).toMatchObject({ ok: false });
    expect(parseBookingUrl('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(parseBookingUrl('calendly')).toMatchObject({ ok: false });
    expect(parseBookingUrl(`https://x.com/${'a'.repeat(300)}`)).toMatchObject({ ok: false });
  });
});

describe('who may set it', () => {
  it('any member for themselves, but not a read-only one; nothing is written for them', async () => {
    expect(['owner', 'admin', 'agent'].map((r) => mayEditBookingLink(as(r as Actor['membershipRole'])))).toEqual([true, true, true]);
    expect(mayEditBookingLink(as('read_only'))).toBe(false);
    const update = vi.fn();
    await expect(setBookingLink({ update } as unknown as Db, as('read_only'), 'https://calendly.com/x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setBookingLink({ update } as unknown as Db, as('agent'), 'http://insecure.example')).rejects.toMatchObject({ code: 'invalid' });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('{{booking_link}} in a template', () => {
  it('is a merge field there is, and a template knows when it uses it', () => {
    expect(unknownMergeFields('Book here: {{booking_link}}')).toEqual([]);
    expect(usesBookingLink('Hi {{first_name}}', 'Book: {{ booking_link }}')).toBe(true);
    expect(usesBookingLink('Hi {{first_name}}')).toBe(false);
  });
});
