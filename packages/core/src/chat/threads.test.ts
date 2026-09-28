import { describe, expect, it } from 'vitest';
import { can, type Actor } from '../permissions';
import { CHAT_RETENTION_DAYS, titleFrom, toModelTurns, type StoredTurn } from './threads';

const me: Actor = { userId: 'buyer-1' };
const someoneElse: Actor = { userId: 'buyer-2' };
const mine = { type: 'chat', id: 'thread-1', ownerId: 'buyer-1' };

/**
 * A saved conversation says where somebody wants to live and what they can
 * spend, in their own words. These are the tests that say who may read it.
 */
describe('chat permissions', () => {
  it('lets the owner read and write their own thread, and nobody else', () => {
    expect(can(me, 'chat:read', mine)).toBe(true);
    expect(can(me, 'chat:write', mine)).toBe(true);

    expect(can(someoneElse, 'chat:read', mine)).toBe(false);
    expect(can(someoneElse, 'chat:write', mine)).toBe(false);
  });

  /**
   * The same line the saved searches hold. An agency owner is the most
   * powerful actor everywhere else in `can()`; here they are nobody.
   */
  it('denies an agency owner any access to a consumer conversation', () => {
    const owner: Actor = {
      userId: 'owner-a',
      agencyId: '11111111-1111-1111-1111-111111111111',
      membershipRole: 'owner',
    };

    expect(can(owner, 'chat:read', mine)).toBe(false);
    expect(can(owner, 'chat:write', mine)).toBe(false);
    expect(can(owner, 'chat:read', { type: 'chat', ownerId: 'owner-a' })).toBe(true);
  });

  /** Both `undefined` compares equal, which would hand every ownerless row away. */
  it('does not let an ownerless thread match an actorless request', () => {
    expect(can({ userId: '' }, 'chat:read', { type: 'chat' })).toBe(false);
    expect(can(me, 'chat:read', { type: 'chat' })).toBe(false);
  });
});

describe('titleFrom', () => {
  it('names a thread after the first thing the person said', () => {
    expect(titleFrom('  a house to rent in Pakenham  ')).toBe('a house to rent in Pakenham');
  });

  it('collapses whitespace and truncates a long opening', () => {
    expect(titleFrom('a\n\nhouse   to rent')).toBe('a house to rent');

    const long = 'x'.repeat(200);
    const title = titleFrom(long);
    expect(title).toHaveLength(58);
    expect(title.endsWith('…')).toBe(true);
  });

  it('never produces an empty name', () => {
    expect(titleFrom('   ')).toBe('New conversation');
  });
});

describe('retention', () => {
  /**
   * APP 11.2. The number is asserted so that changing it is a deliberate
   * edit to a test rather than a quiet edit to a constant.
   */
  it('is 90 days', () => {
    expect(CHAT_RETENTION_DAYS).toBe(90);
  });
});

describe('toModelTurns', () => {
  const turn = (over: Partial<StoredTurn> = {}): StoredTurn => ({
    id: 'm1',
    role: 'assistant',
    text: 'Here are three near the station.',
    searches: [{ query: { suburb: 'Pakenham' }, matched: 3, shown: 3 }],
    resultsFrame: {
      listings: [{ id: 'l1', priceDisplay: '$780,000', address: '12 Example St' }],
    },
    deepLink: '/search?suburb=Pakenham',
    createdAt: new Date('2026-09-26T00:00:00Z'),
    ...over,
  });

  /**
   * The reason storing a transcript is safe at all.
   *
   * A tool result is the only legitimate source of a price (#4), and
   * `chatRequestSchema` refuses one from a client for exactly that reason.
   * A replayed transcript must not become a second source — so the stored
   * listings never go back to the model. Break the `.map` below to include
   * `resultsFrame` and this is what goes red.
   */
  it('drops the stored listings, so a replay cannot carry a price', () => {
    const [projected] = toModelTurns([turn()]);

    expect(projected).toEqual({
      role: 'assistant',
      text: 'Here are three near the station.',
      searches: [{ query: { suburb: 'Pakenham' }, matched: 3, shown: 3 }],
    });

    // Belt and braces: no price survives anywhere in the payload.
    expect(JSON.stringify(projected)).not.toContain('780,000');
    expect(JSON.stringify(projected)).not.toContain('priceDisplay');
  });

  it('keeps only the keys chatRequestSchema accepts', () => {
    const [projected] = toModelTurns([turn()]);
    expect(Object.keys(projected ?? {}).sort()).toEqual(['role', 'searches', 'text']);
  });

  /** The client sends at most 12; a stored thread must not send more. */
  it('caps the replay at twelve turns, keeping the most recent', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      turn({ id: `m${i}`, text: `turn ${i}` }),
    );
    const projected = toModelTurns(many);

    expect(projected).toHaveLength(12);
    expect(projected[projected.length - 1]?.text).toBe('turn 29');
  });
});
