'use client';

import { useLinkStatus } from 'next/link';
import styles from './team.module.css';

/**
 * A spinner that appears inside its own Link while that Link is navigating.
 *
 * Tab and dossier clicks on this page do go to the server — `?tab=` and
 * `?agent=` are the state store (ARCHITECTURE.md § 4) and the page re-renders
 * for them — but they no longer throw the roster away while they do it, because
 * the boundary in page.tsx is not keyed on them any more. That leaves a gap of
 * one round trip in which the screen is correct but unchanged, and the honest
 * reading of that is "my click did nothing", so it gets clicked again.
 *
 * useLinkStatus is scoped to the Link it is rendered inside, which is why this
 * is a component and not a page-level pending flag: three tabs and twenty rows
 * share one router, and only the one that was clicked should say so. It is the
 * whole reason this file is a client component, and it is about 300 bytes.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <span className={styles.spinner} role="status" aria-label="Loading" />;
}
