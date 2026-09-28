'use client';

import { forwardRef, memo, useState, type FormEvent, type KeyboardEvent } from 'react';
import styles from './chat.module.css';

/**
 * The message box, and the draft that lives in it.
 *
 * ## Why the draft is state HERE and not in ChatView
 *
 * It used to be `useState` on ChatView, which meant every keystroke
 * re-rendered the whole page: the transcript, the sidebar, the results
 * panel and the Google map inside it. Reported as "the pins refresh when I
 * type" and read as the page reloading, which is almost what it was — a
 * full React re-render of an expensive tree, thirty times a sentence.
 *
 * Keeping it here is the fix, and it is the ordinary one: state belongs at
 * the lowest node that needs it. Typing now re-renders a textarea and a
 * send button. The parent hears about the draft exactly once, when it is
 * submitted.
 *
 * `memo` matters as much as the move — without it the parent's own
 * re-renders (a streaming token arriving, say) would re-render this too,
 * and the textarea would be reconciled on every frame of the answer.
 */
export type ComposerProps = {
  empty: boolean;
  streaming: boolean;
  exampleSuburb: string | null;
  starters: readonly string[];
  /** Must be stable — wrap it in useCallback, or memo here buys nothing. */
  onSend: (message: string) => void;
  onStop: () => void;
};

function SendIcon({ variant }: { variant?: 'plane' }) {
  return variant === 'plane' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12 20 4l-8 16-2-6-6-2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export const Composer = memo(
  forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
    { empty, streaming, exampleSuburb, starters, onSend, onStop },
    ref,
  ) {
    const [draft, setDraft] = useState('');

    function submit() {
      const message = draft.trim();
      if (!message) return;
      // Cleared here rather than by the parent: the parent no longer knows
      // what is in the box, which is the whole point.
      setDraft('');
      onSend(message);
    }

    function onSubmit(event: FormEvent) {
      event.preventDefault();
      submit();
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    }

    return (
      <div className={empty ? styles.heroComposer : styles.composer}>
        {empty ? (
          <div className={styles.chips}>
            {starters.map((starter) => (
              <button
                key={starter}
                type="button"
                className={styles.chipBtn}
                onClick={() => onSend(starter)}
                disabled={streaming}
              >
                {starter}
              </button>
            ))}
          </div>
        ) : null}

        <form className={empty ? styles.heroComposeBox : styles.composeBox} onSubmit={onSubmit}>
          <textarea
            ref={ref}
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              empty
                ? exampleSuburb
                  ? `e.g. a family home near ${exampleSuburb}, under $900k, 3 beds…`
                  : 'Suburb, budget, bedrooms — or ask where you should look…'
                : 'Ask a follow-up, or change the brief…'
            }
            maxLength={1000}
            rows={empty ? 3 : 1}
            aria-label="Message the property guide"
            disabled={streaming}
          />

          {empty ? (
            <div className={styles.composeToolbar}>
              <span className={styles.composeHint}>AI guide · prices from live listings</span>
              {streaming ? (
                <button type="button" className={styles.stop} onClick={onStop}>
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className={styles.sendPill}
                  disabled={!draft.trim()}
                  aria-label="Send"
                >
                  Ask the guide
                  <SendIcon />
                </button>
              )}
            </div>
          ) : streaming ? (
            <button type="button" className={styles.stop} onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className={styles.sendIcon}
              disabled={!draft.trim()}
              aria-label="Send"
            >
              <SendIcon variant="plane" />
            </button>
          )}
        </form>
      </div>
    );
  }),
);
