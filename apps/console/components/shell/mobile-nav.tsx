'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from './console-shell.module.css';

/**
 * PLATFORM-PLAN 4.6: on a phone the sidebar is a drawer. This button opens it; a page change, Escape or a tap on
 * the shade closes it. The state is an attribute on <html> so the server-rendered sidebar needs no client code.
 * Hidden from 768 px up, where the sidebar is always there.
 */
export function MobileNavButton() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    document.documentElement.dataset.nav = open ? 'open' : '';
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.menuBtn}
        aria-label={open ? 'Close the menu' : 'Open the menu'}
        aria-expanded={open}
        aria-controls="console-sidebar"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.glyph} aria-hidden>
          {open ? 'close' : 'menu'}
        </span>
      </button>
      {open ? <div className={styles.navShade} role="presentation" onClick={() => setOpen(false)} /> : null}
    </>
  );
}
