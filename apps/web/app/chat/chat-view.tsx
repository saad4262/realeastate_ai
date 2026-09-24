'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatEvent, ResultsEvent, StateEvent } from '@repo/ai/chat-events';
import { readChatStream } from './chat-stream';
import { ResultsPanel } from './results-panel';
import styles from './chat.module.css';

/**
 * The property guide.
 *
 * IMPORTANT: this file may only ever `import type` from @repo/ai. That package
 * is in the web app's transpilePackages list, so one value import here would
 * pull the Anthropic SDK and postgres.js into the browser bundle.
 * @repo/ai/chat-events is types-only for exactly this reason.
 */

/** Six exchanges, matching the cap the server enforces. */
const MAX_TURNS = 12;

type Turn = {
  role: 'user' | 'assistant';
  text: string;
  /** A citation of what was searched. Not the listings — the server re-runs those. */
  searches?: { query: unknown; matched: number; shown: number }[];
  /** Kept client-side only, to redraw the chips under an answer. */
  results?: ResultsEvent;
};

const STARTERS = [
  'I need a house in Pakenham under 30 km',
  'Rentals under $650 a week with 2 bedrooms',
  'What is for sale near Bondi Beach?',
];

export function ChatView({ exampleSuburb }: { exampleSuburb: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<StateEvent['slots'] | null>(null);
  const [results, setResults] = useState<ResultsEvent | null>(null);
  const [tab, setTab] = useState<'chat' | 'results'>('chat');

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Follow the answer as it arrives. Not aria-live per delta — see below.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, working]);

  // A turn still running when the page goes away is a turn still being billed.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || streaming) return;

      setDraft('');
      setError(null);
      setStreaming(true);
      setWorking(null);

      const history = turns.slice(-MAX_TURNS);
      setTurns((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '' }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            message: text,
            // Only what the server is willing to believe: words, and a citation
            // of what was searched. Never listings, never prices.
            turns: history.map((t) => ({
              role: t.role,
              text: t.text,
              ...(t.searches ? { searches: t.searches } : {}),
            })),
            ...(slots ? { slots } : {}),
          }),
        });

        if (!response.ok && !response.body) {
          const payload = (await response.json().catch(() => null)) as ChatEvent | null;
          setError(
            payload && payload.type === 'error'
              ? payload.message
              : 'The guide is unavailable right now.',
          );
          return;
        }

        await readChatStream(response, (event) => {
          switch (event.type) {
            case 'text':
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last) next[next.length - 1] = { ...last, text: last.text + event.delta };
                return next;
              });
              setWorking(null);
              break;

            case 'tool':
              setWorking(event.label);
              break;

            case 'results':
              setResults(event);
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last) {
                  next[next.length - 1] = {
                    ...last,
                    results: event,
                    searches: [
                      ...(last.searches ?? []),
                      { query: event.query, matched: event.matched, shown: event.listings.length },
                    ],
                  };
                }
                return next;
              });
              break;

            case 'state':
              setSlots(event.slots);
              break;

            case 'error':
              setError(event.message);
              break;

            case 'turn':
            case 'done':
              break;
          }
        });
      } catch (err) {
        // An abort is the visitor's own doing, not a failure to report.
        if ((err as Error).name !== 'AbortError') {
          setError('The connection dropped. Please try again.');
        }
      } finally {
        setStreaming(false);
        setWorking(null);
        abortRef.current = null;
        // An answer that never arrived leaves an empty bubble behind.
        setTurns((prev) => {
          const last = prev[prev.length - 1];
          return last && last.role === 'assistant' && !last.text && !last.results
            ? prev.slice(0, -1)
            : prev;
        });
      }
    },
    [slots, streaming, turns],
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  const placeholder = exampleSuburb
    ? `Try "3 bedroom house in ${exampleSuburb}"`
    : 'Tell me what you are looking for';

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>Property guide</h1>
        <p className={styles.sub}>
          Describe what you are after and I will search the live listings with you.
        </p>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Chat or results">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={`${styles.tab} ${tab === 'chat' ? styles.tabActive : ''}`}
          onClick={() => setTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'results'}
          className={`${styles.tab} ${tab === 'results' ? styles.tabActive : ''}`}
          onClick={() => setTab('results')}
        >
          Results{results ? ` (${results.listings.length})` : ''}
        </button>
      </div>

      <div className={styles.split}>
        <section
          className={`${styles.card} ${tab === 'results' ? styles.hidden : ''}`}
          aria-label="Conversation"
        >
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Guide</h2>
            <span className={styles.cardNote}>Prices come from the live listings</span>
          </div>

          {/*
            role="log" announces a completed message. The streaming text node is
            deliberately NOT live per delta — a screen reader would read the
            answer out one character at a time.
          */}
          <div className={styles.thread} ref={threadRef} role="log" aria-live="polite">
            {turns.length === 0 ? (
              <div className={styles.msg}>
                <span className={styles.avAi} aria-hidden>
                  PG
                </span>
                <div className={styles.bubbleAi}>
                  <p className={styles.msgText}>
                    Hello. Are you looking to buy or to rent, and whereabouts?
                  </p>
                </div>
              </div>
            ) : null}

            {turns.map((turn, i) => (
              <div className={styles.msg} key={i}>
                <span className={turn.role === 'user' ? styles.avUser : styles.avAi} aria-hidden>
                  {turn.role === 'user' ? 'You' : 'PG'}
                </span>
                <div className={turn.role === 'user' ? styles.bubbleUser : styles.bubbleAi}>
                  <div className={styles.msgName}>
                    {turn.role === 'user' ? 'You' : 'Property guide'}
                  </div>
                  {turn.text ? <p className={styles.msgText}>{turn.text}</p> : null}

                  {/* What was searched, written by the server from the query it ran. */}
                  {turn.results ? (
                    <div className={styles.searched}>
                      <span className={styles.chip}>
                        {turn.results.capped
                          ? `${turn.results.matched}+ matches`
                          : `${turn.results.matched} matches`}
                      </span>
                      {turn.results.query.suburb ? (
                        <span className={styles.chip}>{turn.results.query.suburb}</span>
                      ) : null}
                      {turn.results.query.near ? (
                        <span className={styles.chip}>
                          within {turn.results.query.near.radiusKm} km
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            {working ? (
              <div className={styles.msg}>
                <span className={styles.avAi} aria-hidden>
                  PG
                </span>
                <div className={styles.bubbleAi}>
                  <div className={styles.working}>
                    <span className={styles.dot} />
                    <span className={styles.dot} />
                    <span className={styles.dot} />
                    <span>{working}</span>
                  </div>
                </div>
              </div>
            ) : null}

            {error ? <p className={styles.error}>{error}</p> : null}
          </div>

          <div className={styles.composer}>
            {turns.length === 0 ? (
              <div className={styles.chips}>
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    className={styles.chipBtn}
                    onClick={() => void send(starter)}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            ) : null}

            <form className={styles.composeRow} onSubmit={onSubmit}>
              <input
                className={styles.input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                maxLength={1000}
                aria-label="Message the property guide"
                disabled={streaming}
              />
              {streaming ? (
                <button
                  type="button"
                  className={styles.stop}
                  onClick={() => abortRef.current?.abort()}
                >
                  Stop
                </button>
              ) : (
                <button type="submit" className={styles.send} disabled={!draft.trim()}>
                  Send
                </button>
              )}
            </form>
          </div>
        </section>

        <ResultsPanel results={results} hidden={tab === 'chat'} />
      </div>
    </div>
  );
}
