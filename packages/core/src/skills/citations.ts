/**
 * The rule that makes a skill's AI text trustworthy (docs/adr/0021 §5):
 *  - every sentence cites at least one record it was given, as `[A1]`;
 *  - every citation names a record that exists;
 *  - any number in a sentence appears VERBATIM in a record that sentence cites
 *    — quoted from the record, never computed (non-negotiable #4);
 *  - the text informs: no questions, no talk about its own input.
 * Anything else is rejected, and the caller uses a template instead.
 *
 * Pure, so it is tested without a model — and it is the layer to break to
 * prove the check works.
 */

export type CitableRecord = { ref: string; text: string };

export const CITATION = /\[([A-Z]\d{1,3})\]/g;

/** The numbers a person would read as figures: digit runs, with , . : between them. */
function numbersIn(text: string): string[] {
  return text.match(/\d[\d,.:]*/g)?.map((n) => n.replace(/[.,:]+$/, '')) ?? [];
}

export type CitationVerdict = { ok: true; cited: string[] } | { ok: false; reason: string };

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(CITATION, '').trim().length > 0);
}

export function checkCitedText(text: string, records: readonly CitableRecord[], opts: { maxSentences?: number } = {}): CitationVerdict {
  const byRef = new Map(records.map((r) => [r.ref, r.text]));
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (text.includes('?')) return { ok: false, reason: 'asks a question' };
  const meta = /\b(?:as an ai|the records you|you've shared|you have shared|provided data|i cannot|i can't|unable to|sorry)\b/i.exec(text);
  if (meta) return { ok: false, reason: `talks about its input (${meta[0]})` };
  const parts = sentences(text);
  if (parts.length > (opts.maxSentences ?? 6)) return { ok: false, reason: `too long (${parts.length} sentences)` };

  const cited = new Set<string>();
  for (const s of parts) {
    const refs = [...s.matchAll(CITATION)].map((m) => m[1]!);
    if (!refs.length) return { ok: false, reason: `a sentence cites no record: "${s.slice(0, 60)}"` };
    for (const r of refs) {
      if (!byRef.has(r)) return { ok: false, reason: `cites a record that does not exist: [${r}]` };
      cited.add(r);
    }
    const sourceText = refs.map((r) => byRef.get(r)!).join(' ');
    for (const n of numbersIn(s.replace(CITATION, ' '))) {
      if (!sourceText.includes(n)) return { ok: false, reason: `a number not in its cited record (${n})` };
    }
  }
  return { ok: true, cited: [...cited] };
}

export type RankedLine = { ref: string; reason: string };

/**
 * A ranking, one `T3 | reason` per line. Lines that do not parse, repeat a
 * record or cite one that does not exist are dropped; a reason that fails the
 * number rule loses its reason (the item stays, with the template reason).
 */
export function parseRankedLines(
  text: string,
  records: readonly CitableRecord[],
  max = 10,
): { items: { ref: string; reason: string | null }[]; dropped: number } {
  const byRef = new Map(records.map((r) => [r.ref, r.text]));
  const seen = new Set<string>();
  const items: { ref: string; reason: string | null }[] = [];
  let dropped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:\d+[.)]\s*)?\[?([A-Z]\d{1,3})\]?\s*[|:–-]\s*(.+)$/.exec(line);
    if (!m || !byRef.has(m[1]!) || seen.has(m[1]!)) {
      dropped += 1;
      continue;
    }
    seen.add(m[1]!);
    const reason = m[2]!.trim().slice(0, 240);
    const verdict = checkCitedText(`${reason} [${m[1]}]`, records, { maxSentences: 3 });
    items.push({ ref: m[1]!, reason: verdict.ok ? reason.replace(CITATION, '').trim() : null });
    if (items.length >= max) break;
  }
  return { items, dropped };
}
