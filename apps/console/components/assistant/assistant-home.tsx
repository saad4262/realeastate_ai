'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clearPicks } from './picks';
import { EXAMPLES, TurnList, type Surface } from './assistant-panel';
import { useAssistant } from './use-assistant';
import styles from './assistant-home.module.css';

const CONTACT_ID = /^[0-9a-f-]{36}$/i;

/** The panel's examples that are something to type, as one-click prompts. */
const SUGGESTIONS = EXAMPLES.filter((e) => e.startsWith('“')).map((e) => e.replace(/[“”]/g, '').replace(/\s*\(.*\)$/, ''));

/**
 * The assistant home of both consoles (/overview, /assistant): the assistant
 * as the page, not a panel over it.
 *
 * Which conversation is open lives in the URL (`?c=`), so the sidebar's
 * Recents are plain links, Back works, and "New" is a link to this page with
 * no `c`. A conversation this page starts gets its id written into the URL
 * with replaceState once the server names it — no navigation, so the stream
 * in flight is not interrupted — and the layout is refreshed once the first
 * answer ends, which is what puts it into Recents.
 */
export function AssistantHome({
  surface,
  home,
  name,
  notices,
  below,
}: {
  surface: Surface;
  /** This page's own path — "start a new one" links here. */
  home: string;
  name: string | null;
  notices?: ReactNode;
  below?: ReactNode;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const c = params.get('c');
  // "Ask the assistant" on a contact's page (`?contact=`). Only a well-formed id is
  // passed on; the server still checks this person may see it, exactly as for the panel.
  const contact = params.get('contact');
  const contactId = contact && CONTACT_ID.test(contact) ? contact : null;
  const a = useAssistant({ contactId });
  const { picks, turns, conversationId, full, draft, setDraft, busy, useSelection, setUseSelection, endRef, send } = a;
  const [missing, setMissing] = useState(false);

  /** The conversation the URL last pointed at, so a URL change is told apart from a stream naming one. */
  const seen = useRef<string | null>(null);
  /** Set when this page started the conversation, until the sidebar has been refreshed for it. */
  const fresh = useRef(false);

  // URL → conversation. Keyed on `c` alone on purpose: the stream naming a new
  // conversation must not be read as "the URL lost its conversation".
  useEffect(() => {
    if (c === seen.current) return;
    seen.current = c;
    setMissing(false);
    if (c) {
      if (c === conversationId) return;
      a.stop();
      void a.openConversation(c).then((ok) => setMissing(ok === false));
    } else {
      a.startNew();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c]);

  // Conversation → URL, the first time the server names one this page started.
  useEffect(() => {
    if (!conversationId || conversationId === seen.current) return;
    seen.current = conversationId;
    fresh.current = true;
    window.history.replaceState(null, '', `?c=${conversationId}${contactId ? `&contact=${contactId}` : ''}`);
  }, [conversationId, contactId]);

  useEffect(() => {
    if (busy || !fresh.current) return;
    fresh.current = false;
    router.refresh();
  }, [busy, router]);
  // Leaving mid-answer: the server still finishes the turn, so Recents still needs the new conversation.
  useEffect(
    () => () => {
      if (fresh.current) router.refresh();
    },
    [router],
  );

  const started = turns.length > 0;

  const composer = (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {picks.length ? (
        <div className={styles.chip}>
          Using {picks.length} picked {picks.length === 1 ? 'contact' : 'contacts'}
          <button type="button" onClick={clearPicks} aria-label="Clear the picked contacts">
            ×
          </button>
        </div>
      ) : contactId && useSelection ? (
        <div className={styles.chip}>
          Using this contact
          <button type="button" onClick={() => setUseSelection(false)} aria-label="Don’t use this contact">
            ×
          </button>
        </div>
      ) : null}
      <textarea
        className={styles.input}
        value={draft}
        maxLength={2000}
        rows={2}
        placeholder={started ? 'Reply to the assistant…' : 'How can I help you today?'}
        aria-label="Ask the assistant"
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={full}
      />
      <div className={styles.composerFoot}>
        <span className={styles.hint}>Looks things up, and prepares actions for you to approve.</span>
        {busy ? (
          <button type="button" className={styles.send} onClick={a.stop} aria-label="Stop">
            <span className={styles.glyph} aria-hidden>
              stop
            </span>
          </button>
        ) : (
          <button type="submit" className={styles.send} disabled={!draft.trim() || full} aria-label="Send">
            <span className={styles.glyph} aria-hidden>
              arrow_upward
            </span>
          </button>
        )}
      </div>
    </form>
  );

  if (!started) {
    return (
      <div className={styles.home} data-full-bleed>
        <div className={styles.stage}>
          {notices}
          {missing ? (
            <p className={styles.note} role="status">
              That conversation is no longer available — they are kept for 30 days.
            </p>
          ) : null}
          <h1 className={styles.greeting}>
            <span className={`${styles.glyph} ${styles.mark}`} aria-hidden>
              auto_awesome
            </span>
            What’s on today{name ? `, ${name}` : ''}?
          </h1>
          {composer}
          <div className={styles.suggestions} aria-label="Suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className={styles.suggestion} onClick={() => setDraft(s)}>
                {s}
              </button>
            ))}
          </div>
          {below}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.home} ${styles.homeStarted}`} data-full-bleed>
      {/* Its own scroller: the shell's content area is a scroll container, so a sticky composer would not stick. */}
      <div className={styles.scroller}>
        <div className={styles.thread}>
          <TurnList turns={turns} surface={surface} />
          <div ref={endRef} />
        </div>
      </div>
      <div className={styles.dock}>
        {full ? (
          <p className={styles.note}>
            This conversation is full — <Link href={home}>start a new one</Link>.
          </p>
        ) : null}
        {composer}
      </div>
    </div>
  );
}
