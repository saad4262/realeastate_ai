import Link from 'next/link';
import { Suspense } from 'react';
import type { ConsoleChrome } from '../../lib/require-console-access';
import { AgentNav } from './agent-nav';
import styles from './agent-shell.module.css';

type AgentShellProps = {
  children: React.ReactNode;
  /** From middleware's headers — costs nothing, so the shell paints at once. */
  userLabel: string;
  /**
   * The agent's agency, still in flight. Awaiting it in the layout held the
   * whole desk behind one round trip to the database region.
   */
  chrome: Promise<ConsoleChrome>;
};

/**
 * Agent console chrome — intentionally different from Agency OS shell, and a
 * Server Component for the same reason it is: only the nav needs a pathname.
 */
export function AgentShell({ children, userLabel, chrome }: AgentShellProps) {
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
        <AgentNav />
        <div className={styles.foot}>
          <span className={styles.user}>{userLabel}</span>
          <Link href="/sign-out" className={styles.signOut}>
            Sign out
          </Link>
        </div>
      </aside>
      <div className={styles.main}>{children}</div>
    </div>
  );
}

/**
 * The agency name, once the database answers. Behind Suspense so the desk's
 * sidebar and nav are on screen before this round trip finishes — which is
 * Suspense's doing, not a hook's, so this can await on the server.
 */
async function BrandSub({ chrome }: { chrome: Promise<ConsoleChrome> }) {
  const { agencyName } = await chrome;
  return <div className={styles.brandSub}>{agencyName ?? 'Agent desk'}</div>;
}
