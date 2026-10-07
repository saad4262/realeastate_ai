import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk';

describe('chunking text for embeddings', () => {
  it('keeps a short note whole, splits a long email with overlap at word boundaries, and stops at 8', () => {
    expect(chunkText('  Wants a pool.  ')).toEqual(['Wants a pool.']);
    expect(chunkText('   ')).toEqual([]);
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(words, 1200, 150);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200);
    for (const c of chunks) expect(c).not.toMatch(/^\S*ord\d+$|^\d/); // never starts mid-word
    expect(chunks[1]!.slice(0, 20)).toBe(chunks[0]!.slice(chunks[0]!.indexOf(chunks[1]!.slice(0, 20)), chunks[0]!.indexOf(chunks[1]!.slice(0, 20)) + 20));
    expect(chunkText('x '.repeat(50_000), 1200, 150, 8)).toHaveLength(8);
  });
});
