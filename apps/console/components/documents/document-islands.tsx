'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { deleteDocumentAction, retryDocumentAction } from '@/lib/document-actions';
import styles from './documents.module.css';

/**
 * The documents list's small islands (ADR 0053). Each is drawn only when a `may…` flag from
 * can() says so; each action asks again on the server.
 */

export function DocumentRowActions({ id, title, mayDelete, failed }: { id: string; title: string; mayDelete: boolean; failed: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!mayDelete) return null;

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  return (
    <span className={styles.actions}>
      {failed ? (
        <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => run(() => retryDocumentAction(id))}>
          Try again
        </button>
      ) : null}
      <button
        type="button"
        className={styles.danger}
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Delete “${title}”? The file is removed and the assistant can no longer read it.`)) run(() => deleteDocumentAction(id));
        }}
      >
        Delete
      </button>
      {error ? <span className={styles.failNote} role="alert">{error}</span> : null}
    </span>
  );
}

/** How often, and for how long, a list with a document still being read asks the server again. */
const EVERY_MS = 8_000;
const FOR_MS = 5 * 60_000;

/**
 * While something on the list is still being read, refresh it now and then so "Reading…" turns
 * into "Ready" without a reload — for five minutes at most (the tick runs every five), and only
 * while the tab is visible. A server refresh, never a polled Server Action (ARCHITECTURE § 3).
 */
export function RefreshWhileReading({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > FOR_MS) return clearInterval(timer);
      if (document.visibilityState === 'visible') router.refresh();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
