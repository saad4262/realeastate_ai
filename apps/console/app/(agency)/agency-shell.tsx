'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, use, type ReactNode } from 'react';
import type { ConsoleChrome } from '../../lib/require-console-access';
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

type AgencyShellProps = {
  children: ReactNode;
  preview?: boolean;
  /** From middleware's headers — costs nothing, so the shell paints at once. */
  userLabel: string;
  /**
   * Agency name, role and counts, still in flight.
   *
   * Awaiting these in the layout held the whole console — sidebar, nav and
   * the page's own skeleton — behind one round trip to the database region.
   * They arrive as a promise instead, and the three places that read them sit
   * behind their own Suspense boundaries.
   */
  chrome: Promise<ConsoleChrome>;
};

function isNavActive(pathname: string, href: string) {
  if (pathname === href) return true;
  if (href === '/team') {
    return pathname === '/team' || pathname.startsWith('/team/');
  }
  return pathname.startsWith(`${href}/`);
}

export function AgencyShell({
  children,
  preview = false,
  userLabel,
  chrome,
}: AgencyShellProps) {
  const pathname = usePathname();

  const initials = userLabel
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <div className={styles.brandRow}>
            <div className={styles.brandLeft}>
              <Suspense fallback={<BrandFallback />}>
                <Brand chrome={chrome} />
              </Suspense>
            </div>
          </div>

          <div className={styles.sideSearch}>
            <span className={styles.sideSearchIcon} aria-hidden>
              <span className={styles.glyphSm}>search</span>
            </span>
            <input
              className={styles.sideSearchInput}
              placeholder="Search directory..."
              type="search"
              aria-label="Search directory"
            />
            <kbd className={styles.cmdK}>⌘K</kbd>
          </div>

          {/*
            No explicit `prefetch`, and no router.prefetch loop either.

            Both used to be here at once: a useEffect calling router.prefetch()
            for all twelve destinations on mount, AND `prefetch` on every Link.
            Both ask for a FULL prefetch — the complete render of a page that is
            dynamic and costs a query — so opening the console fired twelve of
            them before the agent had clicked anything.

            The default is the right one here because this route group has a
            loading.tsx: Next prefetches only as far as that boundary, so a
            click paints the skeleton immediately and the page arrives behind
            it. Link also skips prefetching entirely on a slow connection or
            with Save-Data set, which router.prefetch() does not.
          */}
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
        </div>

        <div className={styles.sidebarFoot}>
          <Link href="/settings" className={styles.navLink}>
            <span className={styles.glyph} aria-hidden>
              help_outline
            </span>
            <span>Help &amp; Support</span>
          </Link>
          <div className={styles.profile}>
            <div className={styles.avatar}>{initials}</div>
            <div className={styles.profileMeta}>
              <div className={styles.profileName}>{userLabel}</div>
              <Suspense fallback={<div className={`${styles.profileRole} ${styles.shimmerLine}`} />}>
                <ProfileRole chrome={chrome} />
              </Suspense>
            </div>
            <span className={styles.profileOnline} aria-hidden />
            <Link
              href="/sign-out"
              title="Sign out"
              className={styles.glyph}
              style={{ color: 'var(--text-muted)' }}
            >
              logout
            </Link>
          </div>
        </div>
      </aside>

      <div className={styles.mainCol}>
        <header className={styles.topbar}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>
              <span className={styles.glyphSm} aria-hidden>
                search
              </span>
            </span>
            <input
              className={styles.searchInput}
              placeholder="Search agent name, REINSW licence, suburb specialist, or sales volume..."
              type="search"
              aria-label="Omni search"
            />
            <kbd className={styles.searchKbd}>⌘F</kbd>
          </div>

          {/*
            This strip used to show invented market figures (a clearance rate,
            a metro median). Numbers come from SQL or they do not get shown —
            these are the agency's own, counted in the same query that builds
            the session.
          */}
          <div className={styles.ticker} aria-label="Agency summary">
            <Suspense fallback={<span className={styles.shimmerLine} style={{ width: '13rem' }} />}>
              <Ticker chrome={chrome} />
            </Suspense>
          </div>

          <div className={styles.topActions}>
            <button type="button" className={styles.iconBtn} aria-label="Notifications">
              <span className={styles.glyph} aria-hidden>
                notifications
              </span>
              <span className={styles.ping} />
            </button>
            <button type="button" className={styles.iconBtn} aria-label="Filters">
              <span className={styles.glyph} aria-hidden>
                tune
              </span>
            </button>
            <Link href="/ai" className={styles.aiBtn}>
              <span className={`${styles.glyph} ${styles.glyphFill} mat`} aria-hidden>
                smart_toy
              </span>
              LocalAgent AI
            </Link>
          </div>
        </header>

        <div className={styles.content}>
          {preview ? (
            <div className={styles.previewBanner}>
              UI preview mode — mock agency data. Auth + live SQL wire up after Stitch screens land.
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The three places the chrome's data surfaces.
 *
 * All of them read the same promise, which React resolves once, so the sidebar
 * brand, the profile role and the header counts fill in together — and the
 * shell around them never waits on any of it.
 */
function Brand({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { agencyName } = use(chrome);
  // Initials stand in for a logo until agency branding is uploadable.
  const initials =
    (agencyName ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || 'LA';

  return (
    <>
      <div className={styles.logo}>{initials}</div>
      <div>
        <div className={styles.brandName}>LocalAgentHub</div>
        <div className={styles.brandSub}>{agencyName ?? 'No agency yet'}</div>
      </div>
    </>
  );
}

function BrandFallback() {
  return (
    <>
      <div className={styles.logo}>LA</div>
      <div>
        <div className={styles.brandName}>LocalAgentHub</div>
        <div className={`${styles.brandSub} ${styles.shimmerLine}`} />
      </div>
    </>
  );
}

function ProfileRole({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { userRole } = use(chrome);
  return <div className={styles.profileRole}>{userRole}</div>;
}

function Ticker({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { summary } = use(chrome);

  return (
    <>
      <span>
        <span className={styles.tickerMuted}>Live listings: </span>
        <span className={styles.tickerVal}>{summary.liveListings}</span>
      </span>
      <span className={styles.tickerSep} />
      <span>
        <span className={styles.tickerMuted}>Team: </span>
        <span className={styles.tickerVal}>{summary.members}</span>
      </span>
      {summary.pendingInvites > 0 ? (
        <>
          <span className={styles.tickerSep} />
          <span>
            <span className={styles.tickerMuted}>Invites pending: </span>
            <span className={styles.tickerVal}>{summary.pendingInvites}</span>
          </span>
        </>
      ) : null}
    </>
  );
}
