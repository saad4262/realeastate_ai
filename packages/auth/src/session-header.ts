/**
 * The identity middleware forwards to the app, signed (PLATFORM-PLAN 1.2).
 *
 * Middleware verifies the session and writes `<prefix>-id`, `-email`, `-label`. Pages and actions used to trust
 * those headers because middleware strips any a caller sends — which holds only while middleware runs; a
 * request that skips it (CVE-2025-29927) could name any user. Now middleware also writes `-exp` and `-sig`, an
 * HMAC over all of them, and every reader checks it. The headers never leave the server, so the short expiry
 * only bounds a replay from inside; the signature is what makes them unforgeable.
 *
 * Web Crypto only, so the same code runs in edge middleware and in Node. This is authentication only:
 * every page and action still decides with can() on the member loaded from our database.
 */
import type { SessionIdentity } from './middleware';

export type SignedHeaderPrefix = 'x-console-user' | 'x-web-user';

/** How long a signed identity is believed. Middleware and the page run within one request. */
export const SIGNED_HEADER_TTL_MS = 120_000;
/** Clock difference tolerated between the middleware's machine and the page's. */
const SKEW_MS = 30_000;

/** Every header suffix that carries the identity; middleware strips them all from incoming requests. */
export const SESSION_HEADER_SUFFIXES = ['id', 'email', 'label', 'exp', 'sig'] as const;

/** `SESSION_HEADER_SECRET` if set, else the service-role key (server-only in both apps). None: nothing is believed. */
export function sessionHeaderSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.SESSION_HEADER_SECRET?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, k);
  }
  return k;
}

/** The signed text: versioned and prefixed, so a console identity never verifies as a consumer one. */
const message = (prefix: SignedHeaderPrefix, id: string, email: string, label: string, exp: string) =>
  new TextEncoder().encode(['session-header-v1', prefix, id, email, label, exp].join('\n'));

const b64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The headers to forward for this identity, or null when no secret is configured (the caller forwards none). */
export async function signIdentity(prefix: SignedHeaderPrefix, who: SessionIdentity, now: number, secret: string | null): Promise<Record<string, string> | null> {
  if (!secret) return null;
  const email = who.email ? encodeURIComponent(who.email) : '';
  const label = who.label ? encodeURIComponent(who.label) : '';
  const exp = String(now + SIGNED_HEADER_TTL_MS);
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret), message(prefix, who.id, email, label, exp));
  return {
    [`${prefix}-id`]: who.id,
    ...(email ? { [`${prefix}-email`]: email } : {}),
    ...(label ? { [`${prefix}-label`]: label } : {}),
    [`${prefix}-exp`]: exp,
    [`${prefix}-sig`]: b64url(sig),
  };
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The identity, only if the signature verifies and it has not expired. Anything else is nobody. */
export async function readSignedIdentity(get: (name: string) => string | null, prefix: SignedHeaderPrefix, now: number, secret: string | null): Promise<SessionIdentity | null> {
  const id = get(`${prefix}-id`);
  const exp = get(`${prefix}-exp`);
  const sig = fromB64url(get(`${prefix}-sig`) ?? '');
  if (!secret || !id || !exp || !sig || !/^\d{13}$/.test(exp)) return null;
  const expMs = Number(exp);
  if (now > expMs || expMs > now + SIGNED_HEADER_TTL_MS + SKEW_MS) return null;
  const rawEmail = get(`${prefix}-email`) ?? '';
  const rawLabel = get(`${prefix}-label`) ?? '';
  // verify() compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', await keyFor(secret), sig, message(prefix, id, rawEmail, rawLabel, exp));
  if (!ok) return null;
  const email = rawEmail ? decode(rawEmail) : null;
  const label = rawLabel ? decode(rawLabel) : '';
  if (email === null && rawEmail) return null;
  if (label === null) return null;
  return { id, email, label };
}
