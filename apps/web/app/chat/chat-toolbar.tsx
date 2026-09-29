'use client';

import styles from './chat.module.css';

export type ThreadRow = { id: string; title: string; lastMessageAt: string };

/**
 * The bar above the conversation.
 *
 * It used to be the only way to reach History, so it carried a link to that
 * screen and a count. The rail carries both now, permanently, so what is
 * left here is what belongs to the conversation on screen: what it is
 * called, a way to start another one, and — on a phone, where the rail is a
 * drawer — the handle that pulls the rail out.
 */
export function ChatToolbar({
  count,
  historyOpen,
  activeTitle,
  onNewChat,
  onOpenRail,
}: {
  count: number;
  historyOpen: boolean;
  /** Title of the conversation on screen, once one is open. */
  activeTitle: string | null;
  /**
   * Start a fresh conversation.
   *
   * Owned by ChatView rather than decided here, because the rail offers the
   * same action and "New chat" has to mean one thing: sometimes a
   * navigation, sometimes just clearing the turns in place, and only the
   * view knows which. See `startNew` there.
   */
  onNewChat: () => void;
  /** Open the drawer. Below 1024px only — above it the rail is always there. */
  onOpenRail: () => void;
}) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarRow}>
        <button
          type="button"
          className={styles.toolbarRailBtn}
          onClick={onOpenRail}
          aria-label={count > 0 ? `Your conversations (${count})` : 'Your conversations'}
        >
          {/* Three rules, which is the one shape everybody already reads as
              "there is a panel over here". */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 7h16M4 12h16M4 17h10"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          Chats
          {count > 0 ? <span className={styles.toolbarCount}>{count}</span> : null}
        </button>

        {/*
          The title sits between the two controls and takes whatever width is
          left, so a long one truncates instead of pushing New chat off the
          row. `title` so the whole thing is still readable on hover.
        */}
        {!historyOpen && activeTitle ? (
          <p className={styles.toolbarCurrent} title={activeTitle}>
            {activeTitle}
          </p>
        ) : (
          <span className={styles.toolbarSpacer} aria-hidden />
        )}

        <button
          type="button"
          className={styles.toolbarNew}
          onClick={onNewChat}
        >
          <span aria-hidden>＋</span> New chat
        </button>
      </div>
    </div>
  );
}
