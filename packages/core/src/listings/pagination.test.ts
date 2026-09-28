import { describe, expect, it } from 'vitest';
import { PAGE_GAP, pageWindow } from './pagination';

/**
 * The edges, because the middle is obvious.
 *
 * Every assertion here is about a page being reachable. A pager that drops the
 * last number is a page nobody can get to, and it looks completely fine on the
 * screenshot that gets reviewed — page 1 of 20, where nothing is elided yet.
 */
describe('the page window', () => {
  const real = (w: number[]) => w.filter((n) => n !== PAGE_GAP);

  it('lists every page when there are few enough to list', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('always keeps the first and last page reachable', () => {
    for (const page of [1, 2, 5, 10, 19, 20]) {
      const w = pageWindow(page, 20);
      expect(w[0]).toBe(1);
      expect(w[w.length - 1]).toBe(20);
    }
  });

  it('always contains the page you are on', () => {
    for (const page of [1, 2, 3, 9, 10, 11, 18, 19, 20]) {
      expect(pageWindow(page, 20)).toContain(page);
    }
  });

  it('elides in the middle, not at the ends', () => {
    expect(pageWindow(10, 20)).toEqual([1, PAGE_GAP, 9, 10, 11, PAGE_GAP, 20]);
    expect(pageWindow(1, 20)).toEqual([1, 2, PAGE_GAP, 20]);
    expect(pageWindow(20, 20)).toEqual([1, PAGE_GAP, 19, 20]);
  });

  it('never hides a single page behind an ellipsis', () => {
    // The gap would occupy more room than the one number it replaces, and it
    // would make page 2 unreachable from page 4 in a single click.
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, PAGE_GAP, 20]);
    expect(pageWindow(17, 20)).toEqual([1, PAGE_GAP, 16, 17, 18, 19, 20]);
  });

  it('never repeats a page', () => {
    for (let pages = 1; pages <= 30; pages += 1) {
      for (let page = 1; page <= pages; page += 1) {
        const numbers = real(pageWindow(page, pages));
        expect(new Set(numbers).size).toBe(numbers.length);
      }
    }
  });

  it('stays in ascending order', () => {
    for (let pages = 1; pages <= 30; pages += 1) {
      for (let page = 1; page <= pages; page += 1) {
        const numbers = real(pageWindow(page, pages));
        expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
      }
    }
  });

  it('clamps a hand-edited page number instead of throwing', () => {
    // ?page=999 on a 3-page search already renders page 3's empty results.
    // A pager that threw there would turn that into a 500.
    expect(pageWindow(999, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(-4, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(Number.NaN, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 0)).toEqual([1]);
  });
});
