import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import type { Actor } from '../permissions';
import {
  documentKeyBelongsTo,
  documentKeySchema,
  documentMimeType,
  newDocumentKey,
  titleFromFilename,
} from './document-schema';
import { chunkPages, splitPages } from './chunk-pages';
import { cleanPageText, extractTextLayer, visionRefusal, VISION_LIMITS } from './extract';
import { documentScopeFilters } from './visibility';
import { fuseDocumentHits, type DocumentHit } from './search';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('document keys (ADR 0053 §1)', () => {
  it('are minted under the agency and checked against it', () => {
    const key = newDocumentKey(A, 'application/pdf');
    expect(key).toMatch(new RegExp(`^documents/${A}/[0-9a-f-]{36}\\.pdf$`));
    expect(documentKeySchema.safeParse(key).success).toBe(true);
    expect(documentKeyBelongsTo(key, A)).toBe(true);
    expect(documentKeyBelongsTo(key, B)).toBe(false);
  });

  it('refuse a path a browser made up', () => {
    for (const bad of [`documents/${A}/../${B}/x.pdf`, `listings/${A}/${A}.jpg`, `documents/${A}/${A}.exe`, `documents/${A}/${A}.pdf\n`]) {
      expect(documentKeySchema.safeParse(bad).success, bad).toBe(false);
      expect(documentKeyBelongsTo(bad, A), bad).toBe(false);
    }
    expect(() => newDocumentKey(A, 'application/x-msdownload')).toThrow();
  });

  it('take the type the browser said, else the extension, else refuse', () => {
    expect(documentMimeType({ type: 'application/pdf', name: 'contract.pdf' })).toBe('application/pdf');
    expect(documentMimeType({ type: '', name: 'Notes.MD' })).toBe('text/markdown');
    expect(documentMimeType({ type: 'application/octet-stream', name: 'offer.docx' })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(documentMimeType({ type: 'application/zip', name: 'files.zip' })).toBeNull();
    expect(titleFromFilename('Contract_of_sale.signed.pdf')).toBe('Contract of sale.signed');
  });
});

describe('page chunks (ADR 0053 §5)', () => {
  it('remember the pages their words came from', () => {
    const pages = ['a '.repeat(700), 'b '.repeat(700), 'c '.repeat(10)];
    const chunks = chunkPages(pages, 1000, 100);
    expect(chunks[0]).toMatchObject({ pageFrom: 1 });
    expect(chunks.at(-1)).toMatchObject({ pageTo: 3 });
    // A chunk spanning the first page break says so.
    expect(chunks.some((c) => c.pageFrom === 1 && c.pageTo === 2)).toBe(true);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
  });

  it('skip empty pages without losing the numbering', () => {
    const chunks = chunkPages(['', 'only page two has words']);
    expect(chunks).toEqual([{ text: 'only page two has words', pageFrom: 2, pageTo: 2 }]);
    expect(chunkPages(['', '  '])).toEqual([]);
  });

  it('stop at the cap', () => {
    expect(chunkPages(['word '.repeat(10_000)], 100, 10, 5)).toHaveLength(5);
  });

  it('pages are stored with form feeds between them, and a stray one in a page cannot split it', () => {
    expect(splitPages('one\ftwo')).toEqual(['one', 'two']);
    expect(cleanPageText('a\fb\u0000c')).toBe('a\nbc');
  });
});

/** A one-page PDF with `text` on it (or nothing), offsets computed so pdf.js need not repair it. */
function pdfWith(text: string | null): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('reading a file (ADR 0053 §4)', () => {
  it('takes a PDF’s own text layer', async () => {
    const layer = await extractTextLayer(pdfWith('This contract of sale is between the vendor and the purchaser of 12 Smith Street'), 'application/pdf');
    expect(layer.kind).toBe('text');
    if (layer.kind === 'text') {
      expect(layer.via).toBe('text');
      expect(layer.pages).toHaveLength(1);
      expect(layer.pages[0]).toContain('12 Smith Street');
    }
  });

  it('sends a PDF with no words (a scan) and a photo to the vision reader', async () => {
    expect(await extractTextLayer(pdfWith(null), 'application/pdf')).toEqual({ kind: 'needs_vision', pageCount: 1 });
    expect(await extractTextLayer(new Uint8Array([1, 2, 3]), 'image/png')).toEqual({ kind: 'needs_vision', pageCount: null });
  });

  it('cuts plain text into sections', async () => {
    const layer = await extractTextLayer(new TextEncoder().encode('Open home script.\n'.repeat(600)), 'text/plain');
    expect(layer.kind === 'text' && layer.pages.length).toBeGreaterThan(1);
  });

  it('says why a file cannot be read by the vision reader', () => {
    expect(visionRefusal('image/jpeg', 1000, null)).toBeNull();
    expect(visionRefusal('image/jpeg', VISION_LIMITS.imageBytes + 1, null)).toMatch(/5 MB/);
    expect(visionRefusal('application/pdf', 1000, VISION_LIMITS.pdfPages + 1)).toMatch(/pages/);
    expect(visionRefusal('application/pdf', VISION_LIMITS.pdfBytes + 1, 3)).toMatch(/20 MB/);
  });
});

describe('who sees a document — the SQL half (ADR 0053 §3)', () => {
  const render = (actor: Actor) => {
    const q = new PgDialect().sqlToQuery(and(...documentScopeFilters(actor))!);
    return { text: q.sql, params: q.params };
  };

  it('an admin: the whole agency, nothing narrowed', () => {
    const { text, params } = render({ userId: 'boss', agencyId: A, membershipRole: 'owner' });
    expect(params).toContain(A);
    expect(text).not.toContain('listing_agent');
    expect(text).toContain('"deleted_at" is null');
  });

  it('an agent: knowledge, their own, and — unless private — their contacts’ and listings’', () => {
    const { text, params } = render({ userId: 'agent-1', agencyId: A, membershipRole: 'agent' });
    expect(text).toContain(`"document"."scope" = 'knowledge'`);
    expect(text).toContain('"document"."uploaded_by" =');
    expect(text).toContain('"document"."is_private" = false');
    expect(text).toContain('la.listing_id = "document"."listing_id"');
    expect(params).toContain('agent-1');
    expect(params).toContain(A);
  });

  it('nobody outside an agency sees anything', () => {
    expect(render({ userId: 'consumer' }).text).toContain('false');
  });
});

describe('fusing document hits', () => {
  const hit = (id: string, at = 0): DocumentHit => ({ documentId: id, title: id, kind: 'other', scope: 'record', contactId: null, contactName: null, pageFrom: 1, pageTo: 1, snippet: '', at: new Date(at) });
  it('ranks a document found both ways first, once', () => {
    const fused = fuseDocumentHits([[hit('a'), hit('b')], [hit('b'), hit('c')]]);
    expect(fused.map((h) => h.documentId)).toEqual(['b', 'a', 'c']);
  });
});
