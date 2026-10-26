/**
 * A document's pages → searchable chunks that remember their pages (ADR 0053 §5).
 *
 * Pages are joined into one stream, split at about `size` characters (at whitespace where it can)
 * with `overlap` shared between neighbours, and each chunk records the first and last page its
 * words came from — so a search hit can say "page 4" and read_document can open that page.
 */
export type PageChunk = { text: string; pageFrom: number; pageTo: number };

/** A long contract is a few hundred chunks; past this the rest is still read by full-text on the pages. */
export const MAX_CHUNKS_PER_DOCUMENT = 300;

export function chunkPages(pages: readonly string[], size = 1200, overlap = 150, max = MAX_CHUNKS_PER_DOCUMENT): PageChunk[] {
  // One flat stream, with the page each character came from.
  let stream = '';
  const pageAt: number[] = [];
  pages.forEach((raw, i) => {
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (stream) {
      stream += ' ';
      pageAt.push(i + 1);
    }
    stream += clean;
    for (let k = 0; k < clean.length; k += 1) pageAt.push(i + 1);
  });
  if (!stream) return [];

  const out: PageChunk[] = [];
  let start = 0;
  while (start < stream.length && out.length < max) {
    let end = Math.min(stream.length, start + size);
    if (end < stream.length) {
      const space = stream.lastIndexOf(' ', end);
      if (space > start + size / 2) end = space;
    }
    const text = stream.slice(start, end).trim();
    if (text) out.push({ text, pageFrom: pageAt[start]!, pageTo: pageAt[Math.max(start, end - 1)]! });
    if (end >= stream.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** Pages from stored text: form feeds separate them (one page when there are none). */
export function splitPages(text: string | null | undefined): string[] {
  return text ? text.split('\f') : [];
}
