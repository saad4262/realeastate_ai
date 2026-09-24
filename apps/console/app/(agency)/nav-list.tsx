'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './agency-shell.module.css';

/** Stitch Agency OS sidebar order — exact labels + icons */
const NAV = [
  { href: '/overview', label: 'Overview', icon: 'dashboard' },
  { href: '/live-listings', label: 'Listings', icon: 'real_estate_agent' },
  { href: '/leads', label: 'Leads', icon: 'filter_alt' },
  { href: '/team', label: 'Agents & Team', icon: 'groups' },
  { href: '/customers', label: 'Customers', icon: 'contacts' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/marketing', label: 'Marketing & Reviews', icon: 'campaign' },
  { href: '/insights', label: 'Insights', icon: 'analytics' },
  { href: '/ai', label: 'LocalAgent AI', icon: 'smart_toy', badge: '2030', badgeTone: 'blue' as const },
  { href: '/finance', label: 'Finance & Trust', icon: 'account_balance' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

function isNavActive(pathname: string, href: string) {
  if (pathname === href) return true;
  if (href === '/team') {
    return pathname === '/team' || pathname.startsWith('/team/');
  }
  return pathname.startsWith(`${href}/`);
}

/**
 * The only part of the agency chrome that has to run in the browser.
 *
 * usePathname is genuinely required and cannot be moved to the server: layouts
 * are preserved across client navigation and do not re-render, so an active
 * class computed on the server — even from a pathname middleware handed down as
 * a header — would be correct on first paint and then stale for every
 * navigation after it.
 *
 * Everything else that used to live in this bundle alongside it — the sidebar
 * shell, the brand block, the search box, the profile footer, the whole topbar
 * — is markup, and markup does not need to be here to render.
 *
 * No explicit `prefetch`, and no router.prefetch loop either. Both used to run
 * at once: a useEffect asking for all twelve destinations on mount, AND
 * `prefetch` on every Link, each requesting a FULL prefetch of a dynamic page
 * that costs a query. The default is right because this route group has a
 * loading.tsx — Next prefetches only as far as that boundary, so a click paints
 * the skeleton immediately and the page arrives behind it, and Link skips
 * prefetching entirely on a slow connection or with Save-Data set.
 */
export function NavList() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Agency">
      {NAV.map((item) => {
        const active = isNavActive(pathname, item.href);
        const className = active
          ? `${styles.navLink} ${styles.navLinkActive}`
          : styles.navLink;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={className}
            aria-current={active ? 'page' : undefined}
          >
            <span className={`${styles.glyph} ${active ? styles.glyphFill : ''}`} aria-hidden>
              {item.icon}
            </span>
            <span>{item.label}</span>
            {item.badge ? (
              <span
                className={`${styles.navBadge} ${
                  item.badgeTone === 'blue' ? styles.navBadgeBlue : ''
                }`}
              >
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
