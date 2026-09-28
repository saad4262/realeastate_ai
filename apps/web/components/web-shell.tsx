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
  account,
}: {
  children: ReactNode;
  /** Full-bleed content — the property guide wants the whole width. */
  wide?: boolean;
  /**
   * Whether to draw the account control, and in which state.
   *
   * Left out by a page that cannot tell without reading a cookie. Today that
   * is `/` alone: it is the site's only statically rendered route
   * (`revalidate = 300`) and a `cookies()` call anywhere in its tree makes
   * it dynamic, which is the 33 ms it was measured at. Every other public
   * page is already `force-dynamic` and pays nothing to answer.
   *
   * Passing `{ signedIn: false }` and passing nothing are different things:
   * the first says "nobody is signed in" and offers a way in, the second
   * says "this page did not look". Collapsing them would put a Sign in
   * button in front of somebody who already is.
   */
  account?: { signedIn: boolean };
}) {
  return (
    <AppShell surface="web" wide={wide} linkAs={Link} account={account}>
      {children}
    </AppShell>
  );
}
