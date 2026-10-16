'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { HomeLink } from './home-link';
import styles from './console-shell.module.css';

const SHOWN = 6;

/**
 * The sidebar's Recents. A client island for two reasons only: the open
 * conversation is `?c=` on the home page, which a layout cannot see on the
 * server (§ usePathname), and "Show all" is this list's own ephemeral state.
 *
 * Not prefetched. This list is on every agency page, up to twenty links long,
 * and each prefetch is a request through middleware's auth check — for a page
 * whose server half does not even read `?c=`. On the home itself a click
 * costs no page request at all (HomeLink).
 */
export function RecentsList({ home, rows }: { home: string; rows: { id: string; title: string }[] }) {
  const pathname = usePathname();
  const open = useSearchParams().get('c');
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);

  return (
    <div className={styles.recents}>
      <div className={styles.sectionLabel}>Recents</div>
      {rows.length === 0 ? (
        <p className={styles.recentsEmpty}>Your conversations with the assistant show here.</p>
      ) : (
        <ul className={`${styles.recentList} ${all ? styles.recentListAll : ''}`}>
          {shown.map((r) => {
            const active = pathname === home && open === r.id;
            return (
              <li key={r.id}>
                <HomeLink
                  home={home}
                  href={`${home}?c=${r.id}`}
                  prefetch={false}
                  className={active ? `${styles.recent} ${styles.recentActive}` : styles.recent}
                  aria-current={active ? 'page' : undefined}
                  title={r.title}
                >
                  {r.title}
                </HomeLink>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > SHOWN ? (
        <button type="button" className={styles.recentsToggle} onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all (${rows.length})`}
        </button>
      ) : null}
    </div>
  );
}
