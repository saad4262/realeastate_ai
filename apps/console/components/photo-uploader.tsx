'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent } from 'react';
import { mediaUrl } from '@repo/core/media/url';
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
        try {
          const signed = await signListingPhotoUploadAction(listingId, {
            type: file.type,
            size: file.size,
          });
          if (!signed.ok) {
            setError(signed.error);
            break;
          }

          const dimensions = await imageDimensions(file);
          await putSignedUpload(signed, file);

          const attached = await attachListingPhotoAction(listingId, signed.key, dimensions);
          if (!attached.ok) {
            setError(attached.error);
            break;
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'That image could not be uploaded.');
          break;
        } finally {
          setUploading((n) => n - 1);
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
