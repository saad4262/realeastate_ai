import { describe, expect, it } from 'vitest';
import { sniffMatches } from './sniff';

/** PLATFORM-PLAN 1.21: a file is what its first bytes say, not what the uploader's header claims. */
const b = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)));
const JPEG = b([0xff, 0xd8, 0xff, 0xe0], 'JFIF');
const PNG = b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR');
const WEBP = b('RIFF', [0x10, 0, 0, 0], 'WEBPVP8 ');
const AVIF = b([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'mif1');
const PDF = b('%PDF-1.7\n');
const DOCX = b([0x50, 0x4b, 0x03, 0x04], 'word/');
const HTML = b('<!DOCTYPE html><html><script>alert(1)</script>');

describe('sniffMatches', () => {
  it('accepts each allowed type by its signature', () => {
    expect(sniffMatches('image/jpeg', JPEG)).toBe(true);
    expect(sniffMatches('image/png', PNG)).toBe(true);
    expect(sniffMatches('image/webp', WEBP)).toBe(true);
    expect(sniffMatches('image/avif', AVIF)).toBe(true);
    expect(sniffMatches('application/pdf', PDF)).toBe(true);
    expect(sniffMatches('application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX)).toBe(true);
    expect(sniffMatches('text/plain', b('Kitchen renovated 2019.\n'))).toBe(true);
    expect(sniffMatches('text/csv', b('name,phone\nAli,0400\n'))).toBe(true);
  });

  it('refuses HTML, SVG or script sent as an image or a document', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) expect(sniffMatches(type, HTML), type).toBe(false);
    expect(sniffMatches('image/png', b('<svg xmlns="http://www.w3.org/2000/svg" onload="x()">'))).toBe(false);
  });

  it('refuses one image type labelled as another, and a PDF labelled as an image', () => {
    expect(sniffMatches('image/png', JPEG)).toBe(false);
    expect(sniffMatches('image/jpeg', PDF)).toBe(false);
  });

  it('refuses text that is really markup or binary', () => {
    expect(sniffMatches('text/plain', HTML)).toBe(false);
    expect(sniffMatches('text/markdown', b('  <script src=x></script>'))).toBe(false);
    expect(sniffMatches('text/csv', b('a,b', [0, 0, 1]))).toBe(false);
  });

  it('refuses a type it does not know, and an empty head', () => {
    expect(sniffMatches('image/svg+xml', b('<svg/>'))).toBe(false);
    expect(sniffMatches('image/png', new Uint8Array())).toBe(false);
  });
});
