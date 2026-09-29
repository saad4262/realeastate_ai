'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from 'react';
import styles from './home.module.css';
import { Spinner } from '../components/spinner';

/**
 * The first thing on the site: a box you talk into.
 *
 * ## Why this is a real input and not a link dressed up as one
 *
 * The obvious cheap version is an `<a href="/chat">` styled like a composer.
 * It looks identical until somebody types into it, which is the first thing
 * anybody does with a box that has a cursor in it — and then nothing happens
 * and the keystrokes are gone. So it takes the sentence here and carries it
 * across; `/chat` sends it on arrival.
 *
 * ## Why it does not cost `/` its cache
 *
 * `/` is the site's only statically rendered route (`revalidate = 300`,
 * measured at 33 ms) and the reason is that nothing in its tree reads a
 * cookie. This component reads no session and asks no question of the
 * server — it is a form and a `router.push` — so the page stays static and
 * this ships as plain client JavaScript alongside it.
 *
 * ## Why the draft lives here
 *
 * Same reason it lives in `chat/composer.tsx` rather than in ChatView: state
 * belongs at the lowest node that needs it. Typing here re-renders a
 * textarea and a button, not the six listing cards underneath.
 */
export function HomeAsk({
  exampleSuburb,
  starters,
}: {
  exampleSuburb: string | null;
  /** Openers, as sentences a person would actually say. */
  starters: readonly string[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  /**
   * The navigation, as a transition rather than a latch.
   *
   * This was a plain `useState(false)` that was set on submit and never
   * cleared, on the reasoning that the component is on its way off screen
   * so there is nothing to restore. That reasoning has a hole in it: if the
   * navigation never completes — the RSC payload fails, the connection
   * drops — the flag stays true and the box is disabled for ever, with no
   * error and nothing to press. A dead form is a worse outcome than the
   * double submit it was guarding against.
   *
   * `useTransition` gives the same guard and ends by itself either way.
   * `/search` already drives `router.push` this way; this is that pattern,
   * not a new one.
   */
  const [leaving, startLeaving] = useTransition();
  const warmed = useRef(false);

  const go = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text || leaving) return;
      startLeaving(() => {
        // Same ceiling the chat request schema enforces (MAX_MESSAGE_CHARS),
        // applied before the sentence becomes a URL rather than after the
        // server has rejected it.
        router.push(`/chat?ask=${encodeURIComponent(text.slice(0, 1000))}`);
      });
    },
    [leaving, router],
  );

  /**
   * Fetch `/chat` the moment there is any sign it is wanted.
   *
   * `/chat` is `force-dynamic`, so it is a server render rather than
   * something sitting in the static cache, and the gap between pressing the
   * button and the first paint is the whole of it. Warming on focus or on
   * a hovered starter moves that render to a moment when nobody is waiting.
   * Once only — `prefetch` on every keystroke is a request per character.
   */
  const warm = useCallback(() => {
    if (warmed.current) return;
    warmed.current = true;
    router.prefetch('/chat');
  }, [router]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    go(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line — the same contract as the
    // composer this box hands over to, so the habit carries.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      go(draft);
    }
  }

  return (
    <div className={styles.ask}>
      <form className={styles.askBox} onSubmit={onSubmit}>
        <textarea
          className={styles.askInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={warm}
          rows={2}
          maxLength={1000}
          disabled={leaving}
          aria-label="Tell the property guide what you are looking for"
          placeholder={
            exampleSuburb
              ? `A family home near ${exampleSuburb}, under $900k, 3 beds…`
              : 'Suburb, budget, bedrooms — or ask where you should be looking…'
          }
        />

        <div className={styles.askFoot}>
          <span className={styles.askHint}>
            Prices and match counts come from the live database, never from the model.
          </span>
          <button
            type="submit"
            className={styles.askSend}
            disabled={!draft.trim() || leaving}
            aria-busy={leaving}
            aria-label="Ask the property guide"
          >
            {/* The arrow belongs to the resting state. Drawing it beside the
                spinner puts two different "something is happening" marks on
                one button, pointing in different directions. */}
            {leaving ? (
              <>
                <Spinner /> Opening…
              </>
            ) : (
              <>
                Ask the guide
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </>
            )}
          </button>
        </div>
      </form>

      {/*
        Buttons, not links. A starter is the same action as pressing Ask with
        that sentence in the box — it goes through `go` and lands on the same
        URL — so making one an <a> and the other a <button> would be two
        controls that do one thing.
      */}
      <div className={styles.starters}>
        {starters.map((starter) => (
          <button
            key={starter}
            type="button"
            className={styles.starter}
            onClick={() => go(starter)}
            onPointerEnter={warm}
            disabled={leaving}
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}
