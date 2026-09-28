import { z } from 'zod';

/**
 * What a storage key is, and what it is not.
 *
 * `media.storage_key` and `agent_profile.photo_key` hold a KEY — a path inside
 * one bucket — and never a URL. That is the single decision this whole module
 * exists to protect. A row that holds
 *
 *     https://ydz….supabase.co/storage/v1/object/public/media/listings/…
 *
 * has the host baked into it, and moving to R2 (which CLAUDE.md still names as
 * where media belongs) then means rewriting every row in the table and every
 * component that happened to read one. A row that holds
 *
 *     listings/<listingId>/<uuid>.jpg
 *
 * costs one function — `mediaUrl` — and nothing else.
 *
 * ## Why the shape is validated rather than trusted
 *
 * The key is the path the file is written to and read from, and part of it is
 * chosen by the server from ids it controls. But it also travels to the browser
 * (to build a signed upload URL) and comes back (to record the row), so by the
 * time it is stored it has been round-tripped through a client. A key of
 * `../../other-agency/secret.jpg` is the obvious attack and a key with a
 * newline in it is the boring one.
 *
 * So: a strict regex, an owner id the caller supplies from the session, and a
 * check that the two agree. Nothing here takes the browser's word for whose
 * listing a file belongs to.
 */

/** Extensions the bucket accepts. Matched to its allowed_mime_types. */
export const MEDIA_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const;
export type MediaExtension = (typeof MEDIA_EXTENSIONS)[number];

export const MEDIA_MIME_TYPES: Record<string, MediaExtension> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** Ten megabytes, the same ceiling the bucket itself enforces. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** How many photos one listing may carry. A gallery, not an archive. */
export const MAX_LISTING_PHOTOS = 20;

/**
 * `listings/<uuid>/<uuid>.<ext>`, `agents/…` or `agencies/…`.
 *
 * Anchored at both ends, no dots outside the extension, no slashes beyond the
 * two the shape needs. `..` cannot appear because a segment must be a uuid.
 */
const KEY_PATTERN = new RegExp(
  `^(listings|agents|agencies)/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(${MEDIA_EXTENSIONS.join('|')})$`,
);

export const storageKeySchema = z
  .string()
  .max(200)
  .regex(KEY_PATTERN, 'Not a media key this platform issued');

/**
 * Who a file belongs to.
 *
 * `agency` exists for one reason: the onboarding wizard uploads a headshot
 * before the agent exists. The draft lives in the browser, there is no user id
 * and no agent_profile row to key a path on, and the only stable id at that
 * moment is the agency from the session — which is also the right owner, since
 * the agency is the one who uploaded it.
 *
 * The key is carried on the invite draft and written to `agent_profile.
 * photo_key` when `inviteAgent` creates the row. Readers only ever turn a key
 * into a URL, so an `agencies/…` key renders exactly like an `agents/…` one;
 * `keyBelongsTo` is a WRITE check and a later upload from the team drawer
 * simply replaces it with an agent-scoped key.
 */
export type MediaOwner = { kind: 'listing' | 'agent' | 'agency'; id: string };

const FOLDERS = { listing: 'listings', agent: 'agents', agency: 'agencies' } as const;

/** The folder a given owner's files live under. */
function prefix(owner: MediaOwner): string {
  return `${FOLDERS[owner.kind]}/${owner.id}`;
}

/**
 * A fresh key for a new upload.
 *
 * The filename is discarded and replaced with a uuid on purpose. An agency's
 * own filenames are not a naming scheme — they collide, they carry spaces and
 * non-ASCII, and "IMG_0421.jpg" uploaded twice for two different listings is
 * two files that would otherwise want the same name. The extension comes from
 * the MIME type the browser reports, not from the filename, because the
 * extension is what the bucket's allowlist is checked against.
 */
export function newStorageKey(owner: MediaOwner, contentType: string): string {
  const ext = MEDIA_MIME_TYPES[contentType.toLowerCase()];
  if (!ext) throw new Error(`Unsupported image type: ${contentType}`);
  return `${prefix(owner)}/${crypto.randomUUID()}.${ext}`;
}

/**
 * Is this key one this owner is allowed to touch?
 *
 * Called on the way IN — before a row is written, and before a file is deleted
 * — with the owner rebuilt from the session rather than from the request body.
 * It is what stops a valid-looking key for somebody else's listing being
 * attached to yours.
 */
export function keyBelongsTo(key: string, owner: MediaOwner): boolean {
  if (!storageKeySchema.safeParse(key).success) return false;
  return key.startsWith(`${prefix(owner)}/`);
}
