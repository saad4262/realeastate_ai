'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './admin.module.css';

/**
 * The tabs inside an agency or a member (ADR 0049). A client island only
 * because a layout does not re-render on navigation, so the active tab has to
 * come from usePathname — the same reason the console nav is one.
 */
export function AdminTabs({ items, label }: { items: { href: string; label: string }[]; label: string }) {
  const pathname = usePathname();
  // The longest href the path sits under: /agencies/x/agents/y lights the member's tab, not "Agents".
  let active: string | null = null;
  for (const { href } of items) {
    if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > (active?.length ?? 0)) active = href;
  }
  return (
    <nav className={styles.tabs} aria-label={label}>
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={t.href === active ? styles.tabOn : styles.tab}
          aria-current={t.href === active ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
