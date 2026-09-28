/**
 * The small slice of Markdown a chat model actually writes.
 *
 * The guide's answers come back as Markdown — `**Pakenham**`, numbered lists,
 * blank-line paragraphs — and the chat rendered them as one plain `<p>`, so a
 * visitor read literal asterisks: "I'd start with **Pakenham** and **Narre
 * Warren South**". The prompt is not the place to fix that; bold suburb names
 * and a numbered pair of questions are genuinely easier to read, and telling
 * the model to stop would make the answers worse to look at, not better.
 *
 * ## Why not a Markdown library
 *
 * react-markdown plus remark is tens of kilobytes on a route that already
 * carries the chat client, and it parses a specification this text never uses
 * — tables, footnotes, reference links, HTML passthrough. The subset below is
 * what a conversational answer contains, and every other character passes
 * through as text.
 *
 * ## Why this returns data rather than HTML
 *
 * There is no HTML anywhere in this file and no consumer of it calls
 * `dangerouslySetInnerHTML`. It returns a tree, the renderer turns that tree
 * into React elements, and React escapes every string it is handed. That makes
 * injection impossible by construction rather than by sanitising — which
 * matters, because this text is model output shaped by whatever an anonymous
 * visitor typed.
 *
 * ## Unmatched markers stay literal
 *
 * `**not closed` renders as `**not closed`. That is deliberate: the visitor is
 * better served by seeing exactly what the model wrote than by a parser that
 * guesses where emphasis was meant to end and silently eats characters.
 */

export type InlineNode = {
  type: 'text' | 'bold' | 'italic' | 'code';
  value: string;
};

export type Block =
  | { type: 'paragraph'; content: InlineNode[] }
  | { type: 'heading'; content: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] };

/**
 * `**bold**`, `*italic*`, `` `code` ``.
 *
 * What stops `**Pakenham**` being read as two italics is `[^*]` inside each
 * alternative, not the order they are written in: after the first `*` comes
 * another `*`, so the italic alternative cannot start there at all and the
 * engine falls through to the bold one. Reordering them changes nothing —
 * measured, after a comment here claimed the opposite.
 *
 * The same character class requires at least one non-marker character, which
 * is what leaves `****` and a stray `**` alone instead of matching them as
 * empty emphasis.
 */
const INLINE = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|\*[^*\n]+?\*)/g;

export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push({ type: 'text', value: text.slice(last, at) });

    const token = match[0];
    if (token.startsWith('**')) {
      out.push({ type: 'bold', value: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      out.push({ type: 'code', value: token.slice(1, -1) });
    } else {
      out.push({ type: 'italic', value: token.slice(1, -1) });
    }
    last = at + token.length;
  }

  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  // An empty string is one empty text node rather than nothing, so a caller
  // never has to special-case a block with no children.
  return out.length ? out : [{ type: 'text', value: '' }];
}

/** `1. `, `1) `, `- `, `* `, `+ ` — the marker and the space after it. */
const BULLET = /^\s*([-*+]|\d{1,3}[.)])\s+/;
const ORDERED = /^\s*\d{1,3}[.)]\s+/;
/** Up to three hashes. A chat answer does not have a document outline. */
const HEADING = /^\s*#{1,3}\s+/;

/**
 * Blocks, split on blank lines.
 *
 * A run of lines that all start with a bullet becomes one list. A run that
 * does not becomes one paragraph with its line breaks preserved — the model
 * writes a soft-wrapped sentence across two lines and means one sentence.
 */
export function parseChatMarkdown(text: string): Block[] {
  const blocks: Block[] = [];

  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // Every line a bullet, or it is not a list. A paragraph that happens to
    // start with a dash is not a one-item list.
    if (lines.every((l) => BULLET.test(l))) {
      blocks.push({
        type: 'list',
        ordered: ORDERED.test(lines[0] as string),
        items: lines.map((l) => parseInline(l.replace(BULLET, ''))),
      });
      continue;
    }

    if (lines.length === 1 && HEADING.test(lines[0] as string)) {
      blocks.push({
        type: 'heading',
        content: parseInline((lines[0] as string).replace(HEADING, '')),
      });
      continue;
    }

    blocks.push({ type: 'paragraph', content: parseInline(lines.join('\n')) });
  }

  return blocks;
}
