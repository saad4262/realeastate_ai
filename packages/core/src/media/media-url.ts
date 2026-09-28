/**
 * Key → URL. The one function that knows where images are hosted.
 *
 * Everything else in this codebase — every query, every row, every component —
 * deals in keys. This is the only place that turns one into something a
 * browser can fetch, which is what makes "move media to R2" a change to this
 * file rather than a migration across two tables and a dozen components.
 *
 * Deliberately NOT async and NOT a database read. It is string concatenation
 * over a public bucket, so it is safe to call once per card on a page of 24
 * results. A signed-URL scheme would have made this a network call per image
 * and would have put an expiry inside an ISR-cached page — a URL that works
 * when the page is rendered and 403s when it is served an hour later is worse
 * than no image at all.
 */

/** Reads the same variable on the server and in the browser. */
function bucket(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_MEDIA_BUCKET || 'media';
}

function base(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * The public URL for a stored key, or null when media is not configured.
 *
 * Null rather than a broken URL: every caller already has a no-photo branch —
 * the gradient placeholder the gallery and the cards were built around — and
 * falling back to it is correct on a machine with no Supabase URL set. An
 * `undefined/storage/v1/...` string would render as a broken image on every
 * card instead.
 */
export function mediaUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  const root = base();
  if (!root) return null;
  return `${root}/storage/v1/object/public/${bucket()}/${key}`;
}

/**
 * The hostname images are served from, for `next.config.ts`.
 *
 * next/image refuses any remote host that is not allow-listed, so the config
 * and this resolver have to agree about where files live. Deriving the pattern
 * from the same env var is what stops them drifting — the alternative is a
 * hostname hard-coded in next.config that is right until the project moves.
 */
export function mediaHostname(): string | null {
  const root = base();
  if (!root) return null;
  try {
    return new URL(root).hostname;
  } catch {
    return null;
  }
}

/**
 * Where a signed upload is PUT, and where the object is addressed on the
 * management API.
 *
 * Server-side only — both of these are used with the service role key, which
 * must never reach a browser.
 */
export function storageObjectUrl(key: string): string | null {
  const root = base();
  return root ? `${root}/storage/v1/object/${bucket()}/${key}` : null;
}

export function storageSignUploadUrl(key: string): string | null {
  const root = base();
  return root ? `${root}/storage/v1/object/upload/sign/${bucket()}/${key}` : null;
}
