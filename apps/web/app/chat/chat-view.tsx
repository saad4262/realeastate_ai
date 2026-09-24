'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
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

type Slots = StateEvent['slots'];

const STARTERS = [
  'Berwick is home — where should I look next?',
  'Buying around Pakenham, within about 30 km',
  '2-bed rental under $650 a week near Bondi',
];

/** Sidebar brief rows — empty until the guide fills a slot. */
const BRIEF_FIELDS: { id: string; label: string; format: (slots: Slots) => string | null }[] = [
  {
    id: 'channel',
    label: 'Buy or rent',
    format: (s) =>
      s.channel === 'sale' ? 'Buying' : s.channel === 'rent' ? 'Renting' : null,
  },
  {
    id: 'suburb',
    label: 'Suburb',
    format: (s) => {
      if (!s.suburb) return null;
      return [s.suburb, s.state, s.postcode].filter(Boolean).join(', ');
    },
  },
  {
    id: 'radius',
    label: 'Radius',
    format: (s) => (s.radiusKm != null ? `${s.radiusKm} km` : null),
  },
  {
    id: 'bedrooms',
    label: 'Bedrooms',
    format: (s) => (s.bedrooms != null ? `${s.bedrooms}+` : null),
  },
  {
    id: 'bathrooms',
    label: 'Bathrooms',
    format: (s) => (s.bathrooms != null ? `${s.bathrooms}+` : null),
  },
  {
    id: 'cars',
    label: 'Car spaces',
    format: (s) => (s.carSpaces != null ? `${s.carSpaces}+` : null),
  },
  {
    id: 'type',
    label: 'Property type',
    format: (s) => s.propertyType ?? null,
  },
  {
    id: 'budget',
    label: 'Budget',
    format: (s) => {
      const rental = s.channel === 'rent';
      const money = (n: number) =>
        rental
          ? `$${n.toLocaleString('en-AU')} pw`
          : `$${n.toLocaleString('en-AU')}`;
      if (s.priceFrom != null && s.priceTo != null) {
        return `${money(s.priceFrom)} – ${money(s.priceTo)}`;
      }
      if (s.priceTo != null) return `under ${money(s.priceTo)}`;
      if (s.priceFrom != null) return `from ${money(s.priceFrom)}`;
      return null;
    },
  },
  {
    id: 'keywords',
    label: 'Keywords',
    format: (s) => s.keywords ?? null,
  },
];

function SendIcon({ variant = 'arrow' }: { variant?: 'arrow' | 'plane' }) {
  if (variant === 'plane') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M4.4 11.2 19.2 4.7c.7-.3 1.4.4 1.1 1.1l-6.5 14.8c-.3.7-1.3.6-1.5-.1l-1.8-5.4a1 1 0 0 0-.6-.6l-5.4-1.8c-.7-.2-.8-1.2-.1-1.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.5 12h15m0 0-6.5-6.5M19.5 12 13 18.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TypingSkeleton({ label }: { label: string }) {
  return (
    <div className={styles.typing} aria-busy="true" aria-label={label}>
      <p className={styles.typingLabel}>{label}</p>
      <div className={styles.skeleton} aria-hidden>
        <span className={styles.skeletonBar} />
        <span className={`${styles.skeletonBar} ${styles.skeletonBarMid}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonBarShort}`} />
      </div>
    </div>
  );
}

export function ChatView({ exampleSuburb }: { exampleSuburb: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slots | null>(null);
  const [results, setResults] = useState<ResultsEvent | null>(null);
  const [tab, setTab] = useState<'chat' | 'results'>('chat');

  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const empty = turns.length === 0;

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
      setTab('chat');

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
        inputRef.current?.focus();
      }
    },
    [slots, streaming, turns],
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
    }
  }

  const last = turns[turns.length - 1];
  const awaitingReply =
    streaming && last?.role === 'assistant' && !last.text && !last.results && !working;

  const composer = (
    <div className={empty ? styles.heroComposer : styles.composer}>
      {empty ? (
        <div className={styles.chips}>
          {STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              className={styles.chipBtn}
              onClick={() => void send(starter)}
              disabled={streaming}
            >
              {starter}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className={empty ? styles.heroComposeBox : styles.composeBox}
        onSubmit={onSubmit}
      >
        <textarea
          ref={inputRef}
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
              <button
                type="button"
                className={styles.stop}
                onClick={() => abortRef.current?.abort()}
              >
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
          <button
            type="button"
            className={styles.stop}
            onClick={() => abortRef.current?.abort()}
          >
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

  const sidebar = (
    <aside
      className={`${styles.sidebar} ${tab === 'chat' ? styles.hiddenMobile : ''}`}
      aria-label="Your search"
    >
      <div className={styles.brief}>
        <h2 className={styles.briefTitle}>Your search</h2>
        <p className={styles.briefSub}>
          We&apos;ll track what you&apos;re after here as we go.
        </p>
        <ul className={styles.briefList}>
          {BRIEF_FIELDS.map((field) => {
            const value = slots ? field.format(slots) : null;
            return (
              <li
                key={field.id}
                className={`${styles.briefItem} ${value ? styles.briefFilled : ''}`}
              >
                <span className={styles.briefDot} aria-hidden />
                <span className={styles.briefLabel}>{field.label}</span>
                {value ? <span className={styles.briefValue}>{value}</span> : null}
              </li>
            );
          })}
        </ul>
        <p className={styles.briefFoot}>
          Listing prices and match counts come from the live search — never from the model.
        </p>
      </div>

      <ResultsPanel results={results} embedded />
    </aside>
  );

  return (
    <div className={`${styles.page} ${empty ? styles.pageEmpty : styles.pageActive}`}>
      {!empty ? (
        <div className={styles.tabs} role="tablist" aria-label="Chat or search">
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
            Search{results ? ` (${results.listings.length})` : ''}
          </button>
        </div>
      ) : null}

      <div className={styles.split}>
        <section
          className={`${styles.main} ${!empty && tab === 'results' ? styles.hiddenMobile : ''}`}
          aria-label="Conversation"
        >
          {empty ? (
            <div className={styles.hero}>
              <span className={styles.badge}>
                <span className={styles.badgeDot} aria-hidden />
                AI property guide · live Australian listings
              </span>
              <h1 className={styles.heroTitle}>
                <span className={styles.heroTitleAccent}>Tell me what you need.</span>
                <span className={styles.heroTitleMuted}> I&apos;ll search what&apos;s live.</span>
              </h1>
              <p className={styles.heroSub}>
                Talk the way you would to a local — buy or rent, suburb, budget, bedrooms, or
                which area might suit you. I&apos;ll weigh it up and search the live stock.
              </p>
              {error ? <p className={styles.error}>{error}</p> : null}
              {composer}
            </div>
          ) : (
            <>
              {/*
                role="log" announces a completed message. The streaming text node is
                deliberately NOT live per delta — a screen reader would read the
                answer out one character at a time.
              */}
              <div className={styles.thread} ref={threadRef} role="log" aria-live="polite">
                {turns.map((turn, i) => {
                  const isUser = turn.role === 'user';
                  const isStreamingTail =
                    streaming && i === turns.length - 1 && !isUser && !turn.text && !turn.results;

                  // Empty assistant shell while waiting — typing row handles it.
                  if (isStreamingTail) return null;

                  return (
                    <div
                      className={`${styles.msg} ${isUser ? styles.msgUser : styles.msgAi}`}
                      key={i}
                    >
                      <div className={styles.msgMeta}>
                        {!isUser ? (
                          <span className={styles.avAi} aria-hidden>
                            P
                          </span>
                        ) : null}
                        <span className={styles.msgName}>{isUser ? 'You' : 'Guide'}</span>
                      </div>
                      <div className={isUser ? styles.bubbleUser : styles.bubbleAi}>
                        {turn.text ? <p className={styles.msgText}>{turn.text}</p> : null}

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
                  );
                })}

                {working || awaitingReply ? (
                  <div className={`${styles.msg} ${styles.msgAi}`}>
                    <div className={styles.msgMeta}>
                      <span className={styles.avAi} aria-hidden>
                        P
                      </span>
                      <span className={styles.msgName}>Guide</span>
                    </div>
                    <div className={styles.bubbleAi}>
                      <TypingSkeleton label={working ?? 'Reading your answer…'} />
                    </div>
                  </div>
                ) : null}

                {error ? <p className={styles.error}>{error}</p> : null}
              </div>

              {composer}
            </>
          )}
        </section>

        {!empty ? sidebar : null}
      </div>
    </div>
  );
}
