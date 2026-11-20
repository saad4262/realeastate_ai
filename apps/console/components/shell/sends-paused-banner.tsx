'use client';

import { useState, useTransition } from 'react';
import { resumeSendsAction } from '../../lib/safety-actions';
import styles from './console-shell.module.css';

/**
 * PLATFORM-PLAN 3.7: the agency's texts, bulk email and AI call-backs are on hold. Everyone sees why; the
 * Resume button only for whoever can('sends:resume') allowed (decided on the server, checked again there).
 */
export function SendsPausedBanner({ reason, mayResume }: { reason: string | null; mayResume: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.pausedBanner} role="alert">
      <span className={styles.glyph} aria-hidden>
        pause_circle
      </span>
      <div className={styles.pausedText}>
        <strong>Sends are paused.</strong> {reason ? `${reason} ` : ''}Texts, bulk email and AI call-backs are on hold
        {mayResume ? '. Check the activity, then resume when it looks right.' : ' until an owner or admin resumes them.'}
        {error ? <span className={styles.pausedError}> {error}</span> : null}
      </div>
      {mayResume ? (
        <button
          type="button"
          className={styles.pausedButton}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await resumeSendsAction();
              setError(r.ok ? null : (r.error ?? 'Could not resume sends.'));
            })
          }
        >
          {pending ? 'Resuming…' : 'Resume sends'}
        </button>
      ) : null}
    </div>
  );
}
