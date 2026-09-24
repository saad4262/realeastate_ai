'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './agent-shell.module.css';

const NAV = [
  { href: '/listings', label: 'My Listings', icon: 'home_work' },
  { href: '#', label: 'Leads', icon: 'person_search' },
  { href: '#', label: 'Inspections', icon: 'event' },
  { href: '#', label: 'Offers', icon: 'handshake' },
];

/**
 * The agent desk's nav — the only part of its chrome that needs the browser.
 *
 * See (agency)/nav-list.tsx: usePathname cannot move to the server, because a
 * layout is preserved across client navigation and would never recompute the
 * active class. Everything else in this shell is markup.
 */
export function AgentNav() {
  const pathname = usePathname();

  return (
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
  );
}
