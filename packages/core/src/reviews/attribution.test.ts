import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Google's Places terms (checked 2026-10-06, ADR 0028): Places content shown
 * without a Google map carries Google's attribution; every review credits its
 * author (name, photo, profile link) and links to the review on Google Maps;
 * how reviews are chosen and ordered is stated. One component does all of it,
 * and nothing else in either app renders reviews.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const COMPONENT = join(ROOT, 'packages', 'ui', 'src', 'google-reviews.tsx');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.next')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('Google reviews are always shown with their attribution', () => {
  const src = readFileSync(COMPONENT, 'utf8');
  const reviews = src.slice(src.indexOf('export function GoogleReviews'));

  it('the component carries Google’s attribution, each author’s name, photo and link, each review’s link, and the notice', () => {
    expect(reviews).toMatch(/<GoogleAttribution \/>/);
    expect(src).toMatch(/Google Maps<\/strong>/);
    expect(reviews).toMatch(/href=\{r\.author\.uri\}[\s\S]*\{r\.author\.name\}/);
    expect(reviews).toMatch(/src=\{r\.author\.photoUri\}/);
    expect(reviews).toMatch(/href=\{r\.mapsUri\}[\s\S]*View on Google Maps/);
    expect(reviews).toMatch(/chosen and ordered by Google/);
    // Never filtered: every review Google returned is rendered.
    expect(reviews).toMatch(/place\.reviews\.map\(/);
    expect(reviews).not.toMatch(/reviews\.filter\(|reviews\.sort\(|reviews\.slice\(/);
  });

  it('nothing else in either app renders a review itself', () => {
    const files = [...walk(join(ROOT, 'apps', 'web')), ...walk(join(ROOT, 'apps', 'console'))];
    const own = files.filter((f) => /\.reviews\.map\(|author\.name|author\.photoUri/.test(readFileSync(f, 'utf8')));
    expect(own.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
