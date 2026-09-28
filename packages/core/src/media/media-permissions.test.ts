import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { assertCanEditAgentPhoto, assertCanEditListingMedia } from './media-permissions';
import { keyBelongsTo, newStorageKey, storageKeySchema } from './storage-key';

/**
 * Every new endpoint needs a permission test — CLAUDE.md #2.
 *
 * Image upload is the first thing on this platform that writes a file, and the
 * two questions it has to get right are "whose listing is this" and "whose
 * face is this". Both are decided by an agency id the browser never supplies,
 * so both are tested by handing the caller an id from somewhere else and
 * checking it is refused.
 */

const OURS = '11111111-1111-1111-1111-111111111111';
const THEIRS = '22222222-2222-2222-2222-222222222222';
const LISTING = '33333333-3333-3333-3333-333333333333';
const ME = '44444444-4444-4444-4444-444444444444';
const SOMEONE_ELSE = '55555555-5555-5555-5555-555555555555';

/** Returns whatever rows it is given, for any query. */
function fakeDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) {
    chain[m] = () => chain;
  }
  chain.limit = () => Promise.resolve(rows);
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return chain as unknown as Db;
}

const owner: Actor = { userId: ME, agencyId: OURS, membershipRole: 'owner' };
const agent: Actor = { userId: ME, agencyId: OURS, membershipRole: 'agent' };

describe('who may change a listing’s photos', () => {
  it('an agency admin may, for a listing in their agency', async () => {
    const db = fakeDb([{ agencyId: OURS }]);
    await expect(assertCanEditListingMedia(db, owner, LISTING)).resolves.toBeUndefined();
  });

  it('an admin may NOT, for a listing in another agency', async () => {
    const db = fakeDb([{ agencyId: THEIRS }]);
    await expect(assertCanEditListingMedia(db, owner, LISTING)).rejects.toThrow();
  });

  it('an agent named on the listing may', async () => {
    const db = fakeDb([{ agencyId: OURS }]);
    const named: Actor = { ...agent, listingAgentOf: [LISTING] };
    await expect(assertCanEditListingMedia(db, named, LISTING)).resolves.toBeUndefined();
  });

  it('an agent NOT named on the listing may not, even in the same agency', async () => {
    // This is the case that separates listing:edit from "is a member here".
    const db = fakeDb([{ agencyId: OURS }]);
    const other: Actor = { ...agent, listingAgentOf: [] };
    await expect(assertCanEditListingMedia(db, other, LISTING)).rejects.toThrow();
  });

  it('a listing that does not exist is refused, not allowed through', async () => {
    const db = fakeDb([]);
    await expect(assertCanEditListingMedia(db, owner, LISTING)).rejects.toThrow();
  });

  it('says "could not be found" either way, so ids cannot be probed', async () => {
    // Distinguishing "not yours" from "does not exist" tells an outsider which
    // listing ids are real.
    const missing = await assertCanEditListingMedia(fakeDb([]), owner, LISTING).catch(
      (e: Error) => e.message,
    );
    const theirs = await assertCanEditListingMedia(
      fakeDb([{ agencyId: THEIRS }]),
      owner,
      LISTING,
    ).catch((e: Error) => e.message);
    expect(missing).toBe(theirs);
  });
});

describe('who may change an agent’s photo', () => {
  it('someone who manages the team may', async () => {
    const db = fakeDb([{ userId: SOMEONE_ELSE }]);
    await expect(assertCanEditAgentPhoto(db, owner, SOMEONE_ELSE)).resolves.toBeUndefined();
  });

  it('an agent may change their own', async () => {
    const db = fakeDb([{ userId: ME }]);
    await expect(assertCanEditAgentPhoto(db, agent, ME)).resolves.toBeUndefined();
  });

  it('an agent may NOT change a colleague’s', async () => {
    const db = fakeDb([{ userId: SOMEONE_ELSE }]);
    await expect(assertCanEditAgentPhoto(db, agent, SOMEONE_ELSE)).rejects.toThrow();
  });

  it('an owner may not reach an agent outside their agency', async () => {
    // The membership lookup is scoped to the actor's own agency, so a user in
    // another agency simply has no row here.
    const db = fakeDb([]);
    await expect(assertCanEditAgentPhoto(db, owner, SOMEONE_ELSE)).rejects.toThrow();
  });

  it('an actor with no agency is refused', async () => {
    const db = fakeDb([{ userId: ME }]);
    const nobody: Actor = { userId: ME };
    await expect(assertCanEditAgentPhoto(db, nobody, ME)).rejects.toThrow();
  });
});

/**
 * The key is a path, and a path from a browser is an attack surface.
 *
 * These are the checks that stop a well-formed request attaching somebody
 * else's file, or writing outside the folder it was authorised for.
 */
describe('storage keys', () => {
  it('a key issued for a listing belongs to that listing and no other', () => {
    const key = newStorageKey({ kind: 'listing', id: LISTING }, 'image/jpeg');
    expect(keyBelongsTo(key, { kind: 'listing', id: LISTING })).toBe(true);
    expect(keyBelongsTo(key, { kind: 'listing', id: THEIRS })).toBe(false);
    // Same id, wrong kind: an agent folder is not a listing folder.
    expect(keyBelongsTo(key, { kind: 'agent', id: LISTING })).toBe(false);
  });

  it('refuses traversal, absolute paths and anything that is not the shape', () => {
    for (const bad of [
      `listings/${LISTING}/../../${THEIRS}/x.jpg`,
      `../${LISTING}/x.jpg`,
      `/listings/${LISTING}/x.jpg`,
      `listings/${LISTING}/x.jpg`, // filename is not a uuid
      `listings/${LISTING}/${LISTING}.svg`, // not an allowed extension
      `listings/${LISTING}/${LISTING}.jpg\nlistings/x.jpg`,
      `other/${LISTING}/${LISTING}.jpg`,
      '',
    ]) {
      expect(storageKeySchema.safeParse(bad).success).toBe(false);
      expect(keyBelongsTo(bad, { kind: 'listing', id: LISTING })).toBe(false);
    }
  });

  it('scopes an agency key to that agency and nothing else', () => {
    /**
     * The onboarding wizard uploads before the agent exists, so the key is
     * owned by the agency. It must not then satisfy a check for an agent — the
     * two folders are different owners with different permissions behind them.
     */
    const key = newStorageKey({ kind: 'agency', id: OURS }, 'image/jpeg');
    expect(key.startsWith(`agencies/${OURS}/`)).toBe(true);
    expect(keyBelongsTo(key, { kind: 'agency', id: OURS })).toBe(true);
    expect(keyBelongsTo(key, { kind: 'agency', id: THEIRS })).toBe(false);
    expect(keyBelongsTo(key, { kind: 'agent', id: OURS })).toBe(false);
    expect(keyBelongsTo(key, { kind: 'listing', id: OURS })).toBe(false);
  });

  it('keeps the three folders apart for the same id', () => {
    // Same uuid, three owners, three prefixes. A key that matched all three
    // would let a listing upload land on an agent's profile.
    const prefixes = (['listing', 'agent', 'agency'] as const).map(
      (kind) => newStorageKey({ kind, id: OURS }, 'image/png').split('/')[0],
    );
    expect(new Set(prefixes).size).toBe(3);
  });

  it('takes the extension from the MIME type, never from the filename', () => {
    // A file called "shell.php.jpg" uploaded as image/png is stored as .png.
    const key = newStorageKey({ kind: 'agent', id: ME }, 'image/png');
    expect(key.endsWith('.png')).toBe(true);
    expect(() => newStorageKey({ kind: 'agent', id: ME }, 'image/svg+xml')).toThrow();
    expect(() => newStorageKey({ kind: 'agent', id: ME }, 'text/html')).toThrow();
  });
});
