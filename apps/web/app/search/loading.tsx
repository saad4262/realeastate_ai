import { AppShell } from '@repo/ui';
import { CardGridSkeleton, SearchBarSkeleton, Bar } from '../../components/skeletons';
import styles from '../home.module.css';

/**
 * Only ever seen on a COLD arrival at /search — from the home page, or a
 * pasted link.
 *
 * Searching from the search page does not reach this: SearchBar pushes inside
 * a useTransition, and a transition suppresses loading.tsx by design. That is
 * the better behaviour there — the box stays on screen with its own spinner in
 * the button, and the keyed Suspense boundaries swap only the results. The two
 * mechanisms compose rather than compete.
 */
export default function SearchLoading() {
  return (
    <AppShell surface="web">
      <section className={styles.hero}>
        <h1 className={styles.title}>Search</h1>
        <p className={styles.sub}>
          <Bar w="18rem" h="1.0625rem" />
        </p>
        <SearchBarSkeleton />
      </section>
      <section className={styles.section}>
        <CardGridSkeleton count={6} />
      </section>
    </AppShell>
  );
}
