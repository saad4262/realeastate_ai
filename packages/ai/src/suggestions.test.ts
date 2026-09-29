import { describe, expect, it } from 'vitest';
import type { PublicSearchQuery } from '@repo/core/listings';
import { buildSuggestions, MAX_SUGGESTIONS, WIDEN_RADIUS_KM, type SuggestionInput } from './suggestions';

/**
 * The chips under an answer.
 *
 * These are server-authored, so unlike the prose above them they can be
 * pinned exactly — which is the entire reason they are built here instead of
 * asked of the model. Every case below is one a visitor hits on an ordinary
 * afternoon, and the last group is the one that matters: a chip must never
 * carry a figure the server did not receive.
 */

function input(over: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    facts: {},
    slots: { channel: 'sale', suburb: 'Pakenham' } as PublicSearchQuery,
    scheduling: 'ready',
    scheduleOffered: false,
    failed: false,
    ...over,
  };
}

const kinds = (i: SuggestionInput) => buildSuggestions(i).map((s) => s.kind);

describe('a search that found nothing', () => {
  it('offers to look around the suburb when no radius was tried', () => {
    const out = buildSuggestions(
      input({ facts: { search: { matched: 0, suburb: 'Pakenham' } } }),
    );
    const widen = out.find((s) => s.kind === 'widen_radius');
    expect(widen?.label).toBe(`Within ${WIDEN_RADIUS_KM} km`);
    expect(widen?.send).toBe(`Search within ${WIDEN_RADIUS_KM} km of Pakenham.`);
  });

  /**
   * The case the chip would be actively unhelpful in. Re-running a radius
   * search with the same radius returns the same nothing, and the visitor
   * has now spent a billed turn learning that.
   */
  it('does not offer to widen a search that already had a radius', () => {
    expect(
      kinds(input({ facts: { search: { matched: 0, suburb: 'Pakenham', radiusKm: 10 } } })),
    ).not.toContain('widen_radius');
  });

  it('names the keyword as the filter to drop, ahead of everything else', () => {
    const out = buildSuggestions(
      input({
        facts: { search: { matched: 0, suburb: 'Pakenham' } },
        slots: {
          channel: 'sale',
          suburb: 'Pakenham',
          text: 'pool',
          propertyType: 'Unit',
          priceTo: 600_000,
        } as PublicSearchQuery,
      }),
    );
    const drop = out.find((s) => s.kind === 'drop_filter');
    expect(drop?.label).toContain('pool');
  });

  /** The documented footgun: "House" is a word, not a propertyType. */
  it('falls back to the property type when there is no keyword', () => {
    const out = buildSuggestions(
      input({
        facts: { search: { matched: 0, suburb: 'Pakenham' } },
        slots: { channel: 'sale', suburb: 'Pakenham', propertyType: 'Unit' } as PublicSearchQuery,
      }),
    );
    expect(out.find((s) => s.kind === 'drop_filter')?.label).toBe('Any property type');
  });

  it('offers nothing to drop when the visitor gave no narrowing filter', () => {
    expect(
      kinds(input({ facts: { search: { matched: 0, suburb: 'Pakenham' } } })),
    ).not.toContain('drop_filter');
  });
});

describe('a search that found something', () => {
  it('offers cheapest-first once there is more than one', () => {
    expect(kinds(input({ facts: { search: { matched: 4, suburb: 'Pakenham' } } }))).toContain(
      'cheapest_first',
    );
  });

  it('does not offer cheapest-first on a single match', () => {
    expect(kinds(input({ facts: { search: { matched: 1, suburb: 'Pakenham' } } }))).not.toContain(
      'cheapest_first',
    );
  });

  /** The answer above the chip has just led with the cheapest one. */
  it('does not offer cheapest-first when the brief is already sorted that way', () => {
    expect(
      kinds(
        input({
          facts: { search: { matched: 4, suburb: 'Pakenham' } },
          slots: { channel: 'sale', suburb: 'Pakenham', sort: 'price_asc' } as PublicSearchQuery,
        }),
      ),
    ).not.toContain('cheapest_first');
  });
});

describe('the cheaper suburb next door', () => {
  const nearby = {
    nearbyCentre: 'Berwick',
    nearby: [
      { suburb: 'Berwick', cheapest: '$820,000' },
      { suburb: 'Officer', cheapest: '$640,000' },
    ],
  };

  it('names the first suburb that is not the one they are looking at', () => {
    const out = buildSuggestions(input({ facts: nearby }));
    const chip = out.find((s) => s.kind === 'nearby_cheaper');
    expect(chip?.label).toBe('Officer — from $640,000');
    expect(chip?.send).toBe('Show me what is for sale in Officer.');
  });

  it('says "for rent" when that is the channel', () => {
    const out = buildSuggestions(
      input({
        facts: nearby,
        slots: { channel: 'rent', suburb: 'Berwick' } as PublicSearchQuery,
      }),
    );
    expect(out.find((s) => s.kind === 'nearby_cheaper')?.send).toBe(
      'Show me what is for rent in Officer.',
    );
  });

  /** Sending somebody back to where they already are is not a next step. */
  it('offers nothing when the only suburb is the one they are in', () => {
    expect(
      kinds(
        input({
          facts: { nearbyCentre: 'Berwick', nearby: [{ suburb: 'Berwick', cheapest: '$820,000' }] },
        }),
      ),
    ).not.toContain('nearby_cheaper');
  });

  it('counts the listings that carry no price', () => {
    const out = buildSuggestions(input({ facts: { ...nearby, unpriced: 3 } }));
    expect(out.find((s) => s.kind === 'unpriced')?.label).toBe('3 without a price');
  });
});

describe('the schedule offer', () => {
  it('is offered once a search is possible', () => {
    expect(kinds(input())).toContain('schedule');
  });

  /** A card is already on screen waiting for Accept. */
  it('is withheld when a draft card was put on screen this turn', () => {
    expect(kinds(input({ scheduleOffered: true }))).not.toContain('schedule');
  });

  /**
   * Signed out is NOT a reason to hide it. Pressing it gets "sign in and I
   * will set it up", which is a ten-second fix the visitor can act on.
   */
  it('is still offered to a signed-out visitor', () => {
    expect(kinds(input({ scheduling: 'signed_out' }))).toContain('schedule');
  });

  /** Nobody in the conversation can fix a missing signing secret. */
  it('is withheld when the server cannot schedule at all', () => {
    expect(kinds(input({ scheduling: 'unconfigured' }))).not.toContain('schedule');
  });

  it('is withheld before the brief names a channel and a suburb', () => {
    expect(kinds(input({ slots: { channel: 'sale' } as PublicSearchQuery }))).not.toContain(
      'schedule',
    );
  });
});

describe('the shape of the list', () => {
  it('never exceeds the cap, because every chip costs a billed turn', () => {
    const out = buildSuggestions(
      input({
        facts: {
          search: { matched: 0, suburb: 'Pakenham' },
          nearbyCentre: 'Pakenham',
          nearby: [{ suburb: 'Officer', cheapest: '$640,000' }],
          unpriced: 2,
        },
        slots: {
          channel: 'sale',
          suburb: 'Pakenham',
          text: 'pool',
          priceTo: 600_000,
        } as PublicSearchQuery,
      }),
    );
    expect(out).toHaveLength(MAX_SUGGESTIONS);
    // Priority order, not insertion order: the data-backed offer survives.
    expect(out[0]?.kind).toBe('nearby_cheaper');
  });

  it('never repeats a kind', () => {
    const out = buildSuggestions(
      input({ facts: { search: { matched: 9, suburb: 'Pakenham' }, unpriced: 1 } }),
    );
    expect(new Set(out.map((s) => s.kind)).size).toBe(out.length);
  });

  /** Chips under an error read as a menu of things that might work. */
  it('offers nothing at all when the turn failed', () => {
    expect(
      buildSuggestions(
        input({ facts: { search: { matched: 0, suburb: 'Pakenham' } }, failed: true }),
      ),
    ).toEqual([]);
  });

  it('offers nothing when no tool ran and there is no brief', () => {
    expect(buildSuggestions(input({ slots: {} as PublicSearchQuery }))).toEqual([]);
  });
});

/**
 * Non-negotiable #4, on the one surface that could quietly break it.
 *
 * A chip is server text sitting directly under model text, and it is the
 * easiest place in the product for an invented figure to look official.
 */
describe('every figure comes from somewhere', () => {
  it('echoes the visitor\'s own ceiling rather than proposing a new one', () => {
    const out = buildSuggestions(
      input({
        facts: { search: { matched: 0, suburb: 'Pakenham' } },
        slots: { channel: 'sale', suburb: 'Pakenham', priceTo: 600_000 } as PublicSearchQuery,
      }),
    );
    const drop = out.find((s) => s.kind === 'drop_filter');
    // The number on screen is the one they gave. Nothing was raised by 10%.
    expect(drop?.label).toContain('600');
    expect(drop?.send).not.toMatch(/\d/);
  });

  it('copies the price label byte for byte from the tool result', () => {
    const out = buildSuggestions(
      input({
        facts: {
          nearbyCentre: 'Berwick',
          nearby: [{ suburb: 'Officer', cheapest: 'Contact agent' }],
        },
      }),
    );
    expect(out.find((s) => s.kind === 'nearby_cheaper')?.label).toBe(
      'Officer — from Contact agent',
    );
  });

  /**
   * The guard that matters. Only two chips may carry a number at all: the
   * dropped budget (the visitor's own) and the unpriced count (Postgres's).
   * Anything else with a digit in it is a figure this file invented.
   */
  it('puts no number in any other chip', () => {
    const out = buildSuggestions(
      input({
        facts: { search: { matched: 7, suburb: 'Pakenham' }, nearbyCentre: 'Pakenham' },
        slots: { channel: 'sale', suburb: 'Pakenham' } as PublicSearchQuery,
      }),
    );
    for (const chip of out) {
      expect(chip.label).not.toMatch(/\d/);
    }
  });
});
