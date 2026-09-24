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
            <Link href="/search" className={styles.navLink}>
              Search
            </Link>
            <Link href="/chat" className={styles.navCta}>
              Ask the guide
            </Link>
          </nav>
        ) : null}
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  );
}
