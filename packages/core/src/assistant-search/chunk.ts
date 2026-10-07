/**
 * Split a long text for embedding (ADR 0031): about `size` characters per
 * chunk, `overlap` shared between neighbours, breaking at whitespace where it
 * can, at most `max` chunks (the rest of a very long email is not embedded —
 * full-text still finds it).
 */
export function chunkText(text: string, size = 1200, overlap = 150, max = 8): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < max) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const space = clean.lastIndexOf(' ', end);
      if (space > start + size / 2) end = space;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}
