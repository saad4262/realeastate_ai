import { extractText } from 'unpdf';
import mammoth from 'mammoth';
import { isImageType } from './document-schema';

/**
 * Turning a file into its words, page by page (ADR 0053 §4). No model here: a PDF's own text
 * layer (`unpdf`, the serverless build of pdf.js), a Word file's text (`mammoth`), or plain text.
 * A scanned PDF or a photo has no words to take — it is handed to the vision reader instead,
 * which lives in packages/ai (non-negotiable 3) behind the `DocumentReader` port below.
 */

export type ExtractVia = 'text' | 'docx' | 'plain' | 'vision';

export type TextLayer =
  | { kind: 'text'; pages: string[]; via: Exclude<ExtractVia, 'vision'> }
  /** No usable words: a scan or a photo. `pageCount` when it is a PDF. */
  | { kind: 'needs_vision'; pageCount: number | null };

/** Under this many characters a page on average, a PDF is a scan with (at most) a stray header. */
export const SCANNED_CHARS_PER_PAGE = 40;

/** A "page" of a file that has none (Word, text): a section of about this many characters. */
const SECTION_CHARS = 4000;

/** Postgres text refuses NUL; `\f` is our page separator, so a stray one inside a page would split it. */
export function cleanPageText(text: string): string {
  return text.replace(/\u0000/g, '').replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function sections(text: string): string[] {
  const clean = cleanPageText(text);
  if (!clean) return [];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > SECTION_CHARS) {
    let cut = rest.lastIndexOf('\n', SECTION_CHARS);
    if (cut < SECTION_CHARS / 2) cut = rest.lastIndexOf(' ', SECTION_CHARS);
    if (cut < SECTION_CHARS / 2) cut = SECTION_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function extractTextLayer(bytes: Uint8Array, mimeType: string): Promise<TextLayer> {
  if (isImageType(mimeType)) return { kind: 'needs_vision', pageCount: null };

  if (mimeType === 'application/pdf') {
    // A copy: pdf.js may detach the buffer it is given, and the vision path still needs the bytes.
    const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: false });
    const pages = text.map(cleanPageText);
    const chars = pages.reduce((n, p) => n + p.replace(/\s+/g, '').length, 0);
    if (totalPages === 0 || chars / Math.max(1, totalPages) < SCANNED_CHARS_PER_PAGE) {
      return { kind: 'needs_vision', pageCount: totalPages };
    }
    return { kind: 'text', pages, via: 'text' };
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { kind: 'text', pages: sections(value), via: 'docx' };
  }

  if (mimeType.startsWith('text/')) {
    return { kind: 'text', pages: sections(new TextDecoder('utf-8', { fatal: false }).decode(bytes)), via: 'plain' };
  }

  throw new Error(`No reader for ${mimeType}`);
}

/**
 * The vision port. packages/ai implements it (Claude, metered in ai_run); tests hand in a fake.
 * Null everywhere means "reading scans is off" — the document is marked failed and says so.
 */
export type DocumentReader = {
  model: string;
  /** The words of a scanned PDF or a photo, one string per page (a photo is one page). Throws on any failure. */
  read(input: {
    bytes: Uint8Array;
    mimeType: string;
    documentId: string;
    agencyId: string;
    userId: string | null;
  }): Promise<{ pages: string[] }>;
};

/** What the vision reader may be sent (the API's own request limits, with headroom for base64). */
export const VISION_LIMITS = { pdfBytes: 20 * 1024 * 1024, pdfPages: 100, imageBytes: 5 * 1024 * 1024 } as const;

/** Why a file cannot go to the vision reader, or null when it can. */
export function visionRefusal(mimeType: string, bytes: number, pageCount: number | null): string | null {
  if (isImageType(mimeType)) {
    return bytes > VISION_LIMITS.imageBytes ? 'This photo is larger than 5 MB, too large to read. Upload a smaller copy.' : null;
  }
  if (bytes > VISION_LIMITS.pdfBytes) return 'This scanned PDF is larger than 20 MB, too large to read. Split it, or upload a PDF with text in it.';
  if (pageCount !== null && pageCount > VISION_LIMITS.pdfPages) {
    return `This scanned PDF has ${pageCount} pages; up to ${VISION_LIMITS.pdfPages} can be read. Split it, or upload a PDF with text in it.`;
  }
  return null;
}
