import { describe, expect, it } from 'vitest';
import { addToShortlist, listShortlist, removeFromShortlist, setShortlistNote, shortlistedAmong, shortlistState, ShortlistError } from './shortlist';

describe('the shortlist (ADR 0080, C4 decision 1)', () => {
  it('says what a saved home is now, in the buyer’s terms — never "withdrawn" (decision 3)', () => {
    expect(shortlistState('live', 'sale', true)).toBe('for_sale');
    expect(shortlistState('live', 'rent', true)).toBe('for_rent');
    expect(shortlistState('under_offer', 'sale', false)).toBe('under_offer');
    expect(shortlistState('sold', 'sale', false)).toBe('sold');
    expect(shortlistState('withdrawn', 'sale', false)).toBe('not_advertised');
    // Live but its agency suspended: not public, so not advertised.
    expect(shortlistState('live', 'sale', false)).toBe('not_advertised');
  });

  it('refuses a signed-out actor before reading anything', async () => {
    const nothing = {} as never;
    for (const call of [
      () => addToShortlist(nothing, { userId: '' }, 'x'),
      () => removeFromShortlist(nothing, { userId: '' }, 'x'),
      () => setShortlistNote(nothing, { userId: '' }, 'x', 'n'),
      () => shortlistedAmong(nothing, { userId: '' }, ['x']),
      () => listShortlist(nothing, { userId: '' }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ShortlistError);
    }
  });

  it('a note that is too long is refused before it is written', async () => {
    await expect(setShortlistNote({} as never, { userId: 'b' }, 'x', 'a'.repeat(501))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('asking about no listings is no read at all', async () => {
    expect(await shortlistedAmong({} as never, { userId: 'b' }, [])).toEqual(new Set());
  });
});
