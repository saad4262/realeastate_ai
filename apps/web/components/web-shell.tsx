import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from '@repo/ui';

/**
 * The public site's chrome.
 *
 * One job: hand AppShell a real `next/link` so the header navigates client
 * side. packages/ui cannot import one itself — it has no `next` dependency,
 * and it is shared with the console — so this is where the two meet.
 *
 * Every page on apps/web goes through here rather than reaching for AppShell
 * directly, because a page that forgets the prop gets a header that silently
 * falls back to full document loads: still correct, three hundred milliseconds
 * slower, and invisible in review.
 */
export function WebShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** Full-bleed content — the property guide wants the whole width. */
  wide?: boolean;
}) {
  return (
    <AppShell surface="web" wide={wide} linkAs={Link}>
      {children}
    </AppShell>
  );
}
