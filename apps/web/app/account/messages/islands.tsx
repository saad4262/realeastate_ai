'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markReadAction, replyAction, syncMailAction } from './actions';
import styles from './messages.module.css';

/**
 * The buyer's reply box (docs/adr/0016). What they write goes into the same
 * conversation the agency sees in its inbox, and the agency is emailed. The
 * text is cleared only once the server has recorded it.
 */
export function ReplyBox({ threadId, agencyName }: { threadId: string; agencyName: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function submit() {
    if (!body.trim()) {
      setError('Write a message first');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await replyAction(threadId, body);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody('');
      setSent(true);
      router.refresh();
    });
  }

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className={styles.composerLabel} htmlFor={`reply-${threadId}`}>
        Reply to {agencyName}
      </label>
      <textarea
        id={`reply-${threadId}`}
        className={styles.textarea}
        value={body}
        maxLength={20_000}
        disabled={pending}
        placeholder="Write your reply…"
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          setBody(event.target.value);
          setSent(false);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className={styles.composerFoot}>
        <button type="submit" className={styles.button} disabled={pending}>
          {pending ? 'Sending…' : 'Send'}
        </button>
        {error ? (
          <span className={styles.composerError} role="alert">
            {error}
          </span>
        ) : sent ? (
          <span className={styles.composerNote} role="status">
            Sent — {agencyName} has been emailed.
          </span>
        ) : (
          <span className={styles.composerNote}>You can also just reply to their email.</span>
        )}
      </div>
    </form>
  );
}

/** Pulls new mail while the page is open, refreshing only when something arrived. */
export function MailSync() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const pull = () => {
      if (document.visibilityState !== 'visible') return;
      void syncMailAction()
        .then((r) => {
          if (!stopped && r.stored > 0) router.refresh();
        })
        .catch(() => {});
    };
    pull();
    const timer = setInterval(pull, 20_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [router]);
  return null;
}

/** Marks the open conversation read once it is on screen (ADR 0035 §2). Renders nothing. */
export function MarkSeen({ threadId }: { threadId: string }) {
  useEffect(() => {
    void markReadAction(threadId);
  }, [threadId]);
  return null;
}
