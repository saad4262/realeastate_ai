'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, use } from 'react';
import type { ConsoleChrome } from '../../lib/require-console-access';
import styles from './agent-shell.module.css';

const NAV = [
  { href: '/listings', label: 'My Listings', icon: 'home_work' },
  { href: '#', label: 'Leads', icon: 'person_search' },
  { href: '#', label: 'Inspections', icon: 'event' },
  { href: '#', label: 'Offers', icon: 'handshake' },
];

type AgentShellProps = {
  children: React.ReactNode;
  preview?: boolean;
  /** From middleware's headers — costs nothing, so the shell paints at once. */
  userLabel: string;
  /**
   * The agent's agency, still in flight. Awaiting it in the layout held the
   * whole desk behind one round trip to the database region.
   */
  chrome: Promise<ConsoleChrome>;
};

/** Agent console chrome — intentionally different from Agency OS shell. */
export function AgentShell({
  children,
  preview = false,
  userLabel,
  chrome,
}: AgentShellProps) {
  const pathname = usePathname();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.logo}>LA</div>
          <div>
            <div className={styles.brandName}>LocalAgentHub</div>
            <Suspense fallback={<span className={styles.shimmerLine} />}>
              <BrandSub chrome={chrome} />
            </Suspense>
          </div>
        </div>
        {/* See agency-shell.tsx: the default prefetch stops at this route
            group's loading.tsx, which is what a dynamic page wants. A Link
            with a bare `href="#"` is never prefetched either way. */}
        <nav className={styles.nav} aria-label="Agent">
          {NAV.map((item) => {
            const active = item.href !== '#' && pathname.startsWith(item.href);
            return (
              <Link
                key={item.label}
                href={item.href}
                className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
              >
                <span className={styles.glyph} aria-hidden>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className={styles.foot}>
          <span className={styles.user}>{userLabel}</span>
          <Link href="/sign-out" className={styles.signOut}>
            Sign out
          </Link>
        </div>
      </aside>
      <div className={styles.main}>
        {preview ? (
          <div className={styles.preview}>UI preview — agent surface (Stitch later).</div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * The agency name, once the database answers. Behind Suspense so the desk's
 * sidebar and nav are on screen before this round trip finishes.
 */
function BrandSub({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { agencyName } = use(chrome);
  return <div className={styles.brandSub}>{agencyName ?? 'Agent desk'}</div>;
}
