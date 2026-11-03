import { describe, expect, it } from 'vitest';
import { asState, buildRenovationPlan, listingRooms, planCards, RenovationError } from './assist';

describe('the plan end to end (ADR 0080, C3)', () => {
  it('keeps the model’s known kinds, drops the rest and any money, and adds our drivers, trades and the state’s permit notes', async () => {
    const plan = await buildRenovationPlan(
      async ({ request }) => ({
        items: [
          { category: 'kitchen', note: `From: ${request.slice(0, 20)}` },
          { category: 'granny_flat', note: 'A granny flat.' },
          { category: 'remove_wall', note: 'Open the kitchen to the dining room, about $15k.' },
          { category: 'deck', note: 'A bigger deck.' },
        ],
      }),
      { request: 'New kitchen with an island, knock out the wall, bigger deck', state: 'VIC' },
    );
    expect(plan.cards.map((c) => c.category)).toEqual(['kitchen', 'deck']);
    expect(plan.cards[0]!.trades).toContain('Plumber');
    expect(plan.cards[0]!.costDrivers.length).toBeGreaterThan(0);
    const deck = plan.permits.find((p) => p.trigger === 'deck_or_raised_structure');
    expect(deck).toMatchObject({ verified: true, source: { name: expect.stringContaining('Building and Plumbing Commission') } });
    expect(JSON.stringify(plan)).not.toMatch(/\$\d/);
  });

  it('a state not verified: every permit note says so; no state: no permit notes', () => {
    expect(planCards([{ category: 'remove_wall', note: 'x' }], 'WA').permits.every((p) => !p.verified)).toBe(true);
    expect(planCards([{ category: 'remove_wall', note: 'x' }], null).permits).toEqual([]);
  });

  it('refuses an empty or huge request before calling anything, and says when the AI is off or failed', async () => {
    const never = async () => {
      throw new Error('called');
    };
    await expect(buildRenovationPlan(never, { request: 'a', state: null })).rejects.toMatchObject({ code: 'invalid' });
    await expect(buildRenovationPlan(never, { request: 'x'.repeat(1001), state: null })).rejects.toMatchObject({ code: 'invalid' });
    await expect(buildRenovationPlan(null, { request: 'new kitchen', state: null })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(buildRenovationPlan(never, { request: 'new kitchen', state: null })).rejects.toBeInstanceOf(RenovationError);
  });

  it('reads only the eight states, and needs a reader before touching the database', async () => {
    expect(asState('QLD')).toBe('QLD');
    expect(asState('qld')).toBeNull();
    await expect(listingRooms({} as never, null, 'x')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
