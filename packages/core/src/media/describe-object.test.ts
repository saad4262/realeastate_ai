import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeDocumentObject } from '../documents/storage';
import { describeObject } from './storage-client';
import { fetchHead } from './sniff';

/**
 * PLATFORM-PLAN 1.21 at the door: after a signed upload, the server reads the object's first bytes and refuses
 * a file whose bytes are not the type its header declared. Fake Storage: HEAD answers the declared type, GET
 * answers the bytes.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = new TextEncoder().encode('<!doctype html><script>steal()</script>');
let body: Uint8Array = PNG;
let declared = 'image/png';
const ranges: (string | null)[] = [];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://testref.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  ranges.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-type': declared, 'content-length': '1000' } });
    ranges.push(new Headers(init?.headers).get('range'));
    return new Response(body as BodyInit);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the stored object is what it claims', () => {
  it('a real PNG passes, read through a Range request', async () => {
    body = PNG;
    declared = 'image/png';
    await expect(describeObject('listings/a/b.png')).resolves.toMatchObject({ contentType: 'image/png' });
    expect(ranges).toEqual(['bytes=0-511']);
  });

  it('an HTML page uploaded as image/png is refused', async () => {
    body = HTML;
    declared = 'image/png';
    await expect(describeObject('listings/a/b.png')).rejects.toThrow(/not the image it claims/);
  });

  it('a document whose bytes are HTML but declared PDF is refused', async () => {
    body = HTML;
    declared = 'application/pdf';
    await expect(describeDocumentObject('agency/x/doc.pdf')).rejects.toThrow(/not the type it claims/);
  });
});

describe('fetchHead', () => {
  it('reads only the first 512 bytes even when Storage ignores the range', async () => {
    let pulled = 0;
    vi.stubGlobal('fetch', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1;
          if (pulled > 1000) return c.close();
          c.enqueue(new Uint8Array(256).fill(65));
        },
      });
      return new Response(stream);
    });
    const head = await fetchHead('https://x/y', {});
    expect(head.length).toBe(512);
    expect(pulled).toBeLessThan(10);
  });
});
