import styles from './spinner.module.css';

/**
 * A circle that turns while the server is being asked something.
 *
 * Indeterminate because a round trip has no percentage to report. Circular
 * because that is what a spinner is: a bar implies progress along a length,
 * and there is no length here.
 */
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <span className={styles.ring} aria-hidden />
      <span className={styles.label}>{label}</span>
    </div>
  );
}
