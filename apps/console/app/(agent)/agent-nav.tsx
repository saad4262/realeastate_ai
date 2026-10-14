'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './agent-shell.module.css';

const NAV = [
  { href: '/listings', label: 'My Listings', icon: 'home_work' },
  { href: '/my-leads', label: 'Leads', icon: 'person_search' },
  { href: '/my-inbox', label: 'Inbox', icon: 'mail' },
  { href: '/my-messages', label: 'Team messages', icon: 'forum' },
  { href: '/my-contacts', label: 'Contacts', icon: 'contacts' },
  { href: '/my-calendar', label: 'Calendar', icon: 'event' },
  { href: '#', label: 'Offers', icon: 'handshake' },
  { href: '/my-skills', label: 'Skills', icon: 'auto_awesome' },
  { href: '/my-workflows', label: 'Workflows', icon: 'account_tree' },
  { href: '/my-bulk-email', label: 'Bulk email', icon: 'forward_to_inbox' },
  { href: '/my-dashboards', label: 'Dashboards', icon: 'monitoring' },
  { href: '/my-reviews', label: 'Agency reviews', icon: 'reviews' },
  { href: '/my-integrations', label: 'Connectors', icon: 'hub' },
];

/**
 * The agent desk's nav — the only part of its chrome that needs the browser.
 *
 * See (agency)/nav-list.tsx: usePathname cannot move to the server, because a
 * layout is preserved across client navigation and would never recompute the
 * active class. Everything else in this shell is markup.
 */
export function AgentNav({ unreadMail = 0, unreadTeam = 0 }: { unreadMail?: number; unreadTeam?: number }) {
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
            {/* Unopened conversations, narrowed by can() in load-actor.ts. */}
            {item.href === '/my-inbox' && unreadMail > 0 ? (
              <span className={styles.navBadge} aria-label={`${unreadMail} unread`}>
                {unreadMail}
              </span>
            ) : null}
            {/* Team conversations you are on with something new (ADR 0035). */}
            {item.href === '/my-messages' && unreadTeam > 0 ? (
              <span className={styles.navBadge} aria-label={`${unreadTeam} unread`}>
                {unreadTeam}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
