import Link from 'next/link';
import type { ReactNode } from 'react';
import { NavList } from '@/components/shell/nav-list';
import { SHELLS } from '@/components/shell/surfaces';
import { SignOutButton } from '@/components/sign-out-button';
import styles from '@/components/shell/console-shell.module.css';
import own from './admin.module.css';

/**
 * The admin console's chrome (ADR 0049): the console shell's sidebar and
 * stylesheet, without what belongs to an agency member — no assistant, no
 * Recents, no bell, no live refresh, no agency ticker. The admin is a member
 * of no agency, so every one of those would read nothing or the wrong thing.
 * A Server Component; the nav is the only island, as in ConsoleShell.
 */
export function AdminShell({ userLabel, children }: { userLabel: string; children: ReactNode }) {
  const shell = SHELLS.admin;
  const initials = userLabel
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={`${styles.shell} ${own.adminShell}`}>
      <aside className={`${styles.sidebar} ${own.adminSidebar}`}>
        <div className={styles.sidebarTop}>
          <div className={styles.brandRow}>
            <Link href={shell.home} className={styles.brandLeft}>
              <div className={styles.logo}>PA</div>
              <div>
                <div className={styles.brandName}>LocalAgentHub</div>
                <div className={styles.brandSub}>{shell.brandFallback}</div>
              </div>
            </Link>
          </div>
          <NavList surface="admin" />
        </div>

        <div className={styles.sidebarFoot}>
          <div className={styles.profile}>
            <div className={styles.avatar}>{initials}</div>
            <div className={`${styles.profileMeta} ${own.adminProfileText}`}>
              <div className={styles.profileName}>{userLabel}</div>
              <div className={styles.profileRole}>Platform admin</div>
            </div>
            <SignOutButton title="Sign out" className={styles.glyph} style={{ color: 'var(--text-muted)' }}>
              logout
            </SignOutButton>
          </div>
        </div>
      </aside>

      <div className={`${styles.mainCol} ${own.adminMain}`}>
        <div className={`${styles.content} ${own.adminContent}`}>{children}</div>
      </div>
    </div>
  );
}
