'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '../../components/icons';
import styles from './chat.module.css';

export type ThreadRow = { id: string; title: string; lastMessageAt: string };

/**
 * New chat, and the door into History.
 *
 * History is its own screen (`/chat?history=1`), not a menu. A dropdown
 * drawn over the hero had the headline showing through it, and a past
 * chat was a one-line toast with no room to actually open.
 */
export function ChatToolbar({
  count,
  historyOpen,
  loadedThread,
  activeTitle,
  onFresh,
}: {
  count: number;
  historyOpen: boolean;
  /** This view was opened from `?thread=`, so New chat is a real navigation. */
  loadedThread: boolean;
  /** Title of the conversation on screen, once one is open. */
  activeTitle: string | null;
  /**
   * Clear the draft when New chat does not change the URL.
   *
   * A conversation started on `/chat` has no query the router knows about,
   * so pushing `/chat` again is a no-op and the turns would stay.
   */
  onFresh: () => void;
}) {
  const router = useRouter();
  const onNewChat = historyOpen || !activeTitle;

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarRow}>
        <Link
          href="/chat?history=1"
          className={`${styles.toolbarBtn} ${historyOpen ? styles.toolbarBtnActive : ''}`}
          aria-current={historyOpen ? 'page' : undefined}
        >
          <Icon name="history" className={styles.toolbarIcon} />
          History
          {count > 0 ? <span className={styles.toolbarCount}>{count}</span> : null}
        </Link>

        <Link
          href="/chat"
          className={`${styles.toolbarBtn} ${onNewChat && !historyOpen ? styles.toolbarBtnActive : ''}`}
          onClick={(event) => {
            event.preventDefault();
            if (historyOpen || loadedThread) {
              router.push('/chat');
              return;
            }
            onFresh();
          }}
        >
          <span aria-hidden>＋</span> New chat
        </Link>
      </div>

      {!historyOpen && activeTitle ? (
        <p className={styles.toolbarCurrent} title={activeTitle}>
          {activeTitle}
        </p>
      ) : null}
    </div>
  );
}
