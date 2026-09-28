import {
  MAX_MEDIA_BYTES,
  MEDIA_MIME_TYPES,
} from './storage-key';
import { storageObjectUrl, storageSignUploadUrl } from './media-url';

/**
 * The Supabase Storage calls, and the service role key that makes them work.
 *
 * SERVER ONLY. Every function here sends `SUPABASE_SERVICE_ROLE_KEY`, which
 * bypasses row-level security entirely — it is the credential that can write
 * anywhere in the project. Nothing in this file may be imported from a client
 * component, and nothing here returns the key to a caller.
 *
 * ## Why a signed upload URL and not a route that takes the bytes
 *
 * The obvious shape is: browser posts the file to a Next route, the route
 * checks can() and forwards it to storage. It is also the wrong one here.
 *
 *  - A Server Action body defaults to 1 MB. Property photos are 2–5 MB, so
 *    this would need the limit raised on every action in the app to let one of
 *    them carry a file.
 *  - Every byte would travel twice: browser → Next → Supabase. On a serverless
 *    host that is paid for twice and counted against the function's memory.
 *  - It puts a multi-megabyte upload inside a request that also holds a
 *    database transaction's worth of latency budget.
 *
 * So the server authorises and hands back a short-lived signed URL, the
 * browser PUTs straight to storage, and a second call records the row. The
 * bucket has no RLS insert policy at all, so that signed URL is the ONLY way
 * anything reaches it — verified: an anon-key upload of a valid PNG is refused
 * with "new row violates row-level security policy".
 */

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new MediaError('Image uploads are not configured');
  return key;
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

function headers(): Record<string, string> {
  const key = serviceKey();
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/**
 * A one-shot upload URL for exactly this key.
 *
 * The token Supabase returns is scoped to the path it was signed for, so a
 * browser holding it cannot write anywhere else in the bucket — which matters,
 * because the browser is the thing being distrusted here. It expires in
 * minutes; a caller that sits on one has to ask again.
 */
export async function signUpload(
  key: string,
): Promise<{ uploadUrl: string; token: string }> {
  const endpoint = storageSignUploadUrl(key);
  if (!endpoint) throw new MediaError('Image uploads are not configured');

  const res = await fetch(endpoint, { method: 'POST', headers: headers() });
  if (!res.ok) {
    throw new MediaError(`Storage refused to sign the upload (HTTP ${res.status})`);
  }

  const body = (await res.json()) as { url?: string; token?: string };
  // Supabase returns a path, not an absolute URL, and which of the two has
  // changed between versions. Normalising here keeps that detail out of the
  // browser, which should only ever be handed something it can PUT to.
  const token = body.token ?? new URL(body.url ?? '', 'http://x').searchParams.get('token');
  if (!token) throw new MediaError('Storage signed the upload without a token');

  return { uploadUrl: endpoint, token };
}

/**
 * What is actually at this key — asked of storage, not of the caller.
 *
 * This is the check that makes the signed-upload shape safe to record. The
 * browser tells us "I uploaded to this key"; that claim is worth nothing on
 * its own, because a caller can simply not upload and still call the attach
 * action. So before a row is written the object is HEADed: it exists, it is an
 * image type the bucket allows, and it is within the size limit.
 *
 * Returns null when there is nothing there, which the caller turns into a
 * refusal rather than an empty row pointing at a 404.
 */
export async function describeObject(
  key: string,
): Promise<{ contentType: string; bytes: number } | null> {
  const url = storageObjectUrl(key);
  if (!url) throw new MediaError('Image uploads are not configured');

  const res = await fetch(url, { method: 'HEAD', headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new MediaError(`Storage could not be read (HTTP ${res.status})`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const bytes = Number(res.headers.get('content-length') ?? '0');

  if (!MEDIA_MIME_TYPES[contentType.toLowerCase()]) {
    throw new MediaError(`That file is a ${contentType || 'unknown type'}, not an image`);
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new MediaError('That upload arrived empty');
  }
  if (bytes > MAX_MEDIA_BYTES) {
    throw new MediaError('That image is larger than 10 MB');
  }

  return { contentType, bytes };
}

/**
 * Remove a file.
 *
 * Failure is swallowed by callers on purpose: the row is the record, and an
 * orphaned object in a bucket is a cleanup job, while a row pointing at a file
 * that was deleted is a broken image on a live ad. Deleting the row is the
 * part that must not fail.
 */
export async function deleteObject(key: string): Promise<boolean> {
  const url = storageObjectUrl(key);
  if (!url) return false;
  const res = await fetch(url, { method: 'DELETE', headers: headers() });
  return res.ok;
}
