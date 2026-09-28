import { SkeletonBar } from '@/components/page-skeleton';
import styles from './wizard.module.css';

/**
 * The wizard's own shell while a step arrives.
 *
 * The five steps are five routes, so moving between them is a real navigation,
 * and with no boundary of its own this folder fell through to the route group's
 * loading.tsx. That one is a centred column with three stat tiles — so pressing
 * Continue tore the wizard down, painted the shape of a dashboard, and then
 * rebuilt the wizard. It looked exactly like the page had reloaded, because
 * visually it had.
 *
 * Here the card, the step rail and the footer are the real classes with the real
 * padding, so what changes between steps is the body and nothing else.
 */
export function WizardSkeleton() {
  return (
    <div className={styles.wrap} data-full-bleed aria-busy="true" aria-live="polite">
      <div className={styles.shell}>
        <span className="sr-only">Loading this step</span>

        <header className={styles.header}>
          <div>
            <div className={styles.titleRow}>
              <SkeletonBar height={24} width={300} radius="0.375rem" />
              <SkeletonBar height={17} width={112} radius="9999px" />
            </div>
            <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.25rem' }}>
              <SkeletonBar height={12} width="min(36rem, 100%)" radius="0.25rem" />
              <SkeletonBar height={12} width="min(28rem, 80%)" radius="0.25rem" />
            </div>
          </div>
          <div className={styles.agencyMeta}>
            <SkeletonBar height={10} width={110} radius="0.25rem" />
            <div style={{ marginTop: '0.375rem' }}>
              <SkeletonBar height={14} width={150} radius="0.25rem" />
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <SkeletonBar height={42} width={188} radius="0.5rem" />
            </div>
          </div>
        </header>

        <ol className={styles.steps}>
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className={styles.step}>
              <div className={styles.stepLink}>
                <SkeletonBar height={10} width={20} radius="0.25rem" />
                <SkeletonBar height={11} width="80%" radius="0.25rem" />
              </div>
            </li>
          ))}
        </ol>

        <div className={styles.body}>
          {[0, 1].map((s) => (
            <section key={s} className={styles.section}>
              <div className={styles.sectionHead}>
                <SkeletonBar height={17} width={264} radius="0.25rem" />
                <SkeletonBar height={12} width={168} radius="0.25rem" />
              </div>
              <div
                style={{
                  display: 'grid',
                  gap: '0.875rem',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                }}
              >
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} style={{ display: 'grid', gap: '0.375rem' }}>
                    <SkeletonBar height={11} width={i % 2 ? 72 : 104} radius="0.25rem" />
                    <SkeletonBar height={36} radius="0.5rem" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            <SkeletonBar height={34} width={96} radius="0.5rem" />
            <SkeletonBar height={11} width={260} radius="0.25rem" />
          </div>
          <div className={styles.footerRight}>
            <SkeletonBar height={34} width={104} radius="0.5rem" />
            <SkeletonBar height={34} width={216} radius="0.5rem" />
          </div>
        </footer>
      </div>
    </div>
  );
}
