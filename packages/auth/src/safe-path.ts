/**
 * A `next=` value that is safe to send a signed-in person to: a path on THIS site, or the fallback.
 *
 * Every sign-in, sign-up, callback and sign-out redirect reads `next` from the address, so it is
 * attacker-chosen. `startsWith('/') && !startsWith('//')` was the rule, copied six times, and it let
 * `/\evil.example` through: a browser reads a backslash in an http(s) URL as a slash, so that is
 * `//evil.example`, another host. Tab, newline and carriage return are stripped before a URL is
 * parsed, so `/\t/evil.example` is the same thing again.
 *
 * So this asks the WHATWG URL parser (the one the browser uses) where the value lands, resolved
 * against a placeholder origin, and keeps it only if it stays there. What comes back is the parser's
 * own path, query and hash, so the string redirected to is exactly the one that was checked.
 */
const BASE = 'http://safe-path.invalid';

export function safeLocalPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value === '') return fallback;
  // Control characters: some are stripped by the parser (so they hide a second slash), the rest
  // have no business in a path and would end up in a Location header.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  if (!value.startsWith('/') || value[1] === '/' || value[1] === '\\') return fallback;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
