import type { Fetch } from './provider-http';

/**
 * A scripted Google / Zoom for tests and the smoke suite: each request takes
 * the next answer and is recorded. Never touches the network.
 */
export function fakeFetch(answers: { status: number; body?: unknown; etag?: string }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const impl: Fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? String(init.body) : '' });
    const a = answers.shift();
    if (!a) throw new Error('fakeFetch: no answer left');
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: a.etag ? { etag: a.etag } : {},
    });
  };
  return { impl, calls };
}

