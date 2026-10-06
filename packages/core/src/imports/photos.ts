import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { addListingPhoto } from '../media/listing-media';
import { newStorageKey } from '../media/storage-key';
import { signUpload } from '../media/storage-client';
import type { Db } from '@repo/db';

/**
 * Photos from links in an import (ADR 0029 §8). The server fetches a URL the
 * FILE named — so it must never be turned against our own network: only
 * http(s), every hop's address checked against private, loopback, link-local
 * and carrier ranges (re-checked after each redirect, at most 3), images only,
 * at most 10 MB. Then stored exactly like an upload and attached through
 * `addListingPhoto`, which checks the stored object again.
 *
 * The check is made on the CONNECTION, not only beforehand: `pinnedFetch`
 * hands the socket a lookup that refuses private addresses, so a name that
 * resolves publicly for the check and privately a moment later (DNS
 * rebinding) still cannot reach our network.
 */

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

/** Is this IP one the server must never fetch from? */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

/** Refuse a URL whose scheme is not web, or whose host resolves to anything private. */
export async function assertPublicUrl(raw: string, resolve: Resolve = defaultResolve): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PhotoError('Not a web link');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PhotoError('Only http(s) links are fetched');
  if (url.username || url.password) throw new PhotoError('Links with a username or password are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addresses.length) throw new PhotoError('That address does not resolve');
  if (addresses.some(isPrivateAddress)) throw new PhotoError('That address is not on the public internet');
  return url;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

export type PhotoDeps = {
  /** Download an image (guarded). Test seam. */
  fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Put the bytes in storage for this listing; returns the storage key. Test seam. */
  store?: (listingId: string, bytes: Uint8Array, contentType: string) => Promise<string>;
  /** Attach the stored key to the listing. Test seam. */
  attach?: (db: Db, listingId: string, key: string) => Promise<void>;
};

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Resolve = (host: string) => Promise<string[]>;

/** dns.lookup for a socket, except that a private address fails the connection. */
export function guardedLookup(resolve: Resolve = defaultResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length || addresses.some(isPrivateAddress)) {
          callback(new PhotoError('That address is not on the public internet') as NodeJS.ErrnoException, '', 4);
          return;
        }
        const all = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) callback(null, all);
        else callback(null, all[0]!.address, all[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 4),
    );
  };
}

/**
 * GET one URL over a socket whose address went through `guardedLookup`. No
 * redirects followed (the caller re-checks each hop); the body stops at 10 MB.
 */
export function pinnedFetch(url: URL, init: { signal?: AbortSignal } = {}, resolve?: Resolve): Promise<Response> {
  return new Promise((done, fail) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { method: 'GET', lookup: guardedLookup(resolve), signal: init.signal, headers: { accept: 'image/jpeg,image/png,image/webp' } },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        if (status >= 300 && status < 400) {
          res.resume();
          done(new Response(null, { status, headers }));
          return;
        }
        if (Number(res.headers['content-length'] ?? 0) > MAX_PHOTO_BYTES) {
          req.destroy(new PhotoError('The image is larger than 10 MB'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_PHOTO_BYTES) req.destroy(new PhotoError('The image is larger than 10 MB'));
          else chunks.push(c);
        });
        res.on('end', () => done(new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers })));
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    req.end();
  });
}

type Fetcher = (url: URL, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export async function fetchPublicImage(raw: string, fetchImpl: Fetcher = pinnedFetch, resolve?: Resolve): Promise<{ bytes: Uint8Array; contentType: string }> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertPublicUrl(current, resolve);
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    if (!res.ok) throw new PhotoError(`The link answered HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) throw new PhotoError(`Not a JPEG, PNG or WebP image (${contentType || 'unknown type'})`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_PHOTO_BYTES) throw new PhotoError('The image is larger than 10 MB');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_PHOTO_BYTES) throw new PhotoError('The image is larger than 10 MB');
    if (!bytes.byteLength) throw new PhotoError('The image is empty');
    return { bytes, contentType };
  }
  throw new PhotoError('Too many redirects');
}

async function storeInBucket(listingId: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const key = newStorageKey({ kind: 'listing', id: listingId }, contentType);
  const signed = await signUpload(key);
  const res = await fetch(`${signed.uploadUrl}?token=${encodeURIComponent(signed.token)}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Blob([bytes as BlobPart], { type: contentType }),
  });
  if (!res.ok) throw new PhotoError(`Storage refused the image (HTTP ${res.status})`);
  return key;
}

/** One photo link → a stored, attached photo. Throws PhotoError with a plain reason. */
export async function importPhoto(db: Db, listingId: string, url: string, deps: PhotoDeps = {}): Promise<void> {
  const image = await (deps.fetchImage ?? ((u: string) => fetchPublicImage(u)))(url);
  const key = await (deps.store ?? storeInBucket)(listingId, image.bytes, image.contentType);
  await (deps.attach ?? (async (d: Db, l: string, k: string) => void (await addListingPhoto(d, l, k))))(db, listingId, key);
}
