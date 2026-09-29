'use client';

import { createContext, useContext, useMemo, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import styles from './sorting.module.css';

/**
 * Re-sorting is a refinement, not a new question.
 *
 * Sort used to be four plain <Link>s. They worked — the URL is the only copy
 * of the search, so writing to it is the only correct way to change one — but
 * they gave no sign of having been pressed. The server has to run the search
 * again, and for the ~400 ms that takes, the old order sat there looking like
 * a control that does nothing. Pressing it twice was the obvious next move,
 * and the second press is a whole second search.
 *
 * So the navigation moves into a transition and the pending flag is published
 * here, where the results can read it. Two things follow from that:
 *
 *   1. React keeps the current results on screen for the whole transition
 *      instead of blanking to search/loading.tsx, which is what made a sort
 *      read as a page reload.
 *   2. `Refreshing` can dim and shimmer the list it is about to replace, so
 *      the feedback is on the thing that changes rather than on the button.
 *
 * The other half of this lives in page.tsx, which deliberately leaves `sort`
 * out of the Suspense key: a keyed boundary throws its children away and shows
 * the skeleton, which is right when the visitor has asked a *different*
 * question and wrong here, where the same listings come back in another order.
 */
type Sorting = { pending: boolean; go: (href: string) => void };

const SortingContext = createContext<Sorting>({ pending: false, go: () => {} });

export function SortingProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const value = useMemo<Sorting>(
    () => ({
      pending,
      go: (href: string) =>
        start(() => {
          // scroll: false — a sort changes the order of what is already under
          // the cursor. Jumping to the top of the page throws away the
          // position the visitor was reading at, for no reason.
          router.push(href, { scroll: false });
        }),
    }),
    [pending, router],
  );

  return <SortingContext.Provider value={value}>{children}</SortingContext.Provider>;
}

type Option = { value: string; label: string; href: string };

/**
 * The sort control: real links, intercepted.
 *
 * Still <a href> rather than a button, because the href is the whole search
 * and it has to survive middle-click, "open in new tab", and JavaScript never
 * arriving — which is the path taken when the handler below does not run.
 * next/link would add prefetching of four full search pages nobody asked for.
 */
export function SortBar({ options, current }: { options: Option[]; current: string }) {
  const { pending, go } = useContext(SortingContext);

  return (
    <div className={styles.bar} role="group" aria-label="Sort results">
      <span className="text-label-md uppercase text-ink-faint">Sort by</span>
      {options.map((option) => {
        const on = option.value === current;
        return (
          <a
            key={option.value || 'default'}
            href={option.href}
            aria-current={on ? 'true' : undefined}
            aria-disabled={pending || undefined}
            className={on ? `${styles.option} ${styles.optionOn}` : styles.option}
            onClick={(event) => {
              // Anything that is not a plain left click is the browser's to
              // handle: a new tab is a second search, not this one.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              // Already the current order. Re-running the search to get the
              // same rows back is the double-press this component exists to
              // stop being invisible.
              if (on) return;
              go(option.href);
            }}
          >
            {option.label}
          </a>
        );
      })}
    </div>
  );
}

/**
 * The region that is about to be replaced, while it is being replaced.
 *
 * Takes server-rendered children and only adds a class, so the results stay a
 * server component — nothing about the listings becomes client state. Pointer
 * events are off for the duration, which is what stops a click landing on the
 * row that used to be in that position.
 */
export function Refreshing({ children }: { children: ReactNode }) {
  const { pending } = useContext(SortingContext);

  return (
    <div className={pending ? styles.refreshing : undefined} aria-busy={pending}>
      {children}
    </div>
  );
}
