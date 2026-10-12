'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type ChangeEvent } from 'react';
import { mediaUrl } from '@repo/core/media/url';
// The key module, not the barrel: the barrel reaches the database client.
import { MAX_LISTING_PHOTOS, MAX_MEDIA_BYTES, MEDIA_MIME_TYPES } from '@repo/core/media/key';
import type { ListingPhoto } from '@repo/core/media';
import {
  attachAgentPhotoAction,
  attachListingPhotoAction,
  clearAgentPhotoAction,
  removeListingPhotoAction,
  setListingCoverAction,
  signAgentPhotoUploadAction,
  signListingPhotoUploadAction,
} from '../lib/media-actions';
import { imageDimensions, putSignedUpload } from '../lib/upload-file';
import styles from './photo-uploader.module.css';

/**
 * Photo upload, for listings and for agents.
 *
 * Three steps per file, and the order is the whole correctness story:
 *
 *   1. ask the server for permission and a signed URL   (Server Action)
 *   2. PUT the bytes straight to Supabase Storage        (this component)
 *   3. ask the server to record the row                  (Server Action)
 *
 * Step 2 skips this app entirely, which is why a 5 MB photo does not have to
 * fit in a Server Action body. Step 3 cannot trust step 2 — the server HEADs
 * the object before it writes anything — so a caller that fakes step 2 gets a
 * refusal rather than a row pointing at nothing.
 *
 * `router.refresh()` rather than local state after each change. The photos are
 * server data; keeping a second copy here is the mirror-of-the-truth problem
 * the search bar was rewritten to remove, and it would drift the first time an
 * upload failed halfway.
 *
 * These use a plain <img>, not next/image. The console is not on next/image
 * anywhere (see team-directory.tsx), the tiles are 8rem thumbnails on an
 * authenticated page nobody's Core Web Vitals are measured on, and the
 * optimiser would need its own remotePatterns in a second next.config.
 */

/** Matched to the bucket's own allowlist, so the picker offers what it takes. */
const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('');
}

/* ------------------------------------------------------- listing photos -- */

/**
 * One file, all three steps, against a listing that already exists.
 *
 * Shared by the edit panel and the create form so the order — sign, PUT,
 * attach — lives in one place. Returns the refusal rather than throwing, so a
 * caller looping over a batch can stop at the first one and say why.
 */
export async function uploadListingPhoto(
  listingId: string,
  file: File,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const signed = await signListingPhotoUploadAction(listingId, {
      type: file.type,
      size: file.size,
    });
    if (!signed.ok) return signed;

    const dimensions = await imageDimensions(file);
    await putSignedUpload(signed, file);

    const attached = await attachListingPhotoAction(listingId, signed.key, dimensions);
    if (!attached.ok) return attached;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'That image could not be uploaded.' };
  }
}

export function ListingPhotos({
  listingId,
  photos,
  max,
}: {
  listingId: string;
  photos: ListingPhoto[];
  max: number;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);

  const full = photos.length >= max;

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    // The input is cleared immediately so picking the same file twice in a row
    // still fires a change event.
    event.target.value = '';
    if (!files.length) return;

    setError(null);
    const room = max - photos.length;
    const batch = files.slice(0, room);
    if (files.length > room) {
      setError(`Only ${room} more ${room === 1 ? 'photo' : 'photos'} will fit on this listing.`);
    }

    start(async () => {
      for (const file of batch) {
        setUploading((n) => n + 1);
        const result = await uploadListingPhoto(listingId, file);
        setUploading((n) => n - 1);
        if (!result.ok) {
          setError(result.error);
          break;
        }
      }
      router.refresh();
    });
  }

  function onRemove(mediaId: string) {
    setError(null);
    start(async () => {
      const result = await removeListingPhotoAction(listingId, mediaId);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  function onCover(mediaId: string) {
    setError(null);
    start(async () => {
      const result = await setListingCoverAction(listingId, mediaId);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <span className={styles.label}>Photos</span>
          <p className={styles.hint}>
            {photos.length} of {max}. The first one is the cover — it is what shows on
            search results and in the chat.
          </p>
        </div>

        <label className={styles.pick} aria-disabled={busy || full}>
          <input
            type="file"
            className={styles.file}
            accept={ACCEPT}
            multiple
            disabled={busy || full}
            onChange={onPick}
          />
          {uploading > 0 ? `Uploading ${uploading}…` : full ? 'Full' : 'Add photos'}
        </label>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      {photos.length === 0 ? (
        <p className={styles.empty}>
          No photos yet. A listing with no photos shows a plain colour on the
          public site.
        </p>
      ) : (
        <ul className={styles.grid}>
          {photos.map((photo) => {
            const src = mediaUrl(photo.storageKey);
            return (
              <li
                key={photo.id}
                className={photo.isMain ? `${styles.tile} ${styles.coverTile}` : styles.tile}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- see the
                    note at the top of this file: console thumbnails are not on
                    next/image. */}
                {src ? <img src={src} alt="" width={160} height={120} /> : null}
                {photo.isMain ? <span className={styles.badge}>Cover</span> : null}
                <div className={styles.tileActions}>
                  {!photo.isMain ? (
                    <button
                      type="button"
                      className={styles.tileButton}
                      disabled={busy}
                      onClick={() => onCover(photo.id)}
                    >
                      Cover
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.tileButton} ${styles.danger}`}
                    disabled={busy}
                    onClick={() => onRemove(photo.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------- photos for a new listing -- */

/** A file picked on the create form, held in the browser until the listing exists. */
export type PendingPhoto = { id: string; file: File; previewUrl: string };

/**
 * Photos chosen before there is a listing to attach them to.
 *
 * Nothing is uploaded here. A storage key is built from the listing id, and
 * the sign action asks can() about that listing — neither exists until the
 * draft is saved. So the files wait in the browser and the form runs the same
 * sign → PUT → attach steps (`uploadListingPhoto`) once the create returns its
 * id. No second upload path, and no orphaned objects in the bucket for a form
 * that was abandoned.
 *
 * Order is upload order, and the first upload becomes the cover
 * (addListingPhoto marks the first row main) — so "Cover" here just moves a
 * photo to the front.
 */
export function PendingListingPhotos({
  photos,
  onChange,
  disabled,
}: {
  photos: PendingPhoto[];
  onChange: (next: PendingPhoto[]) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const full = photos.length >= MAX_LISTING_PHOTOS;

  // The previews are object URLs; release them when the form goes away.
  const latest = useRef(photos);
  useEffect(() => {
    latest.current = photos;
  });
  useEffect(() => () => latest.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)), []);

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (!files.length) return;

    // The same checks the sign action makes, here so a bad file is refused
    // now rather than after the listing has already been saved.
    const refused: string[] = [];
    const ok = files.filter((file) => {
      if (!MEDIA_MIME_TYPES[file.type.toLowerCase()]) {
        refused.push(`${file.name}: images only — JPEG, PNG, WebP or AVIF`);
        return false;
      }
      if (file.size <= 0 || file.size > MAX_MEDIA_BYTES) {
        refused.push(`${file.name}: images must be 10 MB or smaller`);
        return false;
      }
      return true;
    });

    const room = MAX_LISTING_PHOTOS - photos.length;
    if (ok.length > room) {
      refused.push(`Only ${room} more ${room === 1 ? 'photo' : 'photos'} will fit on this listing.`);
    }
    setError(refused.length ? refused.join(' ') : null);

    const added = ok.slice(0, room).map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    if (added.length) onChange([...photos, ...added]);
  }

  function onRemove(id: string) {
    const gone = photos.find((p) => p.id === id);
    if (gone) URL.revokeObjectURL(gone.previewUrl);
    onChange(photos.filter((p) => p.id !== id));
  }

  function onCover(id: string) {
    const pick = photos.find((p) => p.id === id);
    if (pick) onChange([pick, ...photos.filter((p) => p.id !== id)]);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <span className={styles.label}>Selected photos</span>
          <p className={styles.hint}>
            {photos.length} of {MAX_LISTING_PHOTOS}. They upload when you save. The first one is
            the cover — it is what shows on search results and in the chat.
          </p>
        </div>

        <label className={styles.pick} aria-disabled={disabled || full}>
          <input
            type="file"
            className={styles.file}
            accept={ACCEPT}
            multiple
            disabled={disabled || full}
            onChange={onPick}
          />
          {full ? 'Full' : 'Add photos'}
        </label>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      {photos.length === 0 ? (
        <p className={styles.empty}>
          No photos yet. You can also add them later from Edit.
        </p>
      ) : (
        <ul className={styles.grid}>
          {photos.map((photo, i) => (
            <li
              key={photo.id}
              className={i === 0 ? `${styles.tile} ${styles.coverTile}` : styles.tile}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local
                  blob: preview; next/image has nothing to optimise here. */}
              <img src={photo.previewUrl} alt="" width={160} height={120} />
              {i === 0 ? <span className={styles.badge}>Cover</span> : null}
              <div className={styles.tileActions}>
                {i !== 0 ? (
                  <button
                    type="button"
                    className={styles.tileButton}
                    disabled={disabled}
                    onClick={() => onCover(photo.id)}
                  >
                    Cover
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`${styles.tileButton} ${styles.danger}`}
                  disabled={disabled}
                  onClick={() => onRemove(photo.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------- agent photo -- */

export function AgentPhoto({
  agentUserId,
  name,
  role,
  license,
  photoKey,
  photoUrl,
}: {
  agentUserId: string;
  name: string;
  /** Operational / membership role shown under the name. */
  role?: string;
  /** e.g. "Lic #4123" — shown under the role. */
  license?: string;
  /** An uploaded portrait's key. Preferred over photoUrl when both exist. */
  photoKey: string | null;
  /** A link an agency pasted at some point. Shown only as a fallback. */
  photoUrl: string | null;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const src = mediaUrl(photoKey) ?? photoUrl;

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);
    start(async () => {
      try {
        const signed = await signAgentPhotoUploadAction(agentUserId, {
          type: file.type,
          size: file.size,
        });
        if (!signed.ok) {
          setError(signed.error);
          return;
        }

        await putSignedUpload(signed, file);

        const attached = await attachAgentPhotoAction(agentUserId, signed.key);
        if (!attached.ok) setError(attached.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That photo could not be uploaded.');
      } finally {
        router.refresh();
      }
    });
  }

  function onClear() {
    setError(null);
    start(async () => {
      const result = await clearAgentPhotoAction(agentUserId);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  return (
    <div className={styles.avatarRow}>
      <span className={styles.avatar} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- see above. */}
        {src ? <img src={src} alt="" width={56} height={56} /> : initials(name)}
      </span>

      <div className={styles.avatarMeta}>
        <div className={styles.avatarName}>{name}</div>
        {role ? <div className={styles.avatarRole}>{role}</div> : null}
        {license ? <div className={styles.avatarLic}>{license}</div> : null}

        <div className={styles.avatarActions}>
          <label className={styles.pick} aria-disabled={busy}>
            <input
              type="file"
              className={styles.file}
              accept={ACCEPT}
              disabled={busy}
              onChange={onPick}
            />
            {busy ? 'Saving…' : 'Edit'}
          </label>

          {/* Only an uploaded photo can be cleared here. photo_url is a link
              somebody typed into the profile and belongs to whatever edits
              that, not to an upload control. */}
          {photoKey ? (
            <button type="button" className={styles.link} disabled={busy} onClick={onClear}>
              Remove
            </button>
          ) : null}
        </div>
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>
    </div>
  );
}
