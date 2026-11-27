'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { notify, useNotice } from '../lib/saved-homes';
import styles from './shortlist-heart.module.css';

/**
 * The one place a save, a removal or its failure is said (ADR 0100), mounted once by WebShell. The live region
 * is always in the page, so a screen reader hears each notice. It goes after five seconds (seven for an
 * error), and waits while the pointer or focus is on it, so Undo is never snatched away mid-reach.
 */
export function SavedToast() {
  const n = useNotice();
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!n || held) return;
    const t = setTimeout(() => notify(null), n.tone === 'error' ? 7000 : 5000);
    return () => clearTimeout(t);
  }, [n, held]);

  const close = () => {
    setHeld(false);
    notify(null);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      {n ? (
        <div
          key={n.key}
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
          className={`${styles.toast} pointer-events-auto flex w-max max-w-[min(36rem,100%)] items-center gap-3 rounded-full py-2 pl-4 pr-2 text-body-sm text-white shadow-raised ${n.tone === 'error' ? 'bg-alert' : 'bg-ink'}`}
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4 shrink-0"
            aria-hidden
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {n.tone === 'error' ? (
              <path d="M12 8v5m0 3.5v.01" />
            ) : (
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            )}
          </svg>
          <span className="min-w-0">{n.text}</span>
          {n.action ? (
            'href' in n.action ? (
              <Link
                href={n.action.href}
                onClick={close}
                className="shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 font-[inherit] font-semibold text-white underline underline-offset-2 hover:bg-white/10"
              >
                {n.action.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => {
                  const run = (n.action as { run: () => void }).run;
                  close();
                  run();
                }}
                className="shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 font-[inherit] font-semibold text-white underline underline-offset-2 hover:bg-white/10"
              >
                {n.action.label}
              </button>
            )
          ) : null}
          <button
            type="button"
            onClick={close}
            aria-label="Dismiss"
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-white hover:bg-white/10"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              aria-hidden
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
