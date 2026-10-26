'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { resolveOpportunityAction } from '@/lib/opportunity-actions';
import styles from './opportunities.module.css';

/** Done and Dismiss — the panel's only client code (ADR 0054 §6). The server re-checks whose it is. */
export function OpportunityButtons({ id }: { id: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(status: 'done' | 'dismissed') {
    setError(null);
    start(async () => {
      const result = await resolveOpportunityAction(id, status);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  return (
    <span className={styles.buttons}>
      <button type="button" className={styles.done} disabled={busy} onClick={() => run('done')}>
        Done
      </button>
      <button type="button" className={styles.dismiss} disabled={busy} onClick={() => run('dismissed')} title="Hide it. It comes back only if something new happens.">
        Dismiss
      </button>
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
