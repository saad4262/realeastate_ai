'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import type { ChatEvent, ResultsEvent, StateEvent } from '@repo/ai/chat-events';
import { readChatStream } from './chat-stream';
import { ResultsPanel } from './results-panel';
import { DeliveredRun } from './delivered-run';
import { ChatToolbar } from './chat-toolbar';
import { HistoryScreen } from './history-screen';
import { ScheduleCard } from './schedule-card';
import { Composer } from './composer';
import { RichText } from './rich-text';
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
  /**
   * The turn's own `/search` link, from the accumulated brief rather than from
   * the last tool call.
   *
   * The server has always sent this on the `state` frame and the client has
   * always thrown it away. It is the fallback for a turn where the guide asked
   * a question instead of searching — there is no `results` to take a link
   * from, but the brief so far is still a real search.
   */
  stateLink?: string | null;
  /**
   * A schedule the guide proposed on this turn, awaiting confirmation.
   *
   * Held on the turn rather than in page state so it stays anchored to the
   * message that produced it — scrolling back to an older card and pressing
   * Accept on it is exactly as valid as pressing the newest one.
   */
  scheduleDraft?: {
    token: string;
    search: string;
    cadence: string;
    searchPath: string;
  };
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

/**
 * The one link a turn hands over, and what to call it.
 *
 * Every figure in the label comes from the server's own frame — `matched` and
 * `capped` are the same values the chips above it use — so nothing here is a
 * number the model produced (#4).
 *
 * Returns null rather than a dead end. A search that matched nothing gets no
 * link of its own: `/search` would render the same nothing, so it is a button
 * that goes somewhere empty. The accumulated brief is offered instead when it
 * is a genuinely different search.
 */
function turnLink(turn: Turn): { href: string; label: string; aria: string } | null {
  const results = turn.results;

  if (results && results.matched > 0) {
    const count = results.capped ? `${results.matched}+` : `${results.matched}`;
    const shown = results.listings.length > 0;
    return {
      href: results.deepLink,
      // Too broad: the panel is empty but the matches are real, so the link is
      // the only way to see them.
      label: shown ? `View all ${count} in search` : `Browse all ${count} anyway`,
      aria: `View all ${count} matching properties in search — opens in a new tab`,
    };
  }

  const fallback = turn.stateLink;
  if (!fallback || fallback === results?.deepLink) return null;
  return {
    href: fallback,
    label: 'Open your search so far',
    aria: 'Open your search so far — opens in a new tab',
  };
}

/**
 * A scheduled run handed down by the page, already formatted.
 *
 * Primitives only. Everything here crossed the server/client boundary as
 * JSON, so a `Date` would arrive as a string while the type still claimed
 * `Date` — ARCHITECTURE § 6's named class of bug. Prices arrive as strings
 * too, formatted by `priceLabel` on the server, because this file may not
 * import the listings barrel.
 */
export type DeliveredRunSeed = {
  ranAtIso: string;
  scheduleName: string;
  description: string;
  matched: number;
  newCount: number;
  summary: string | null;
  summarySource: 'model' | 'template' | 'none';
  searchPath: string;
  listings: { id: string; price: string; address: string }[];
  prompt: string;
};

export function ChatView({
  exampleSuburb,
  delivered = null,
  signedIn = false,
  historyOpen = false,
  activeTitle = null,
  initialThreadId = null,
  initialSlots = null,
  initialResults = null,
  initialTurns = [],
  threads = [],
}: {
  exampleSuburb: string | null;
  delivered?: DeliveredRunSeed | null;
  /** `/chat?history=1` — the list, instead of the hero or a transcript. */
  historyOpen?: boolean;
  /** Title stored for the thread the URL opened. */
  activeTitle?: string | null;
  /** The thread being reopened, when the URL names one. */
  initialThreadId?: string | null;
  /** Brief restored from the last saved search, so a reply still knows it. */
  initialSlots?: Slots | null;
  /** Last results frame, so the sidebar comes back with the transcript. */
  initialResults?: ResultsEvent | null;
  /** Its turns, already in the shape this component stores them. */
  initialTurns?: Turn[];
  /** The sidebar list. Empty for an anonymous visitor, who saves nothing. */
  threads?: { id: string; title: string; lastMessageAt: string }[];
  /**
   * Display only. `/chat` is inside the middleware matcher, so unlike
   * `/search` this is a verified session rather than a cookie sniff — but
   * the Server Action still reads the session itself and refuses on its own.
   */
  signedIn?: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [streaming, setStreaming] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slots | null>(initialSlots);
  const [results, setResults] = useState<ResultsEvent | null>(initialResults);
  const [tab, setTab] = useState<'chat' | 'results'>('chat');

  const threadRef = useRef<HTMLDivElement>(null);
  /**
   * The saved conversation this is appending to, if any.
   *
   * A ref rather than state: it is read inside `send` and changing it must
   * not re-render the transcript. The server creates the thread on the
   * first exchange and reports its id back in a response header, because at
   * the time the request is made there is nothing to send.
   */
  const threadIdRef = useRef<string | null>(initialThreadId);
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
          headers: {
            'content-type': 'application/json',
            /**
             * App plumbing, so it travels as a header rather than in the
             * body: chatRequestSchema is `.strict()` and describes what the
             * MODEL is given. A thread id has no business in it.
             *
             * The server refuses an id this session does not own, so a
             * forged one appends nothing.
             */
            ...(threadIdRef.current ? { 'x-chat-thread': threadIdRef.current } : {}),
          },
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
              // event.deepLink used to stop here. It is the only link a turn
              // that asked a question rather than searching will ever have.
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last) next[next.length - 1] = { ...last, stateLink: event.deepLink };
                return next;
              });
              break;

            case 'error':
              setError(event.message);
              break;

            case 'schedule_draft':
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last) {
                  next[next.length - 1] = {
                    ...last,
                    scheduleDraft: {
                      token: event.token,
                      search: event.search,
                      cadence: event.cadence,
                      searchPath: event.searchPath,
                    },
                  };
                }
                return next;
              });
              break;

            case 'saved': {
              // First exchange of a new conversation: remember where it
              // landed so the next turn appends rather than starting again.
              //
              // The URL is updated without a Next navigation. A router
              // replace would re-render this page and, because the view is
              // keyed on the thread id, remount it — dropping the
              // confirmation card, which is not stored. A reload still
              // opens the same chat, because the query is what the server
              // reads.
              threadIdRef.current = event.threadId;
              const nextUrl = `/chat?thread=${event.threadId}`;
              if (window.location.pathname + window.location.search !== nextUrl) {
                window.history.replaceState(window.history.state, '', nextUrl);
              }
              break;
            }

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


  const last = turns[turns.length - 1];
  const awaitingReply =
    streaming && last?.role === 'assistant' && !last.text && !last.results && !working;

  /**
   * Stable, so `memo` on Composer is worth having.
   *
   * `send` already depends on slots/streaming/turns, which change during a
   * turn — but not on the draft, which is the thing changing thirty times
   * a sentence. That is the re-render this split removes.
   */
  const onStop = useCallback(() => abortRef.current?.abort(), []);

  /**
   * Drop the draft without a navigation.
   *
   * New chat on the empty URL cannot remount this view — the key stays
   * `new` — so the turns have to be cleared here. A thread id written into
   * the address bar by the save frame is cleared with them, or a reload
   * would bring the conversation back.
   */
  const startFresh = useCallback(() => {
    setTurns([]);
    setSlots(null);
    setResults(null);
    setError(null);
    setWorking(null);
    threadIdRef.current = null;
    if (window.location.pathname + window.location.search !== '/chat') {
      window.history.replaceState(window.history.state, '', '/chat');
    }
  }, []);

  const liveTitle =
    activeTitle ??
    (() => {
      const first = turns.find((turn) => turn.role === 'user')?.text.trim();
      if (!first) return null;
      const cleaned = first.replace(/\s+/g, ' ');
      return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57)}…`;
    })();

  const composer = (
    <Composer
      ref={inputRef}
      empty={empty}
      streaming={streaming}
      exampleSuburb={exampleSuburb}
      starters={STARTERS}
      onSend={send}
      onStop={onStop}
    />
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

        {/*
          There is no save button here any more.

          Scheduling is something the visitor ASKS for — "send me this
          daily", "every two hours" — and the guide answers with a
          confirmation card in the conversation. A button in the sidebar
          offered one frequency, in one place, with no way to say anything
          else about it; the tool can take any of them and shows what it
          understood before anything is saved. See draft_schedule in
          packages/ai/src/tools/schedule-tools.ts.
        */}
      </div>

      <ResultsPanel results={results} embedded />
    </aside>
  );

  return (
    <div
      className={`${styles.page} ${
        historyOpen ? styles.pageHistory : empty ? styles.pageEmpty : styles.pageActive
      }`}
    >
      {!historyOpen && !empty ? (
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
          className={`${styles.main} ${!historyOpen && !empty && tab === 'results' ? styles.hiddenMobile : ''}`}
          aria-label={historyOpen ? 'Past conversations' : 'Conversation'}
        >
          <ChatToolbar
            count={threads.length}
            historyOpen={historyOpen}
            loadedThread={Boolean(initialThreadId)}
            activeTitle={historyOpen ? null : liveTitle}
            onFresh={startFresh}
          />

          {historyOpen ? (
            <HistoryScreen threads={threads} signedIn={signedIn} activeId={initialThreadId} />
          ) : (
            <>
          {/*
            The delivered run sits ABOVE the conversation and never inside
            it. It is not a turn: `turns` is what gets replayed to the model
            on the next request, and a fabricated assistant message would be
            the model reading words it never said — with listings attached,
            which is the one shape chatRequestSchema refuses from a client
            because a tool result is the only source of a price (#4).
          */}
          {delivered ? (
            <DeliveredRun
              ranAtIso={delivered.ranAtIso}
              scheduleName={delivered.scheduleName}
              description={delivered.description}
              matched={delivered.matched}
              newCount={delivered.newCount}
              summary={delivered.summary}
              summarySource={delivered.summarySource}
              searchPath={delivered.searchPath}
              listings={delivered.listings}
              onContinue={() => {
                /*
                  Sends it rather than prefilling the box.
                 
                  The draft now lives inside Composer — which is what stops
                  every keystroke re-rendering the map — so the parent has
                  no way to write into it, and inventing one would put the
                  state back where it was. Sending is also the better
                  behaviour: the button says "Ask about these", and one
                  click doing exactly that beats one click typing for you.
                */
                void send(`About my saved search — ${delivered.prompt}.`);
              }}
            />
          ) : null}

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
                        {turn.text ? <RichText text={turn.text} /> : null}

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

                        {/*
                          Below the chips rather than beside them, and not a
                          fourth chip: a chip states what was searched, this
                          leaves the page. They should not look alike.
                        */}
                        {(() => {
                          const link = turnLink(turn);
                          if (!link) return null;
                          return (
                            <Link
                              href={link.href}
                              className={styles.turnLink}
                              target="_blank"
                              rel="noopener"
                              // Prefetching would run this search once here and
                              // again in the new tab. /search is dynamic.
                              prefetch={false}
                              aria-label={link.aria}
                            >
                              {link.label}
                              <span aria-hidden> ↗</span>
                            </Link>
                          );
                        })()}

                        {/*
                          The confirmation card, anchored to the turn that
                          proposed it. Nothing is saved until Accept — see
                          schedule-card.tsx.
                        */}
                        {turn.scheduleDraft ? (
                          <ScheduleCard
                            token={turn.scheduleDraft.token}
                            search={turn.scheduleDraft.search}
                            cadence={turn.scheduleDraft.cadence}
                            searchPath={turn.scheduleDraft.searchPath}
                            signedIn={signedIn}
                          />
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
            </>
          )}
        </section>

        {!historyOpen && !empty ? sidebar : null}
      </div>
    </div>
  );
}
