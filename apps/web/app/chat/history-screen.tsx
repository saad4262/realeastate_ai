'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Spinner } from '../../components/spinner';
import styles from './chat.module.css';
import { deleteThreadAction } from './thread-actions';
import type { ThreadRow } from './chat-toolbar';

/**
 * Past conversations, as their own screen.
 *
 * This used to be a dropdown parked on top of the hero. The headline showed
 * through it, the row looked like a toast, and the × read as "close" rather
 * than "delete" — so there was no obvious way to open a chat, and clicking
 * one often left you on the empty page anyway.
 */
export function HistoryScreen({
  threads,
  signedIn,
  activeId,
}: {
  threads: ThreadRow[];
  signedIn: boolean;
  activeId: string | null;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className={styles.history}>
      <header className={styles.historyHead}>
        <h1 className={styles.historyTitle}>History</h1>
        <p className={styles.historySub}>
          {signedIn
            ? 'Open a chat to pick it up where you left it. Each one is kept for 90 days.'
            : 'Sign in and every conversation here is kept for 90 days, on any device.'}
        </p>
      </header>

      {!signedIn ? (
        <div className={styles.historyEmpty}>
          <p className={styles.historyEmptyTitle}>Your chats are not being saved</p>
          <p>An anonymous conversation stays in this tab only. Sign in and it is kept.</p>
          <Link href={`/login?next=${encodeURIComponent('/chat?history=1')}`} className={styles.historyPrimary}>
            Sign in
          </Link>
        </div>
      ) : threads.length === 0 ? (
        <div className={styles.historyEmpty}>
          <p className={styles.historyEmptyTitle}>Nothing here yet</p>
          <p>Ask the guide something and the conversation will show up in this list.</p>
          <Link href="/chat" className={styles.historyPrimary}>
            Start a chat
          </Link>
        </div>
      ) : (
        <ul className={styles.historyList}>
          {threads.map((thread) => {
            const active = thread.id === activeId;
            return (
              <li
                key={thread.id}
                className={`${styles.historyItem} ${active ? styles.historyItemActive : ''}`}
              >
                <Link
                  href={`/chat?thread=${thread.id}`}
                  className={styles.historyLink}
                  aria-current={active ? 'page' : undefined}
                  prefetch={false}
                >
                  <span className={styles.historyLinkTitle}>{thread.title}</span>
                  <span className={styles.historyLinkMeta}>
                    <time dateTime={thread.lastMessageAt} suppressHydrationWarning>
                      {formatWhen(thread.lastMessageAt)}
                    </time>
                    <span className={styles.historyOpen}>{active ? 'Open now' : 'Open'}</span>
                  </span>
                </Link>

                {confirming === thread.id ? (
                  <button
                    type="button"
                    disabled={pending}
                    aria-busy={pending}
                    className={styles.historyDeleteConfirm}
                    onClick={() =>
                      startTransition(async () => {
                        await deleteThreadAction(thread.id);
                        setConfirming(null);
                      })
                    }
                  >
                    {/* This one navigates when it finishes, so the wait is
                        the whole of the feedback until the page changes. */}
                    {pending ? (
                      <>
                        <Spinner /> Deleting…
                      </>
                    ) : (
                      'Delete'
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.historyDelete}
                    aria-label={`Delete conversation: ${thread.title}`}
                    onClick={() => setConfirming(thread.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatWhen(iso: string): string {
  const when = new Date(iso);
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();

  if (sameDay) {
    return when.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  }

  return when.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
