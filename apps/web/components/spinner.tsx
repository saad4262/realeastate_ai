import styles from './spinner.module.css';

/**
 * "Working on it", as one element.
 *
 * ## Why it is silent to a screen reader
 *
 * `aria-hidden`, always. A spinner is a picture of a wait, and a wait is
 * already announced properly by the control it belongs to: the button sets
 * `aria-busy` and its label changes from "Sign in" to "Signing in…", which
 * is read out. An icon that also announced itself would make every pending
 * button say the same thing twice.
 *
 * ## Why it is not a client component
 *
 * Nothing here runs. It is a `<span>` and a CSS animation, so it renders on
 * the server and ships no JavaScript of its own — which matters because the
 * places that need it most are the auth pages, whose whole design is that
 * they hydrate almost nothing.
 */
export function Spinner({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`${styles.spinner} ${className}`} />;
}
