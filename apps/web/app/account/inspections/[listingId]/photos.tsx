'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { removePhoto } from '../actions';

/**
 * Photos (C6 decision 8). The browser draws each photo onto a canvas at most `longEdge` pixels long and sends that
 * JPEG — which drops the phone's metadata, GPS included; the server strips it again regardless and stores the file
 * privately. Thumbnails come through the owner-checked route, a short signed link each time.
 */
export function Photos({ listingId, photos, max, maxCameraBytes, longEdge, disabled }: { listingId: string; photos: { id: string }[]; max: number; maxCameraBytes: number; longEdge: number; disabled: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function shrink(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('resize'))), 'image/jpeg', 0.85));
  }

  async function upload(files: FileList | null) {
    setError(null);
    const list = [...(files ?? [])].slice(0, Math.max(0, max - photos.length));
    if (!list.length) return;
    setBusy(true);
    try {
      for (const file of list) {
        if (file.size > maxCameraBytes) throw new Error('That photo is larger than 10 MB.');
        const body = new FormData();
        body.set('listingId', listingId);
        body.set('photo', await shrink(file), 'photo.jpg');
        const res = await fetch('/api/inspections/photos', { method: 'POST', body });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'The photo could not be saved.');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error && err.message !== 'resize' ? err.message : 'The photo could not be read.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div>
      <div className="grid grid-cols-4 gap-2 max-sm:grid-cols-3">
        {photos.map((p) => (
          <figure key={p.id} className="relative m-0 aspect-square overflow-hidden rounded-lg bg-sunken">
            {/* eslint-disable-next-line @next/next/no-img-element -- a private, short-lived signed link: no image optimiser */}
            <img src={`/api/inspections/photos/${p.id}`} alt="Your inspection photo" className="size-full object-cover" loading="lazy" />
            <button
              type="button"
              disabled={pending}
              onClick={() => start(async () => {
                const r = await removePhoto(p.id);
                if (r.ok) router.refresh();
                else setError(r.error);
              })}
              className="absolute right-1 top-1 rounded-full bg-white/90 px-2 text-xs font-bold text-alert"
              aria-label="Delete this photo"
            >
              ×
            </button>
          </figure>
        ))}
        {!disabled && photos.length < max ? (
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="grid aspect-square place-items-center rounded-lg border border-dashed border-line bg-sunken text-2xl text-ink-faint">
            {busy ? '…' : '+'}
          </button>
        ) : null}
      </div>
      <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => upload(e.target.files)} />
      <p className="mt-2 text-xs text-ink-faint">
        {photos.length} of {max}. Location is removed from photos before they&rsquo;re saved. Photos are never shown to the AI.
      </p>
      {error ? <p className="text-sm text-alert">{error}</p> : null}
    </div>
  );
}
