import type { ReactNode } from 'react';
import styles from './auth.module.css';

type AuthShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
  /**
   * The agency this page is about, when it is known — an invite link carries
   * one. These screens sit in front of the session, so most of the time there
   * is no agency to name and the platform is named instead. It used to say
   * "Bondi Prestige Group" to everyone, which was simply untrue.
   */
  agencyName?: string | null;
};

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  agencyName = null,
}: AuthShellProps) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.logoMark} aria-hidden>
            <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
              <path
                d="M42.1739 20.1739L27.8261 5.82609C29.1366 7.13663 28.3989 10.1876 26.2002 13.7654C24.8538 15.9564 22.9595 18.3449 20.6522 20.6522C18.3449 22.9595 15.9564 24.8538 13.7654 26.2002C10.1876 28.3989 7.13663 29.1366 5.82609 27.8261L20.1739 42.1739C21.4845 43.4845 24.5355 42.7467 28.1133 40.548C30.3042 39.2016 32.6927 37.3073 35 35C37.3073 32.6927 39.2016 30.3042 40.548 28.1133C42.7467 24.5355 43.4845 21.4845 42.1739 20.1739Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <div>
            <div className={styles.brandTitle}>
              LocalAgentHub OS
              <span className={styles.versionPill}>v4.8 Core Active</span>
            </div>
            <div className={styles.brandSub}>Antipodean Agency Operating System</div>
          </div>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.statusPill}>
            <span className={styles.pulse} />
            Sydney Metro Datacenter: 14ms
          </div>
          <a className={styles.supportLink} href="#">
            <span className={styles.glyphMd}>contact_support</span>
            Support Desk
          </a>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.stack}>
          <div className={styles.contextPill}>
            <div className={styles.contextInner}>
              <span className={`${styles.glyphMd} ${styles.sapphireFill}`}>verified</span>
              <p style={{ margin: 0 }}>
                {agencyName ?? 'LocalAgentHub OS'}{' '}
                <span className={styles.contextMuted}>•</span> NSW
              </p>
              <span className={styles.dot} />
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.iconBox}>
                <span className={styles.glyphLg}>domain</span>
              </div>
              <h1 className={styles.title}>{title}</h1>
              <p className={styles.subtitle}>{subtitle}</p>
            </div>
            <div className={styles.cardBody}>
              {children}
              <div className={styles.registerRow}>{footer}</div>
            </div>
          </div>

          <div className={styles.badges}>
            <div className={styles.badgeRow}>
              <span className={styles.badgeItem}>
                <span className={styles.glyphSm}>lock</span>
                256-bit AES
              </span>
              <span>•</span>
              <span className={styles.badgeItem}>
                <span className={styles.glyphSm}>verified_user</span>
                ISO 27001 Certified
              </span>
              <span>•</span>
              <span className={styles.badgeItem}>
                <span className={styles.glyphSm}>gavel</span>
                NSW Property and Stock Agents Act 2002 Compliant
              </span>
            </div>
            <p className={styles.sessionMeta}>Session edge · LocalAgentHub OS · AU-NSW</p>
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <span className={styles.dot} />
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
            LocalAgentHub OS Platform
          </span>
          <span className={styles.contextMuted}>|</span>
          <span className={styles.contextMuted}>
            {agencyName ? `${agencyName} tenancy` : 'Antipodean Agency Operating System'}
          </span>
        </div>
        <div className={styles.footerLinks}>
          <a href="#">Compliance Disclosure</a>
          <a href="#">Privacy Charter</a>
          <a href="#">Hardware Key Diagnostics</a>
        </div>
      </footer>
    </div>
  );
}
