'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { acceptScheduleDraftAction } from './schedule-actions';
import styles from './chat.module.css';
import { Spinner } from '../../components/spinner';

/**
 * The confirmation card.
 *
 * Nothing has been saved when this renders. The guide proposed a schedule,
 * the server signed it, and this shows what the row will contain — the
 * search and the frequency are the SERVER's words, built from the draft
 * that will actually be stored, not the model's account of what it did.
 * Pressing Accept sends the signed token back and that is the first moment
 * anything is written.
 */
export function ScheduleCard({
  token,
  search,
  cadence,
  searchPath,
  signedIn,
}: {
  token: string;
  search: string;
  cadence: string;
  searchPath: string;
  signedIn: boolean;
}) {
  const [state, setState] = useState<'idle' | 'accepted' | 'dismissed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (state === 'dismissed') {
    return (
      <div className={styles.schedQuiet}>
        Not scheduled. Tell the guide a different time and it will offer again.
      </div>
    );
  }

  if (state === 'accepted') {
    return (
      <div className={styles.schedDone}>
        <p className={styles.schedDoneTitle}>Scheduled</p>
        <p className={styles.schedDoneMeta}>{cadence}</p>
        <Link href="/alerts" className={styles.schedOff}>
          Turn off
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.sched}>
      <p className={styles.schedTitle}>Start this schedule?</p>
      <p className={styles.schedHint}>Nothing is saved until you accept.</p>

      <dl className={styles.schedList}>
        <div className={styles.schedRow}>
          <dt className={styles.schedTerm}>Search</dt>
          <dd className={styles.schedValue}>
            {search}{' '}
            <Link href={searchPath} target="_blank" rel="noopener" className={styles.schedView}>
              view
            </Link>
          </dd>
        </div>
        <div className={styles.schedRow}>
          <dt className={styles.schedTerm}>Timer</dt>
          <dd className={styles.schedValue}>
            <span className={styles.schedChip}>{cadence}</span>
          </dd>
        </div>
        <div className={styles.schedRow}>
          <dt className={styles.schedTerm}>Email</dt>
          <dd className={styles.schedValueMuted}>
            Only when something new matches. One-click unsubscribe on every one.
          </dd>
        </div>
      </dl>

      {error ? (
        <p role="alert" className={styles.schedError}>
          {error}
        </p>
      ) : null}

      <div className={styles.schedActions}>
        {signedIn ? (
          <button
            type="button"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await acceptScheduleDraftAction(token);
                if (result.ok) setState('accepted');
                else setError(result.error);
              });
            }}
            className={styles.schedPrimary}
          >
            {pending ? (
              <>
                <Spinner /> Starting…
              </>
            ) : (
              'Accept'
            )}
          </button>
        ) : (
          /*
           * The token binds the search and the frequency, not a person — so
           * signing in and coming back does not invalidate it. The card is
           * gone after the round trip, though, which is why this says what
           * it says rather than pretending the state survives.
           */
          <Link href="/login?next=/chat" className={styles.schedPrimary}>
            Sign in to start it
          </Link>
        )}

        <button type="button" onClick={() => setState('dismissed')} className={styles.schedGhost}>
          Not now
        </button>
      </div>
    </div>
  );
}
