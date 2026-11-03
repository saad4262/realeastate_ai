/**
 * The PRIVATE inspection-photos bucket (ADR 0080, C6 decision 8; the documents bucket's pattern, ADR 0053). SERVER
 * ONLY — every call sends the service role key; nothing here may be imported from a client component and nothing
 * returns the key. No public URL exists: a buyer sees a photo through `signInspectionPhoto`, a link that works for a
 * few minutes, handed out only after the owner check.
 */

export class PhotoStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoStorageError';
  }
}

export function inspectionPhotoBucket(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPABASE_INSPECTION_PHOTOS_BUCKET?.trim() || 'inspection-photos';
}

function root(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!url) throw new PhotoStorageError('Photo storage is not configured');
  return `${url.replace(/\/+$/, '')}/storage/v1`;
}

function headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new PhotoStorageError('Photo storage is not configured');
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/** True when photos can work at all — the page hides the button instead of offering one that fails. */
export function inspectionPhotosConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/** Store bytes the SERVER stripped. Never overwrites: every key is new. */
export async function putInspectionPhoto(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(`${root()}/object/${inspectionPhotoBucket()}/${key}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': contentType, 'x-upsert': 'false' },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new PhotoStorageError(`Storage refused the photo (HTTP ${res.status})`);
}

/** A link that shows the photo for SECONDS (default 300) — long enough for a page of thumbnails, dead soon after. */
export async function signInspectionPhoto(key: string, seconds = 300): Promise<string> {
  const res = await fetch(`${root()}/object/sign/${inspectionPhotoBucket()}/${key}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new PhotoStorageError(`Storage could not sign the photo (HTTP ${res.status})`);
  const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = body.signedURL ?? body.signedUrl;
  if (!path) throw new PhotoStorageError('Storage signed the photo without a link');
  return path.startsWith('http') ? path : `${root()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Remove files. Callers delete the ROWS first: a file with no row is invisible; a row with no file is a broken link. */
export async function deleteInspectionPhotos(keys: readonly string[]): Promise<boolean> {
  if (!keys.length) return true;
  try {
    const res = await fetch(`${root()}/object/${inspectionPhotoBucket()}`, {
      method: 'DELETE',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: keys }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
