/**
 * Talking to Google and Zoom (Phase 3b). Every call goes through `call()`:
 * a timeout, a JSON body, and failures turned into a `ProviderError` whose
 * message never carries a token, a code or a response body — only the HTTP
 * status and, at most, the provider's short error word.
 *
 * `fetch` is injected everywhere, so unit tests run against fakes and never
 * reach the network (`@repo/config/test-offline` would refuse anyway).
 */

export type Fetch = typeof fetch;

export type ProviderErrorKind =
  /** The refresh token is dead (revoked, expired, or the app's access was removed). Reconnect. */
  | 'revoked'
  /** The access token was refused — try one refresh. */
  | 'unauthorized'
  /** The thing is not there (or no longer). */
  | 'not_found'
  /** Already exists (Google: an event id we chose was used). */
  | 'conflict'
  | 'rate_limited'
  /** Anything else: 5xx, a timeout, the network. Worth a retry later. */
  | 'failed';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  constructor(kind: ProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export const PROVIDER_TIMEOUT_MS = 10_000;

export type CallResult = { status: number; json: Record<string, unknown> | null; etag: string | null };

/** A provider's own short error word, if it gave one — never the whole body. */
function errorWord(json: Record<string, unknown> | null): string | null {
  if (!json) return null;
  const e = json.error;
  if (typeof e === 'string') return e.slice(0, 40);
  if (e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'string') {
    return String((e as { status: string }).status).slice(0, 40);
  }
  return null;
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'failed';
}

/**
 * One request. 2xx and 304 come back as a result; anything else throws a
 * ProviderError named after `what` ("Google Calendar", "Zoom sign-in").
 */
export async function call(
  fetchImpl: Fetch,
  what: string,
  url: string,
  init: RequestInit,
  okStatuses: readonly number[] = [],
): Promise<CallResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), cache: 'no-store' });
  } catch {
    throw new ProviderError('failed', `${what} could not be reached`);
  }
  const text = res.status === 204 || res.status === 304 ? '' : await res.text().catch(() => '');
  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
  }
  const result = { status: res.status, json, etag: res.headers.get('etag') };
  if ((res.status >= 200 && res.status < 300) || res.status === 304 || okStatuses.includes(res.status)) return result;
  const word = errorWord(json);
  throw new ProviderError(kindForStatus(res.status), `${what} answered ${res.status}${word ? ` (${word})` : ''}`, res.status);
}

export function form(body: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined) p.set(k, v);
  return p;
}

export function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export function expiresAtFrom(json: Record<string, unknown>, now = Date.now()): Date | null {
  const s = Number(json.expires_in);
  return Number.isFinite(s) && s > 0 ? new Date(now + s * 1000) : null;
}

/** "a b c" or ["a","b"] → ["a","b","c"]. */
export function scopeList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string').flatMap((s) => s.split(/[\s,]+/)).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}
