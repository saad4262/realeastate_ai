import { DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES } from './document-schema';

/**
 * The PRIVATE documents bucket (ADR 0053 §1). SERVER ONLY — every call sends the
 * service role key, which bypasses row-level security; nothing here may be imported
 * from a client component and nothing returns the key.
 *
 * Unlike listing photos (a public bucket, media/media-url.ts), nothing in this bucket
 * has a public URL: a person reads a file through `signDocumentDownload`, a URL that
 * works for a minute, handed out only after the row's visibility rule said yes.
 */

export class DocumentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentStorageError';
  }
}

function bucket(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPABASE_DOCUMENTS_BUCKET?.trim() || 'documents';
}

function root(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!url) throw new DocumentStorageError('Document storage is not configured');
  return `${url.replace(/\/+$/, '')}/storage/v1`;
}

function headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new DocumentStorageError('Document storage is not configured');
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/** True when uploads can work at all — the page says so instead of offering a button that fails. */
export function documentStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/** A one-shot upload URL for exactly this key (scoped by Supabase to the path it was signed for). */
export async function signDocumentUpload(key: string): Promise<{ uploadUrl: string; token: string }> {
  const endpoint = `${root()}/object/upload/sign/${bucket()}/${key}`;
  const res = await fetch(endpoint, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new DocumentStorageError(`Storage refused to sign the upload (HTTP ${res.status})`);
  const body = (await res.json()) as { url?: string; token?: string };
  const token = body.token ?? new URL(body.url ?? '', 'http://x').searchParams.get('token');
  if (!token) throw new DocumentStorageError('Storage signed the upload without a token');
  return { uploadUrl: endpoint, token };
}

/**
 * What is actually at this key — asked of storage, not of the browser that says it uploaded
 * there. Null when nothing is; a refusal when it is not a type or size we keep.
 */
export async function describeDocumentObject(key: string): Promise<{ contentType: string; bytes: number } | null> {
  const res = await fetch(`${root()}/object/${bucket()}/${key}`, { method: 'HEAD', headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new DocumentStorageError(`Storage could not be read (HTTP ${res.status})`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const bytes = Number(res.headers.get('content-length') ?? '0');
  if (!DOCUMENT_MIME_TYPES[contentType]) throw new DocumentStorageError(`That file is a ${contentType || 'type we do not keep'}`);
  if (!Number.isFinite(bytes) || bytes <= 0) throw new DocumentStorageError('That upload arrived empty');
  if (bytes > MAX_DOCUMENT_BYTES) throw new DocumentStorageError('Documents must be 25 MB or smaller');
  return { contentType, bytes };
}

/** The bytes, for the extraction tick. */
export async function downloadDocumentObject(key: string): Promise<Uint8Array> {
  const res = await fetch(`${root()}/object/${bucket()}/${key}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new DocumentStorageError(`Storage could not return the file (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Write bytes the SERVER fetched (an email attachment). Never overwrites: every key is new. */
export async function putDocumentObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(`${root()}/object/${bucket()}/${key}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': contentType, 'x-upsert': 'false' },
    // An ArrayBuffer of exactly these bytes (a view's buffer may be larger, and fetch's types want one).
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new DocumentStorageError(`Storage refused the file (HTTP ${res.status})`);
}

/**
 * A link that opens the file for SECONDS (default 60) and names it `filename` on download.
 * Short on purpose: it is handed to one person who was just allowed to see the row, and a
 * forwarded link should be dead by the time anyone else clicks it.
 */
export async function signDocumentDownload(key: string, filename: string, seconds = 60): Promise<string> {
  const res = await fetch(`${root()}/object/sign/${bucket()}/${key}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new DocumentStorageError(`Storage could not sign the download (HTTP ${res.status})`);
  const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = body.signedURL ?? body.signedUrl;
  if (!path) throw new DocumentStorageError('Storage signed the download without a link');
  const url = new URL(path.startsWith('http') ? path : `${root()}${path.startsWith('/') ? '' : '/'}${path}`);
  url.searchParams.set('download', filename);
  return url.toString();
}

/** Remove a file. Callers delete the ROW first: a file with no row is invisible; a row with no file is a broken link. */
export async function deleteDocumentObject(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${root()}/object/${bucket()}/${key}`, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}
