'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/** Long enough that sweeping the pointer across a grid prefetches nothing. */
const INTENT_MS = 100;

/**
 * Warms a card's page when the person looks about to open it — the Projects
 * grid here.
 *
 * A copy of apps/web's island of the same name (ARCHITECTURE.md § 3). Not
 * shared through packages/ui because that package has no `next` dependency on
 * purpose, and this is nothing but router glue.
 *
 * The cards carry prefetch={false}: Next's default would fire a request for
 * every card that scrolls into view, each through middleware's auth check.
 * Hover (or focus) is the signal instead; one listener for the whole grid, so
 * the cards stay Server Components.
 *
 * There is deliberately no mouse-out handler: a single timer is reset by
 * whatever the pointer reaches next, so a fast sweep fires at most one
 * prefetch — the card the pointer stopped on.
 */
export function PrefetchOnIntent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  /** Hrefs already asked for. Prefetching twice is wasted, not wrong. */
  const warmed = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The href currently counting down, so re-entry does not restart it. */
  const pending = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const arm = useCallback(
    (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest('a[href]') : null;
      const href = el?.getAttribute('href');
      // Internal links only. An absolute URL or a hash is not ours to
      // prefetch, and the router would reject it anyway.
      if (!href || !href.startsWith('/')) return;
      // A new-tab link would be fetched again in the tab it opens (ARCHITECTURE.md § 3).
      if (el?.getAttribute('target') === '_blank') return;
      if (warmed.current.has(href) || pending.current === href) return;

      if (timer.current) clearTimeout(timer.current);
      pending.current = href;
      timer.current = setTimeout(() => {
        warmed.current.add(href);
        pending.current = null;
        router.prefetch(href);
      }, INTENT_MS);
    },
    [router],
  );

  return (
    <div
      className={className}
      onMouseOver={(e) => arm(e.target)}
      // Keyboard users get the same warm cache: tabbing onto a card is the
      // same statement of intent as hovering one.
      onFocus={(e) => arm(e.target)}
    >
      {children}
    </div>
  );
}
