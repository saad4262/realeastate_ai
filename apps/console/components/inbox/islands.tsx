'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useLinkStatus } from 'next/link';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { markThreadReadAction, retryMessageAction, sendFromPlatformAction, syncMailAction } from '@/lib/mail-actions';
import styles from './inbox.module.css';

/**
 * Marks the open thread read, once it is actually on screen.
 *
 * Not done in the page render: Next may prefetch a thread link, and a prefetch
 * must not mark read a conversation nobody looked at. Renders nothing. Only
 * refreshes — to clear the bold row and the nav badge — when the thread was
 * unread, so opening a read thread costs no second round trip.
 */
export function MarkRead({ threadId, unread }: { threadId: string; unread: boolean }) {
  const router = useRouter();
  const done = useRef<string | null>(null);

  useEffect(() => {
    if (done.current === threadId) return;
    done.current = threadId;
    void markThreadReadAction(threadId).then((result) => {
      if (result.ok && unread) router.refresh();
    });
  }, [threadId, unread, router]);

  return null;
}

/** "Send again" on a message the provider refused — or, after a Gmail failure, from the platform address. */
export function RetrySend({ messageId, platform = false }: { messageId: string; platform?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className={styles.retry}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = platform ? await sendFromPlatformAction(messageId) : await retryMessageAction(messageId);
          if (!result.ok) {
            toast({ variant: 'error', title: 'Not sent', description: result.error });
            return;
          }
          toast(
            result.status === 'sent'
              ? { variant: 'success', title: 'Sent' }
              : { variant: 'error', title: 'Still not sent', description: result.error ?? undefined },
          );
          router.refresh();
        })
      }
    >
      {pending ? 'Sending…' : platform ? 'Send from the platform address instead' : 'Send again'}
    </button>
  );
}

/**
 * A spinner inside its own Link while that Link navigates — /team's pattern.
 * Opening a thread keeps the list on screen; this says the click registered.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <span className={styles.spinner} role="status" aria-label="Loading" />;
}

/**
 * Keeps the inbox current while it is open: asks the server to pull new mail
 * on arrival and every 20 s while the tab is visible, and refreshes only when
 * something new was stored. Renders nothing.
 */
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
        .catch(() => {
          // A failed pull is retried on the next tick; nothing to show.
        });
    };
    pull();
    const timer = setInterval(pull, 20_000);
    document.addEventListener('visibilitychange', pull);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', pull);
    };
  }, [router]);

  return null;
}
