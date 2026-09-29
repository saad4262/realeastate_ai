import type { ComponentType, ReactNode } from 'react';
import styles from './app-shell.module.css';

export type Surface = 'web' | 'agent' | 'agency';

const titles: Record<Surface, string> = {
  web: 'Property Platform',
  agent: 'Agent console',
  agency: 'Agency console',
};

const homeHrefs: Record<Surface, string> = {
  web: '/',
  agent: '/',
  agency: '/',
};

/**
 * How this shell navigates.
 *
 * packages/ui has no `next` dependency, on purpose — it is plain React shared
 * by two Next apps, and nothing else in it imports a framework. So the app
 * hands in its own link component rather than this file importing one.
 *
 * It matters more than it looks. A raw <a> is a full document load: a fresh
 * HTML request, the whole client bundle parsed again, every layout torn down
 * and rebuilt, scroll position gone. The header sits on every page, so leaving
 * it as <a> would make the single most-clicked control on the site the slowest
 * thing on it — and would quietly undo the client-side navigation the rest of
 * this app is built around.
 */
type LinkLike = ComponentType<{
  href: string;
  className?: string;
  children: ReactNode;
}>;

type AppShellProps = {
  surface: Surface;
  children: ReactNode;
  /**
   * Full-bleed content (e.g. the property guide). Default stays a readable
   * article column; wide drops the max-width so a chat + sidebar can breathe.
   */
  wide?: boolean;
  /**
   * The app's client-side link. Defaults to a plain anchor so a surface that
   * has not wired one up still renders — it just navigates the slow way.
   */
  linkAs?: LinkLike;
  /**
   * The account control at the end of the primary nav.
   *
   * Data, not a session. packages/ui has no way to read one and must not
   * grow one: it is plain React shared by two Next apps, and a `cookies()`
   * call in this file would make every page in both apps that renders a
   * header dynamic. The app decides whether somebody is signed in; this
   * file decides what that looks like, so it looks the same everywhere.
   *
   * `undefined` means "this page cannot tell" and renders nothing — the
   * header then reads exactly as it did before this control existed. That
   * is `/`, the one statically rendered route, and the omission is
   * deliberate rather than a gap. See the note at that call site.
   */
  account?: { signedIn: boolean };
};

/**
 * Shared shell for all three surfaces. Branding follows `surface`
 * (resolved from host in console middleware — never hardcode in pages).
 */
export function AppShell({
  surface,
  children,
  wide = false,
  linkAs: Link = 'a' as unknown as LinkLike,
  account,
}: AppShellProps) {
  const isWeb = surface === 'web';

  return (
    <div className={`${styles.shell} ${styles[surface]} ${wide ? styles.wide : ''}`}>
      <header className={styles.header}>
        <Link href={homeHrefs[surface]} className={styles.brand}>
          {titles[surface]}
        </Link>

        {isWeb ? (
          <nav className={styles.nav} aria-label="Primary">
            {/*
              There is no Search link here any more, and `/search` is not
              gone — it is no longer an ENTRANCE.

              The way in is the guide: somebody says what they want in a
              sentence, and the answer hands them a `/search?…` link built
              from what the guide actually understood. That link, the ones
              in an alert email, and the ones on a listing page all still
              resolve; the route, its filters and its tests are untouched.
              What changed is that nobody is asked to choose a set of
              filters before they have said anything.

              A nav link back to a bare `/search` would undo that by being
              the first thing on every page — so it is removed rather than
              hidden, because a control nobody can see is one nobody
              maintains.
            */}
            {/*
              One link for both states, on purpose.

              "Sign in" is wrong for somebody already signed in and "My
              alerts" is wrong for somebody who is not — and telling them
              apart here would mean reading the session cookie in the shared
              header, which runs on `/` as well. `/` is a statically
              rendered ISR route; a `cookies()` call in this component would
              make it dynamic and cost the 33 ms it was measured at.

              So the link names its destination and the routing sorts it
              out: middleware sends a signed-out visitor from /alerts to
              /login?next=/alerts, which lands them back here afterwards.
            */}
            <Link href="/alerts" className={styles.navLink}>
              My alerts
            </Link>
            <Link href="/chat" className={styles.navCta}>
              Ask the guide
            </Link>
            {account ? (
              account.signedIn ? (
                <Link href="/account" className={styles.account}>
                  {/*
                    A glyph, never an initial. /chat and /alerts know the
                    visitor's name and /search does not — it is outside the
                    middleware matcher on purpose — so an initial would be a
                    letter on some pages and a shape on others, which reads
                    as a bug rather than as a design.
                  */}
                  <span className={styles.accountAvatar} aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.8" />
                      <path
                        d="M4.8 20a7.2 7.2 0 0 1 14.4 0"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                  <span className={styles.accountLabel}>Account</span>
                </Link>
              ) : (
                <Link href="/login" className={styles.accountAnon}>
                  Sign in
                </Link>
              )
            ) : null}
          </nav>
        ) : null}
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
