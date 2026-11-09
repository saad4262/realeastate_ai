import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Fixed links in the console point at pages that exist. Connectors linked to `/bulk-email/templates`, which
 * has no page of its own (the templates are listed on Bulk email), and nothing noticed (found 2026-11-09).
 */

const CONSOLE = join(__dirname, '..', '..', '..', '..', 'apps', 'console');
const read = (...p: string[]) => readFileSync(join(CONSOLE, ...p), 'utf8');

/** A path the console serves: a page in one of the route groups, or a route handler (`/sign-out`). */
function served(href: string): boolean {
  const path = href.split(/[?#]/)[0]!.replace(/^\//, '');
  return ['(agency)', '(agent)', '(admin)', '(shared)'].some((g) => ['page.tsx', 'route.ts'].some((f) => existsSync(join(CONSOLE, 'app', g, path, f))));
}

const hrefsIn = (src: string) => [...src.matchAll(/href: '(\/[^']*)'/g)].map((m) => m[1]!);

describe('fixed links in the console', () => {
  it('every Connectors card opens a page that exists', () => {
    const missing = hrefsIn(read('components', 'integrations', 'integrations-page.tsx')).filter((h) => !served(h));
    expect(missing).toEqual([]);
  });

  it('every sidebar item opens a page that exists', () => {
    const missing = hrefsIn(read('components', 'shell', 'surfaces.ts')).filter((h) => !served(h));
    expect(missing).toEqual([]);
  });

  it('a link to the templates lands on their section of Bulk email', () => {
    expect(read('components', 'integrations', 'integrations-page.tsx')).toContain("href: '/bulk-email#templates'");
    expect(read('components', 'bulk-email', 'bulk-page.tsx')).toContain('id="templates"');
  });
});
