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
