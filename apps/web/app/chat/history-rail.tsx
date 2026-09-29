'use client';

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Icon } from '../../components/icons';
import styles from './chat.module.css';
import type { ThreadRow } from './chat-toolbar';

/**
 * Past conversations, permanently on the left.
 *
 * ## Why a rail and not only the History screen
 *
 * `/chat?history=1` still exists and still works — it is where a
 * conversation gets deleted, and it is the whole screen on a phone. What it
 * could not be is a PLACE: getting to it meant leaving the conversation you
 * were in, and coming back meant leaving the list. On a desktop there is
 * room for both at once, so the list stopped being a destination and became
 * furniture.
 *
 * ## Why the grouping arrives as a prop
 *
 * Each row carries its own `group` label, computed on the server in
 * page.tsx. Working it out here instead would mean comparing
 * `lastMessageAt` against `Date.now()` during render — which runs once on
 * the server and again during hydration, in two different time zones. That
 * does not produce a wrong label so much as a DIFFERENT SET OF GROUPS
 * between the two passes, which is a structural hydration mismatch rather
 * than a text one, and React cannot patch over it. The relative time on each
 * row is still local and still `suppressHydrationWarning`, because that one
 * is only ever a text node.
 *
 * ## Why there is no delete button here
 *
 * `deleteThreadAction` redirects to the History screen when it is done,
 * which is right for the screen and wrong for a rail you are reading beside
 * an open chat. Rather than change what the action does, the rail links to
 * the screen and the screen keeps the destructive control. One place to
 * delete a thing is also simply better than two.
 *
 * ## Why this is memoised
 *
 * ChatView re-renders on every token of a streaming answer — dozens of times
 * a sentence — and none of them change this list. Without `memo` the rail
 * would reconcile its whole list on each one, which is the same shape of
 * problem the Composer's local draft state was moved to solve. It only pays
 * off while every prop is referentially stable, which is why `onClose` and
 * `onNewChat` are `useCallback`s over in ChatView rather than inline arrows.
 */
export const HistoryRail = memo(function HistoryRail({
  threads,
  signedIn,
  activeId,
  historyOpen,
  open,
  onClose,
  onNewChat,
  pendingHref,
  onOpen,
}: {
  threads: (ThreadRow & { group: string })[];
  signedIn: boolean;
  /** The thread the URL has open, so the rail can mark its own row. */
  activeId: string | null;
  /** True on `/chat?history=1` — the full-screen list is the active view. */
  historyOpen: boolean;
  /**
   * Drawer state, and MOBILE ONLY.
   *
   * Above 1024px the rail is part of the layout and this is ignored by the
   * stylesheet entirely, which is why it can default to `false` without the
   * rail vanishing on a desktop. A single "is it open" flag that meant both
   * things would have to be `true` on load for the desktop and `false` on
   * load for the phone, and the server cannot know which it is rendering
   * for.
   */
  open: boolean;
  onClose: () => void;
  /** Clear the draft in place — see the note on ChatToolbar's own handler. */
  onNewChat: () => void;
  /**
   * The row whose conversation is being fetched right now, or null.
   *
   * An href rather than a thread id, so the footer link to the history
   * screen can be in the same state without a second prop meaning the same
   * thing about a different kind of row.
   */
  pendingHref: string | null;
  /** Navigate inside a transition — see the note in ChatView. */
  onOpen: (href: string) => void;
}) {
  const [filter, setFilter] = useState('');

  /**
   * Open a row through the router instead of letting the anchor do it.
   *
   * These stay `<Link>`s — the href is real, middle-click and "open in new
   * tab" and a copied address all have to keep working, and an onClick on a
   * `<button>` would have thrown all of that away. So a plain left click is
   * the only one taken over: anything with a modifier on it is the visitor
   * asking the BROWSER for something, and the default is what does it.
   *
   * The handover is what buys the pending state. A Link navigates outside
   * any transition, so React never reports the wait and there is nothing to
   * draw a skeleton from; ChatView's `go` puts the same push inside
   * `startTransition`.
   */
  const openHref = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href: string) => {
      onClose();
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      onOpen(href);
    },
    [onClose, onOpen],
  );

  /**
   * Escape closes the drawer.
   *
   * A panel that covers the screen and can only be dismissed by finding a
   * particular × is a panel somebody gets stuck behind — and Escape is the
   * first thing a keyboard user tries, before they go looking. Bound only
   * while it is open, so the rest of the time there is no listener on the
   * document at all.
   *
   * `open` is the mobile drawer flag; above 1024px the rail is part of the
   * layout, `open` stays false, and this never binds.
   */
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /**
   * Filtering is local and titles-only, on a list that is already here.
   *
   * `listThreads` has a cap and the rail renders whatever it returned, so
   * this narrows what is on screen rather than searching the archive. It is
   * worth having anyway: the rail's job is to get you back to one specific
   * conversation, and by the tenth one the title is faster to type than to
   * find.
   */
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? threads.filter((thread) => thread.title.toLowerCase().includes(needle))
      : threads;

    // Insertion order, so the groups come out in the order the server put
    // the rows in — newest first — without this file knowing their names.
    const bucketed = new Map<string, (ThreadRow & { group: string })[]>();
    for (const thread of matching) {
      const bucket = bucketed.get(thread.group);
      if (bucket) bucket.push(thread);
      else bucketed.set(thread.group, [thread]);
    }
    return [...bucketed];
  }, [filter, threads]);

  return (
    <>
      {/*
        The scrim. Rendered only while the drawer is open, and only visible
        below 1024px — above it the rail is in the layout and has nothing to
        sit on top of. A click anywhere on it closes, which is the gesture
        people try before they look for the ×.
      */}
      {open ? (
        <button
          type="button"
          className={styles.railScrim}
          aria-label="Close conversations"
          onClick={onClose}
        />
      ) : null}

      <aside
        className={`${styles.rail} ${open ? styles.railOpen : ''}`}
        aria-label="Your conversations"
      >
        <div className={styles.railHead}>
          <button
            type="button"
            className={styles.railNew}
            onClick={() => {
              onNewChat();
              onClose();
            }}
          >
            <span aria-hidden>＋</span> New chat
          </button>

          {/*
            Only reachable on a phone, where the rail is a drawer over the
            conversation. On a desktop there is nothing to close it back to.
          */}
          <button
            type="button"
            className={styles.railClose}
            aria-label="Close conversations"
            onClick={onClose}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>

        {/* Below two, the box is furniture in the way of the list. */}
        {threads.length > 2 ? (
          <div className={styles.railSearch}>
            <Icon name="history" className={styles.railSearchIcon} />
            <input
              type="search"
              className={styles.railSearchInput}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search conversations"
              aria-label="Filter your conversations by title"
            />
          </div>
        ) : null}

        <div className={styles.railList}>
          {!signedIn ? (
            <div className={styles.railNote}>
              <p className={styles.railNoteTitle}>Chats are not being saved</p>
              <p className={styles.railNoteBody}>
                An anonymous conversation stays in this tab only. Sign in and it is kept
                for 90 days, on any device.
              </p>
              <Link
                href={`/login?next=${encodeURIComponent('/chat')}`}
                className={styles.railNoteLink}
              >
                Sign in
              </Link>
            </div>
          ) : threads.length === 0 ? (
            <div className={styles.railNote}>
              <p className={styles.railNoteTitle}>No conversations yet</p>
              <p className={styles.railNoteBody}>
                Ask the guide something and it will show up here.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <p className={styles.railNoneMatch}>No conversation matches “{filter.trim()}”.</p>
          ) : (
            groups.map(([label, rows]) => (
              <section key={label} className={styles.railGroup}>
                <h2 className={styles.railGroupLabel}>{label}</h2>
                <ul className={styles.railItems}>
                  {rows.map((thread) => {
                    const href = `/chat?thread=${thread.id}`;
                    const active = !historyOpen && thread.id === activeId;
                    /*
                      The row takes the active treatment the moment it is
                      clicked, before the server has confirmed anything. A
                      click that leaves no mark for two seconds is a click
                      people make twice.
                    */
                    const opening = pendingHref === href;
                    return (
                      <li key={thread.id}>
                        <Link
                          href={href}
                          className={`${styles.railItem} ${
                            active || opening ? styles.railItemActive : ''
                          } ${opening ? styles.railItemOpening : ''}`}
                          aria-current={active ? 'page' : undefined}
                          aria-busy={opening || undefined}
                          onClick={(event) => openHref(event, href)}
                          /*
                            /chat is force-dynamic, so prefetching every row
                            in the rail would server-render one guide per
                            conversation the moment the rail painted.
                          */
                          prefetch={false}
                        >
                          <span className={styles.railItemTitle}>{thread.title}</span>
                          <time
                            className={styles.railItemWhen}
                            dateTime={thread.lastMessageAt}
                            suppressHydrationWarning
                          >
                            {shortWhen(thread.lastMessageAt)}
                          </time>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className={styles.railFoot}>
          <Link
            href="/chat?history=1"
            className={`${styles.railFootLink} ${
              historyOpen || pendingHref === '/chat?history=1' ? styles.railFootLinkActive : ''
            }`}
            aria-current={historyOpen ? 'page' : undefined}
            aria-busy={pendingHref === '/chat?history=1' || undefined}
            onClick={(event) => openHref(event, '/chat?history=1')}
            prefetch={false}
          >
            All conversations
            {threads.length > 0 ? (
              <span className={styles.railFootCount}>{threads.length}</span>
            ) : null}
          </Link>
        </div>
      </aside>
    </>
  );
});

/**
 * A time for a row that is one line tall.
 *
 * Deliberately shorter than the History screen's version: that list has a
 * column to itself and can say "24 Sept", this has whatever is left after
 * the title. Local to the reader's browser, which is why the element that
 * holds it is marked `suppressHydrationWarning` — the server renders this
 * in its own zone first.
 */
function shortWhen(iso: string): string {
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
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' }),
  });
}
