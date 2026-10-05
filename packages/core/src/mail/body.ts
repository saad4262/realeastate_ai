/**
 * Turning a received email into text a person — or a relay — can use.
 *
 * None of this is a security boundary. Received HTML is never put into a page
 * as markup (it renders in a sandboxed iframe, ADR 0016 §5); this produces the
 * PLAIN TEXT that lists, previews and relays use, and plain text rendered by
 * React is escaped like any other string.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[lower] ?? whole;
  });
}

/** Readable text from an HTML body: block elements become line breaks, everything else goes. */
export function htmlToText(html: string): string {
  return tidy(
    decodeEntities(
      html
        .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, ''),
    ),
  );
}

/** Trailing spaces off every line, runs of blank lines down to one, ends trimmed. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * `html_format: "data_uri"` in Resend's received-email response means the body
 * may arrive as `data:text/html;base64,…` rather than as markup. Both are
 * accepted; anything undecodable is dropped rather than stored as garbage.
 */
export function decodeHtmlField(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('data:')) return value;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const meta = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  try {
    return meta.endsWith(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/**
 * The new part of a reply, without the history every mail client quotes under it.
 *
 * Used for two things: the preview line in a list, and — the one that matters —
 * the text RELAYED to a buyer when an agent answers from Gmail. Relaying the
 * quoted part would send the buyer our own notice email back, console link and
 * all.
 *
 * It cuts at the first line that starts a quote in the shapes the common
 * clients write. When it finds nothing it returns the whole text: losing an
 * answer is worse than repeating a quote.
 */
export function stripQuotedReply(text: string): string {
  const lines = tidy(text).split('\n');
  let cut = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    const joined = `${line} ${(lines[i + 1] ?? '').trim()}`;
    if (
      // Gmail / Apple Mail: "On Fri, 3 Oct 2026 at 10:02, Bea <bea@x.com> wrote:"
      // — sometimes wrapped onto two lines.
      /^On\b.{0,200}\bwrote:$/i.test(line) ||
      (/^On\b/i.test(line) && /\bwrote:$/i.test(joined) && joined.length < 300) ||
      // Outlook
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      (/^_{10,}$/.test(line) && /^From:/i.test((lines[i + 1] ?? '').trim())) ||
      // Outlook on the web, without the rule above it
      (/^From:\s.+/i.test(line) && /^(Sent|Date):\s/i.test((lines[i + 1] ?? '').trim())) ||
      // A block of ">" lines
      /^>/.test(line)
    ) {
      cut = i;
      break;
    }
  }

  const kept = lines.slice(0, cut).join('\n').trim();
  return kept || tidy(text);
}

/** One line for a list: the new part of the message, whitespace collapsed, capped. */
export function snippet(text: string, max = 160): string {
  const flat = stripQuotedReply(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
