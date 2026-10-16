'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

/**
 * A link to the assistant home (`home`, `home?c=…` — /overview or /assistant).
 *
 * Already on the home, which conversation is open is only `?c=` — the page's
 * server half does not read it. So the URL is changed in place with
 * pushState, which Next syncs into useSearchParams: the conversation switches
 * with the one server action that loads it, and no page render behind it.
 * From anywhere else it is an ordinary client navigation.
 *
 * Modified clicks (new tab, new window) are left to the browser.
 */
export function HomeLink({
  home,
  href,
  className,
  title,
  prefetch,
  children,
  ...aria
}: {
  /** This console's assistant home; a click there changes the URL in place. */
  home: string;
  href: string;
  className?: string;
  title?: string;
  prefetch?: boolean;
  children: ReactNode;
  'aria-current'?: 'page';
}) {
  const pathname = usePathname();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (pathname !== home || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.pushState(null, '', href);
  };
  return (
    <Link href={href} className={className} title={title} onClick={onClick} {...(prefetch === false ? { prefetch: false } : {})} {...aria}>
      {children}
    </Link>
  );
}
