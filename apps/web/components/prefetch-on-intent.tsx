'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/** Long enough that sweeping the pointer across a grid prefetches nothing. */
const INTENT_MS = 100;

/**
 * Warms a listing page when the visitor looks like they are about to open it.
 *
 * Listing cards carry prefetch={false}, and that is right: a results page
 * holds up to 48 of them, and Next's default would fire a request for every
 * card that scrolled into view. But the cost of that decision was a click with
 * no warm cache behind it, so opening a listing was always a cold round trip.
 *
 * Hover is the signal. This is the one place a manual router.prefetch() earns
 * its keep — it is driven by something the visitor did, not by a component
 * mounting. The console shells used to prefetch twelve routes on mount and
 * that is exactly the anti-pattern this is not.
 *
 * One listener for the whole grid rather than a handler per card. React
 * delegates events anyway, and the important part is that the cards stay
 * Server Components: they are passed straight through as children, so nothing
 * about a card's markup enters the browser bundle to get this behaviour.
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

  /**
   * There is deliberately no mouse-out handler.
   *
   * onMouseOver/onMouseOut fire on every element boundary, not just the card's
   * — moving from a card's thumbnail to its price is an out and an in. Cancel
   * on out and the countdown restarts each time the pointer crosses an inner
   * element, so a slow drag across one card would never prefetch it at all.
   *
   * Instead a single timer is reset by whatever the pointer reaches NEXT. A
   * fast sweep across the grid therefore fires at most one prefetch: the card
   * the pointer stopped on. Leaving the grid entirely costs one prefetch of
   * the last card touched, which is a fair price for not needing to reason
   * about relatedTarget.
   */
  const arm = useCallback(
    (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest('a[href]') : null;
      const href = el?.getAttribute('href');
      // Internal links only. An absolute URL or a hash is not ours to
      // prefetch, and the router would reject it anyway.
      if (!href || !href.startsWith('/')) return;
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
