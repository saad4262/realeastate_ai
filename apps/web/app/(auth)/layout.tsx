import type { ReactNode } from 'react';
import { WebShell } from '../../components/web-shell';
import styles from './auth.module.css';

/**
 * One shell for every account screen.
 *
 * `wide` so the page owns its own width. The shell's default `main` is a
 * 960px article column with its own padding, and centring a card inside
 * that centres it inside the column rather than on the page — which is
 * most of what made the first version look wrong.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <WebShell wide>
      <div className={styles.page}>{children}</div>
    </WebShell>
  );
}
