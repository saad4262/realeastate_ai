/**
 * PLATFORM-PLAN 1.16: one error shape for every API route, `{ error: { code, message } }` (the shape Auth's 503
 * already used). `message` is written for the person; `code` is for code. No imports: browsers read it too.
 */
export type ApiErrorCode = 'bad_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'server_error' | 'upstream' | 'unavailable';

const BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  500: 'server_error',
  502: 'upstream',
  503: 'unavailable',
};

export function apiError(status: number, message: string, init: { headers?: HeadersInit; code?: ApiErrorCode } = {}): Response {
  const code = init.code ?? BY_STATUS[status] ?? (status >= 500 ? 'server_error' : 'bad_request');
  return Response.json({ error: { code, message } }, { status, headers: init.headers });
}

/** The person-facing message from an API error body. Also reads the old `{ error: string }`, which a page loaded before a deploy can still get. */
export function apiErrorMessage(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof e === 'string' && e) return e;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m ? m : fallback;
}
