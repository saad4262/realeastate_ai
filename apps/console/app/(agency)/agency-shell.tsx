import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import type { ConsoleChrome } from '../../lib/require-console-access';
import { NavList } from './nav-list';
import styles from './agency-shell.module.css';

/**
 * Agency OS chrome — a Server Component.
 *
 * This whole file used to be a client component, and all 292 lines of it went
 * to the browser so that one string comparison could pick a CSS class. Only
 * that comparison needs usePathname, and it now lives in NavList; the sidebar,
 * the brand block, the search boxes, the profile footer and the entire topbar
 * are markup and render on the server.
 *
 * The three readers below were client-only for a subtler reason that turned out
 * not to be a reason at all. They called `use(chrome)` to unwrap the promise the
 * layout deliberately does not await — but `use` is not what makes that work.
 * A Server Component can simply `await` the same promise inside its own
 * Suspense boundary and stream exactly the same way, for no JavaScript. The
 * shell still paints before the database answers; that was always Suspense
 * doing the work, not the hook.
 */
type AgencyShellProps = {
  children: ReactNode;
  /** From middleware's headers — costs nothing, so the shell paints at once. */
  userLabel: string;
  /**
   * Agency name, role and counts, still in flight.
   *
   * Awaiting these in the layout held the whole console — sidebar, nav and the
   * page's own skeleton — behind one round trip to the database region. They
   * arrive as a promise instead, and the three places that read them sit behind
   * their own Suspense boundaries.
   */
  chrome: Promise<ConsoleChrome>;
};

export function AgencyShell({ children, userLabel, chrome }: AgencyShellProps) {
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

          <NavList />
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

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}

/**
 * The three places the chrome's data surfaces.
 *
 * All of them await the same promise, which React resolves once, so the sidebar
 * brand, the profile role and the header counts fill in together — and the
 * shell around them never waits on any of it.
 */
async function Brand({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { agencyName } = await chrome;
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

async function ProfileRole({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { userRole } = await chrome;
  return <div className={styles.profileRole}>{userRole}</div>;
}

async function Ticker({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { summary } = await chrome;

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
