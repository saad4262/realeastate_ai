import styles from './wizard.module.css';

/** One line under an input, in the rose error variant. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className={styles.fieldError} role="alert">
      <span className={styles.glyphSm} aria-hidden>
        error
      </span>
      {message}
    </p>
  );
}
