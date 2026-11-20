/**
 * The browser half of an upload.
 *
 * Runs in the client. It never sees a service role key and never chooses a
 * path: both come from a Server Action that has already asked can(). All this
 * does is PUT bytes to a URL it was handed — verified against the live bucket:
 * the token alone is enough, no Authorization header, and the token is scoped
 * by Supabase to the one key it was signed for.
 */

export type SignedUpload = { uploadUrl: string; token: string; key: string };

/**
 * The file's pixel dimensions, read before it leaves the browser.
 *
 * Stored on the media row so a gallery can reserve the right aspect ratio
 * before the image arrives — the difference between a page that settles and
 * one that jumps. Best effort: a browser without createImageBitmap, or a file
 * it cannot decode, gives up rather than blocking the upload, and the columns
 * are nullable for exactly that reason.
 */
export async function imageDimensions(
  file: File,
): Promise<{ width: number; height: number } | undefined> {
  try {
    if (typeof createImageBitmap !== 'function') return undefined;
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return undefined;
  }
}

/** Long edges for each kind of upload (PLATFORM-PLAN 5.8): sharp on a big screen, far under the 10 MB ceiling. */
export const MAX_EDGE = { listingPhoto: 2560, floorplan: 3000, portrait: 1024 } as const;

/**
 * PLATFORM-PLAN 5.8: a photo is redrawn before it is uploaded: at most `maxEdge` pixels on its long side (never
 * enlarged), upright, and re-encoded, which leaves its EXIF behind (GPS position, camera, time taken). PNG stays
 * PNG, so a floorplan keeps its sharp lines; anything else becomes JPEG on white.
 * shortcut: a file this browser cannot decode (HEIC in Chrome) goes up as it is, metadata included; strip it on
 * the server if such uploads become common.
 */
export async function prepareImage(file: File, maxEdge: number): Promise<File> {
  try {
    if (typeof createImageBitmap !== 'function' || !file.type.startsWith('image/')) return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    if (!blob || blob.type !== type) return file;
    const name = type === 'image/png' ? file.name : `${file.name.replace(/\.[^.]+$/, '')}.jpg`;
    return new File([blob], name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/**
 * PUT the bytes.
 *
 * `Content-Type` is the file's own, because the bucket checks it against its
 * allowlist and refuses anything else with a 415 — which is a real check, not
 * a courtesy: it fires before row-level security is even consulted.
 */
export async function putSignedUpload(signed: SignedUpload, file: File): Promise<void> {
  const res = await fetch(`${signed.uploadUrl}?token=${encodeURIComponent(signed.token)}`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!res.ok) {
    /**
     * The message comes from storage, not from us.
     *
     * "mime type image/gif is not supported" and "The object exceeded the
     * maximum allowed size" are both things the bucket says better than a
     * generic failure would, and both are things the person can act on.
     */
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message || body.error || detail;
    } catch {
      // A non-JSON error body. The status is all there is.
    }
    throw new Error(`Upload failed — ${detail}`);
  }
}
