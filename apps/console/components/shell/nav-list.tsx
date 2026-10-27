'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SHELLS, type NavCount, type NavItem, type ShellSurface } from './surfaces';
import styles from './console-shell.module.css';

/**
 * The one item to mark active: the longest href the path sits under, so
 * `/settings/integrations` lights Connectors and not Settings as well.
 */
function activeHref(pathname: string, items: NavItem[]): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    if (href === '#') continue;
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > (best?.length ?? 0)) best = href;
  }
  return best;
}

/**
 * The only part of the console chrome that has to run in the browser.
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
  surface,
  newOffers = 0,
  unreadMail = 0,
  unreadTeam = 0,
}: {
  surface: ShellSurface;
  /**
   * Unactioned private offers, counted by SQL and already zeroed by can() for
   * anyone who may not read one — see load-actor.ts. This is the only signal
   * an agency gets without opening the screen, and it is why offers were
   * allowed to share the Leads inbox rather than needing their own: rare,
   * high-value rows get buried in a date-sorted list, and email is currently
   * the only other way one is noticed.
   */
  newOffers?: number;
  /** Unopened conversations, narrowed by can() in load-actor.ts. */
  unreadMail?: number;
  /** Team conversations you are on with something new (ADR 0035). */
  unreadTeam?: number;
}) {
  const { groups, navLabel, openByDefault } = SHELLS[surface];
  const pathname = usePathname();
  const active = activeHref(pathname, groups.flatMap((g) => g.items));
  const activeGroup = groups.find((g) => g.items.some((i) => i.href === active))?.label;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set([openByDefault, activeGroup].filter((l): l is string => Boolean(l))),
  );
  // Arriving on a page inside a closed group opens it, so the active item is never hidden (ADR 0057).
  useEffect(() => {
    if (activeGroup) setOpen((s) => (s.has(activeGroup) ? s : new Set(s).add(activeGroup)));
  }, [activeGroup]);
  const toggle = (label: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(label)) next.add(label);
      return next;
    });

  const counts: Record<NavCount, number> = { newOffers, unreadMail, unreadTeam };
  const countOf = (item: NavItem) => (item.count ? counts[item.count] : 0);

  const link = (item: NavItem) => {
    const on = item.href === active;
    const count = countOf(item);
    return (
      <Link
        key={item.label}
        href={item.href}
        className={on ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
        aria-current={on ? 'page' : undefined}
      >
        <span className={`${styles.glyph} ${on ? styles.glyphFill : ''}`} aria-hidden>
          {item.icon}
        </span>
        <span>{item.label}</span>
        <NavPending />
        {count > 0 ? (
          <span
            className={`${styles.navBadge} ${styles.navBadgeBlue}`}
            aria-label={item.countLabel === 'unread' ? `${count} unread` : undefined}
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
    <nav className={styles.nav} aria-label={navLabel}>
      {groups.map(({ label, items }, i) => {
        if (items.length === 0) return null;
        // Unlabelled: always shown, no heading (the agency's top pair, the admin's whole nav).
        if (!label) return <div key={i} className={styles.navGroupItems}>{items.map(link)}</div>;
        const isOpen = open.has(label);
        const id = `console-nav-${i}`;
        return (
          <div key={label} className={styles.navGroup}>
            <button
              type="button"
              className={styles.navGroupHead}
              aria-expanded={isOpen}
              aria-controls={id}
              onClick={() => toggle(label)}
            >
              <span className={styles.navGroupLabel}>{label}</span>
              {!isOpen && items.some((item) => countOf(item) > 0) ? (
                <span className={styles.navDot} aria-label={`Something new in ${label}`} />
              ) : null}
              <span className={`${styles.glyphSm} ${styles.navGroupChevron}`} aria-hidden>
                {isOpen ? 'expand_less' : 'expand_more'}
              </span>
            </button>
            <div id={id} className={styles.navGroupItems} hidden={!isOpen}>
              {items.map(link)}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * A ring inside the clicked nav item while its page is on the way.
 *
 * A nav click whose page is not in the router cache waits a round trip before
 * anything changes, and an unchanged screen reads as "my click did nothing" —
 * so it gets clicked again. useLinkStatus is scoped to the Link it renders in
 * (ARCHITECTURE.md § 10, as on /team), so only the clicked item shows it.
 */
function NavPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className={styles.navSpinner} role="status" aria-label="Loading" /> : null;
}
