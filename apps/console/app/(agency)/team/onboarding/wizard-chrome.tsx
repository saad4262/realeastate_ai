'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import styles from './wizard.module.css';
import { useOnboarding } from './onboarding-state';

export const WIZARD_STEPS = [
  { n: 1, href: '/team/onboarding', label: 'Identity & Licensing', short: 'Identity' },
  { n: 2, href: '/team/onboarding/territory', label: 'Territory & Splits', short: 'Territory' },
  { n: 3, href: '/team/onboarding/permissions', label: 'Permissions & Invite', short: 'Permissions' },
  { n: 4, href: '/team/onboarding/review', label: 'Executive Review', short: 'Review' },
  { n: 5, href: '/team/onboarding/dispatch', label: 'Pass & Dispatch', short: 'Dispatch' },
] as const;

export type WizardStep = 1 | 2 | 3 | 4 | 5;

type WizardChromeProps = {
  step: WizardStep;
  title?: string;
  badge?: string;
  subtitle?: string;
  extraBadges?: React.ReactNode;
  headerAside?: React.ReactNode;
  children: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  nextHref?: string;
  nextLabel?: string;
  nextDisabled?: boolean;
  /** Return false to keep the user on this step (failed validation). */
  onNext?: () => boolean | void | Promise<boolean | void>;
  secondaryHref?: string;
  secondaryLabel?: string;
  footerNote?: string;
  hideFooterActions?: boolean;
};

export function WizardChrome({
  step,
  title = 'Add New Licensed Agent',
  badge = 'LIVE REINSW SYNC',
  subtitle = 'Identity & Australian statutory verification. Pre-populates REINSW registry and Fair Trading NSW digital credentials.',
  extraBadges,
  headerAside,
  children,
  backHref,
  backLabel = 'Back',
  nextHref,
  nextLabel = 'Continue',
  nextDisabled = false,
  onNext,
  secondaryHref,
  secondaryLabel = 'Save Draft',
  footerNote = 'Draft saved in this browser until you dispatch the invite',
  hideFooterActions = false,
}: WizardChromeProps) {
  const router = useRouter();
  const [moving, startMoving] = useTransition();
  const { draft } = useOnboarding();

  /**
   * The two steps this one can reach, and only those two.
   *
   * Each step is its own route, so Continue is a navigation and costs a round
   * trip even though every step page is a client component with no data of its
   * own. Warming the next one means the payload is already in the router cache
   * when the button is pressed and the move is instant — the wizard's loading
   * skeleton becomes the fallback for a slow connection rather than the thing
   * you see five times on the way through.
   *
   * Two, not five: ARCHITECTURE.md § 3 — prefetching is targeted, never
   * blanket. The step rail's own Links keep the default, which with this
   * folder's loading.tsx fetches the wizard shell and nothing heavier.
   */
  useEffect(() => {
    for (const href of [nextHref, backHref]) {
      if (href) router.prefetch(href);
    }
  }, [router, nextHref, backHref]);
  const candidateName =
    draft.displayName || `${draft.firstName} ${draft.lastName}`.trim() || 'New agent';
  const initials = candidateName
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'NA';

  async function handleNext() {
    if (nextDisabled || moving) return;
    if (onNext) {
      const ok = await onNext();
      if (ok === false) return;
    }
    // Inside a transition so the button can say it is working. Validation runs
    // first and outside it: a step that fails its own check never navigates, so
    // it should never show a pending state either.
    if (nextHref) startMoving(() => router.push(nextHref));
  }

  return (
    <div className={styles.wrap} data-full-bleed>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{title}</h1>
              <span className={styles.liveBadge}>
                <span className={styles.dot} />
                {badge}
              </span>
              {extraBadges}
            </div>
            <p className={styles.sub}>{subtitle}</p>
          </div>
          {headerAside ?? (
            <div className={styles.agencyMeta}>
              <div className={styles.metaLabel}>Onboarding draft</div>
              <div className={styles.metaVal}>{draft.email || 'Email pending'}</div>
              <div className={styles.candidate}>
                <div className={styles.candidateAv}>{initials}</div>
                <div>
                  <div className={styles.candidateName}>{candidateName}</div>
                  <div className={styles.candidateLic}>
                    {draft.licenceNumber ? `Lic #${draft.licenceNumber}` : 'Licence pending'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </header>

        <ol className={styles.steps}>
          {WIZARD_STEPS.map((s) => {
            const done = s.n < step;
            const active = s.n === step;
            return (
              <li
                key={s.n}
                className={`${styles.step} ${active ? styles.stepActive : ''} ${done ? styles.stepDone : ''}`}
              >
                <Link href={s.href} className={styles.stepLink}>
                  <span className={styles.stepNum}>
                    {done ? (
                      <span className={styles.glyphSm} aria-hidden>
                        check
                      </span>
                    ) : (
                      `0${s.n}`
                    )}
                  </span>
                  <span className={styles.stepLabel}>{s.label}</span>
                </Link>
              </li>
            );
          })}
        </ol>

        <div className={styles.body}>{children}</div>

        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            {backHref ? (
              <Link href={backHref} className={styles.btnGhost}>
                <span className={styles.glyphSm} aria-hidden>
                  arrow_back
                </span>
                {backLabel}
              </Link>
            ) : (
              <Link href="/team" className={styles.btnGhost}>
                Cancel
              </Link>
            )}
            <span className={styles.footerNote}>{footerNote}</span>
          </div>
          {!hideFooterActions ? (
            <div className={styles.footerRight}>
              {secondaryHref ? (
                <Link href={secondaryHref} className={styles.btnGhost}>
                  {secondaryLabel}
                </Link>
              ) : (
                <button type="button" className={styles.btnGhost}>
                  {secondaryLabel}
                </button>
              )}
              {nextHref || onNext ? (
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={nextDisabled || moving}
                  onClick={() => void handleNext()}
                >
                  {nextLabel}
                  <span
                    className={moving ? `${styles.glyphSm} ${styles.spin}` : styles.glyphSm}
                    aria-hidden
                  >
                    {moving ? 'progress_activity' : 'arrow_forward'}
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
