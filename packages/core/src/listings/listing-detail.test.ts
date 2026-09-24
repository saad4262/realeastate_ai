import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import {
  HISTORIC_STATUSES,
  listingAgentCards,
  propertyTimeline,
} from './listing-detail';

/**
 * A builder that answers with whatever rows the test hands it.
 *
 * It cannot check a WHERE clause — that is Postgres's job and `pnpm smoke`
 * asks the real one. What it can check is everything this module does in
 * TypeScript after the rows come back, which is where the privacy decisions
 * live.
 */
function fakeDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) {
    chain[m] = () => chain;
  }
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return chain as unknown as Db;
}

describe("a property's public history", () => {
  /**
   * The one that matters.
   *
   * A property outlives its listings (#1), so every ad an agency ever wrote
   * against this address shares its property_id — including the drafts they
   * are working on today. Selecting by property_id without this filter would
   * publish an agency's unpublished pipeline on the address it belongs to.
   */
  it('never includes a status the public was not allowed to see', () => {
    expect(HISTORIC_STATUSES).not.toContain('draft');
    expect(HISTORIC_STATUSES).not.toContain('pending');
    // Public once, so not a leak — but "listed and pulled" is a claim about
    // why a sale did not happen, and this page has no idea.
    expect(HISTORIC_STATUSES).not.toContain('withdrawn');
    expect([...HISTORIC_STATUSES].sort()).toEqual(['live', 'sold', 'under_offer']);
  });

  it('turns the driver s numeric string into a number', async () => {
    // sold_price is numeric, and the driver hands numeric back as a STRING —
    // the same lie the bigint counts told. "1200000" reaching a chart or a
    // sum is the bug this prevents.
    const [entry] = await propertyTimeline(
      fakeDb([
        {
          listingId: 'l-1',
          channel: 'sold',
          status: 'sold',
          priceDisplay: 'Sold $1.20m',
          soldPrice: '1200000.00',
          soldDate: new Date('2023-06-15'),
          publishedAt: null,
          agencyName: 'Harcourts',
        },
      ]),
      'p-1',
    );

    expect(entry?.soldPrice).toBe(1_200_000);
    expect(typeof entry?.soldPrice).toBe('number');
  });

  it('keeps a missing sold price as null rather than NaN', async () => {
    const [entry] = await propertyTimeline(
      fakeDb([
        {
          listingId: 'l-2',
          channel: 'sale',
          status: 'live',
          priceDisplay: 'Offers over $700,000',
          soldPrice: null,
          soldDate: null,
          publishedAt: new Date('2026-09-01'),
          agencyName: 'Harcourts',
        },
      ]),
      'p-1',
    );

    // Number(null) is 0, which would read as "sold for nothing".
    expect(entry?.soldPrice).toBeNull();
  });
});

describe('the agents on a public listing', () => {
  const agent = (over: Record<string, unknown> = {}) => ({
    name: 'Daniel Vance',
    phone: '0412 884 920',
    role: 'lead',
    isPublic: true,
    photoUrl: 'https://example.test/daniel.jpg',
    bio: 'Fifteen years in the south east.',
    licenceNumber: '081292L',
    ...over,
  });

  it('shows the profile of an agent who has made it public', async () => {
    const [card] = await listingAgentCards(fakeDb([agent()]), 'l-1');
    expect(card?.photoUrl).toBe('https://example.test/daniel.jpg');
    expect(card?.bio).toContain('south east');
    expect(card?.licenceNumber).toBe('081292L');
  });

  /**
   * `agent_profile.public` exists to answer "may this person's details be
   * shown to the public", and this is the page that has to ask. A profile the
   * agent has not published must not appear on an unauthenticated page just
   * because they are named on a listing.
   */
  it('withholds photo, bio and licence when the profile is not public', async () => {
    const [card] = await listingAgentCards(fakeDb([agent({ isPublic: false })]), 'l-1');
    expect(card?.photoUrl).toBeNull();
    expect(card?.bio).toBeNull();
    expect(card?.licenceNumber).toBeNull();
    // The ad still has to say who to call.
    expect(card?.name).toBe('Daniel Vance');
    expect(card?.phone).toBe('0412 884 920');
  });

  it('treats a missing profile row the same as a private one', async () => {
    // LEFT JOIN: an agent with no agent_profile at all still appears on their
    // own listing rather than vanishing from it.
    const [card] = await listingAgentCards(
      fakeDb([agent({ isPublic: null, photoUrl: null, bio: null, licenceNumber: null })]),
      'l-1',
    );
    expect(card?.name).toBe('Daniel Vance');
    expect(card?.photoUrl).toBeNull();
  });

  it('never returns an email address', async () => {
    // listing_agent carries snapshot_email and this deliberately does not
    // select it. A phone number on a property ad is the convention; an email
    // rendered into a public page is harvested within days.
    const [card] = await listingAgentCards(
      fakeDb([{ ...agent(), snapshotEmail: 'daniel@example.test' }]),
      'l-1',
    );
    expect(JSON.stringify(card)).not.toContain('@');
    expect(Object.keys(card ?? {})).not.toContain('email');
  });
});
