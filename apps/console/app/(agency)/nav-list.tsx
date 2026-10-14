'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from './agency-shell.module.css';

type NavItem = { href: string; label: string; icon: string; badge?: string; badgeTone?: 'blue' };

/**
 * The few destinations shown at all times. Everything else waits behind More.
 * Leads and Inbox carry the live badges; Projects and Connectors are the two
 * card grids. Change this list, not the markup, to promote a page.
 */
const PRIMARY: NavItem[] = [
  { href: '/leads', label: 'Leads', icon: 'filter_alt' },
  { href: '/inbox', label: 'Inbox', icon: 'mail' },
  { href: '/projects', label: 'Projects', icon: 'folder_open' },
  { href: '/settings/integrations', label: 'Connectors', icon: 'hub' },
];

const MORE: NavItem[] = [
  { href: '/live-listings', label: 'Listings', icon: 'real_estate_agent' },
  { href: '/messages', label: 'Team messages', icon: 'forum' },
  { href: '/team', label: 'Agents & Team', icon: 'groups' },
  { href: '/customers', label: 'Customers', icon: 'contacts' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/marketing', label: 'Marketing & Reviews', icon: 'campaign' },
  { href: '/insights', label: 'Insights', icon: 'analytics' },
  { href: '/skills', label: 'Skills', icon: 'auto_awesome' },
  { href: '/workflows', label: 'Workflows', icon: 'account_tree' },
  { href: '/bulk-email', label: 'Bulk email', icon: 'forward_to_inbox' },
  { href: '/ai', label: 'LocalAgent AI', icon: 'smart_toy', badge: '2030', badgeTone: 'blue' },
  { href: '/finance', label: 'Finance & Trust', icon: 'account_balance' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

/**
 * The one item to mark active: the longest href the path sits under, so
 * `/settings/integrations` lights Connectors and not Settings as well.
 */
function activeHref(pathname: string): string | null {
  let best: string | null = null;
  for (const { href } of [...PRIMARY, ...MORE]) {
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > (best?.length ?? 0)) best = href;
  }
  return best;
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
export function NavList({
  newOffers = 0,
  unreadMail = 0,
  unreadTeam = 0,
}: {
  newOffers?: number;
  /** Unopened conversations, narrowed by can() in load-actor.ts. */
  unreadMail?: number;
  /** Team conversations you are on with something new (ADR 0035). */
  unreadTeam?: number;
}) {
  const pathname = usePathname();
  const active = activeHref(pathname);
  const inMore = MORE.some((i) => i.href === active);
  const [moreOpen, setMoreOpen] = useState(inMore);
  // Arriving on a page that lives behind More opens it, so the active item is never hidden.
  useEffect(() => {
    if (inMore) setMoreOpen(true);
  }, [inMore]);

  /**
   * Unactioned private offers, counted by SQL and already zeroed by can() for
   * anyone who may not read one — see load-actor.ts. This is the only signal
   * an agency gets without opening the screen, and it is why offers were
   * allowed to share the Leads inbox rather than needing their own: rare,
   * high-value rows get buried in a date-sorted list, and email is currently
   * the only other way one is noticed.
   */
  const counts: Record<string, number> = { '/leads': newOffers, '/inbox': unreadMail, '/messages': unreadTeam };
  const hiddenNews = MORE.some((i) => (counts[i.href] ?? 0) > 0);

  const link = (item: NavItem) => {
    const on = item.href === active;
    const count = counts[item.href] ?? 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={on ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
        aria-current={on ? 'page' : undefined}
      >
        <span className={`${styles.glyph} ${on ? styles.glyphFill : ''}`} aria-hidden>
          {item.icon}
        </span>
        <span>{item.label}</span>
        {count > 0 ? (
          <span
            className={`${styles.navBadge} ${styles.navBadgeBlue}`}
            aria-label={item.href === '/leads' ? undefined : `${count} unread`}
          >
            {count}
          </span>
        ) : null}
        {item.badge ? (
          <span className={`${styles.navBadge} ${item.badgeTone === 'blue' ? styles.navBadgeBlue : ''}`}>{item.badge}</span>
        ) : null}
      </Link>
    );
  };

  return (
    <nav className={styles.nav} aria-label="Agency">
      {PRIMARY.map(link)}
      <button
        type="button"
        className={styles.navLink}
        aria-expanded={moreOpen}
        aria-controls="agency-nav-more"
        onClick={() => setMoreOpen((v) => !v)}
      >
        <span className={styles.glyph} aria-hidden>
          {moreOpen ? 'expand_less' : 'expand_more'}
        </span>
        <span>{moreOpen ? 'Less' : 'More'}</span>
        {!moreOpen && hiddenNews ? <span className={styles.navDot} aria-label="Something new under More" /> : null}
      </button>
      <div id="agency-nav-more" className={styles.navMore} hidden={!moreOpen}>
        {MORE.map(link)}
      </div>
    </nav>
  );
}
