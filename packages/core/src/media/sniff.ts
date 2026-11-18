/**
 * What a file really is, from its first bytes (PLATFORM-PLAN 1.21). The type a browser or an email sender
 * declares is a claim; an HTML page uploaded as `image/png` passes a header check. The upload checks read the
 * object's first bytes and refuse a file whose signature does not match its declared type. Text types have no
 * signature: they are refused when they hold markup or binary.
 */
const ascii = (head: Uint8Array, from: number, s: string) => s.split('').every((c, i) => head[from + i] === c.charCodeAt(0));
const starts = (head: Uint8Array, bytes: number[]) => bytes.every((v, i) => head[i] === v);

const SIGNATURES: Record<string, (h: Uint8Array) => boolean> = {
  'image/jpeg': (h) => starts(h, [0xff, 0xd8, 0xff]),
  'image/png': (h) => starts(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP'),
  'image/avif': (h) => ascii(h, 4, 'ftyp') && ['avif', 'avis', 'mif1'].some((brand) => ascii(h, 8, brand)),
  'application/pdf': (h) => ascii(h, 0, '%PDF-'),
  // A .docx is a zip.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (h) => starts(h, [0x50, 0x4b, 0x03, 0x04]),
};
const TEXT = new Set(['text/plain', 'text/markdown', 'text/csv']);
const MARKUP = /<\s*(!doctype|html|script|svg|iframe|object|embed|body|head|meta)\b/i;

export function sniffMatches(contentType: string, head: Uint8Array): boolean {
  if (!head.length) return false;
  const type = contentType.toLowerCase();
  const signature = SIGNATURES[type];
  if (signature) return signature(head);
  if (TEXT.has(type)) return !head.includes(0) && !MARKUP.test(new TextDecoder().decode(head));
  return false;
}

/** How many bytes the checks read. Enough for every signature above and a look at the start of a text file. */
export const SNIFF_BYTES = 512;

/**
 * The first SNIFF_BYTES of a stored object: a Range request, and only that much of the body is read even when
 * Storage ignores the range, so a 25 MB file never comes down for a 512-byte look.
 */
export async function fetchHead(url: string, headers: Record<string, string>): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { ...headers, range: `bytes=0-${SNIFF_BYTES - 1}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok || !res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  while (have < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    have += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(have, SNIFF_BYTES));
  let at = 0;
  for (const c of chunks) {
    const take = c.subarray(0, out.length - at);
    out.set(take, at);
    at += take.length;
    if (at >= out.length) break;
  }
  return out;
}
