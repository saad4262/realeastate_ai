'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent, type FormEvent } from 'react';
import { addListingLinkAction, attachListingFloorplanAction, removeListingExtraAction, signListingPhotoUploadAction } from '../lib/media-actions';
import { imageDimensions, putSignedUpload } from '../lib/upload-file';
import styles from './listing-extras.module.css';

/**
 * Floorplans, video and 3D tour on a listing (ADR 0080, C9 decision 2): a floorplan uploads as a photo does; a video or
 * tour is a YouTube, Vimeo or Matterport link, nothing else. Shown on the public listing as the agency added them; the
 * floorplan's room names are read later by AI (names only).
 */
export function ListingExtras({ listingId, items }: { listingId: string; items: { id: string; kind: string; label: string; url: string | null }[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    start(async () => {
      try {
        const signed = await signListingPhotoUploadAction(listingId, { type: file.type, size: file.size });
        if (!signed.ok) return setError(signed.error);
        const dimensions = await imageDimensions(file);
        await putSignedUpload(signed, file);
        const done = await attachListingFloorplanAction(listingId, signed.key, dimensions);
        if (!done.ok) setError(done.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That floorplan could not be uploaded.');
      }
      router.refresh();
    });
  }

  function onLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    start(async () => {
      const r = await addListingLinkAction(listingId, link);
      if (r.ok) setLink('');
      else setError(r.error);
      router.refresh();
    });
  }

  function onRemove(id: string) {
    setError(null);
    start(async () => {
      const r = await removeListingExtraAction(listingId, id);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  }

  return (
    <section className={styles.panel}>
      <h2 className={styles.title}>Floorplans, video and 3D tour</h2>
      <p className={styles.lede}>Up to 4 floorplans (images), 3 videos (YouTube or Vimeo) and 2 tours (Matterport). The public listing shows them; videos and tours load only when a buyer presses play.</p>
      {items.length ? (
        <ul className={styles.list}>
          {items.map((i) => (
            <li key={i.id} className={styles.item}>
              <span>
                {i.label}
                {i.url ? (
                  <a href={i.url} target="_blank" rel="noopener noreferrer" className={styles.open}>
                    open
                  </a>
                ) : null}
              </span>
              <button type="button" disabled={busy} onClick={() => onRemove(i.id)} className={styles.remove}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.row}>
        <label className={styles.upload}>
          Add a floorplan
          <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={onPick} disabled={busy} className={styles.hidden} />
        </label>
        <form onSubmit={onLink} className={styles.form}>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtu.be/… or https://my.matterport.com/show/?m=…" className={styles.input} />
          <button type="submit" disabled={busy || !link.trim()} className={styles.add}>
            Add link
          </button>
        </form>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}
