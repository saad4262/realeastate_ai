'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ChatEvent, ChatSuggestion, ResultsEvent, StateEvent } from '@repo/ai/chat-events';
import { readChatStream } from './chat-stream';
import { ResultsPanel } from './results-panel';
import { DeliveredRun } from './delivered-run';
import { ChatToolbar } from './chat-toolbar';
import { HistoryScreen } from './history-screen';
import { HistoryRail } from './history-rail';
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
   * The server's offer of a next step. Never the model's.
   *
   * Stored on the turn rather than in one piece of view state so that
   * reopening a thread, or a turn arriving while an older one is still on
   * screen, cannot leave chips attached to the wrong answer. Only the last
   * turn renders them — see the guard at the render site.
   */
  suggestions?: ChatSuggestion[];
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
 * The screen you asked for, before the server has it.
 *
 * Built out of the SAME classes as the thing it stands in for — `.thread`,
 * `.msg`, `.bubbleAi`, `.composer` — rather than a spinner, for the reason
 * `loading.tsx` gives about the other four dynamic routes: the real content
 * should fill this in, not shove it aside. A centred spinner is one more
 * relayout on arrival, on top of the one the navigation already causes.
 *
 * Three shapes, because `/chat` has three and they do not share a layout.
 * Bubble widths are set here because a bubble with no text in it has no
 * width of its own, and they are deliberately uneven: a column of identical
 * blocks reads as a loading graphic, an uneven one reads as a conversation.
 *
 * `aria-busy` and a label, and no live region — the toolbar already names
 * the conversation being opened, and a skeleton that announces itself on
 * every navigation is noise.
 */
function OpeningSkeleton({ view }: { view: 'thread' | 'history' | 'new' }) {
  if (view === 'new') {
    return (
      <div className={styles.hero} aria-busy="true" aria-label="Starting a new chat">
        <span className={`${styles.skeletonBar} ${styles.openingBadge}`} aria-hidden />
        <span className={`${styles.skeletonBar} ${styles.openingHeroTitle}`} aria-hidden />
        <span className={`${styles.skeletonBar} ${styles.openingHeroSub}`} aria-hidden />
        <div className={styles.heroComposer}>
          <div className={`${styles.composeBox} ${styles.openingCompose}`} aria-hidden />
        </div>
      </div>
    );
  }

  if (view === 'history') {
    return (
      <div className={styles.history} aria-busy="true" aria-label="Opening your conversations">
        <div className={styles.historyHead}>
          <span className={`${styles.skeletonBar} ${styles.openingHeroTitle}`} aria-hidden />
          <span className={`${styles.skeletonBar} ${styles.openingHeroSub}`} aria-hidden />
        </div>
        <div aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`${styles.skeletonBar} ${styles.openingRow}`} />
          ))}
        </div>
      </div>
    );
  }

  // A conversation: two exchanges' worth, which is enough to read as one
  // without pretending to know how long the real transcript is.
  return (
    <>
      <div className={styles.thread} aria-busy="true" aria-label="Opening the conversation">
        {[0, 1].map((i) => (
          <div key={i} className={styles.openingPair} aria-hidden>
            <div className={`${styles.msg} ${styles.msgUser}`}>
              <div className={`${styles.bubbleUser} ${styles.openingUser}`}>
                <span className={styles.skeletonBar} />
              </div>
            </div>

            <div className={`${styles.msg} ${styles.msgAi}`}>
              <div className={styles.msgMeta}>
                <span className={styles.avAi}>P</span>
                <span className={`${styles.skeletonBar} ${styles.openingName}`} />
              </div>
              <div className={`${styles.bubbleAi} ${styles.openingAi}`}>
                <div className={styles.skeleton}>
                  <span className={styles.skeletonBar} />
                  <span className={`${styles.skeletonBar} ${styles.skeletonBarMid}`} />
                  <span className={`${styles.skeletonBar} ${styles.skeletonBarShort}`} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* At the height the real one sits at, so the box does not jump when
          the conversation lands under it. */}
      <div className={styles.composer} aria-hidden>
        <div className={`${styles.composeBox} ${styles.openingCompose}`} />
      </div>
    </>
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
  initialAsk = null,
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
  /**
   * The rail's list. Empty for an anonymous visitor, who saves nothing.
   *
   * `group` is the heading each row belongs under — "Today", "Yesterday" —
   * and it is computed on the server for the hydration reason set out in
   * history-rail.tsx.
   */
  threads?: { id: string; title: string; lastMessageAt: string; group: string }[];
  /**
   * A sentence typed on the home page, to be sent on arrival.
   *
   * Handed over in the URL (`/chat?ask=…`) rather than in a store, because
   * the navigation that brings somebody here is a server render: there is
   * no client state that survives it. It is consumed once — see the effect
   * below — and the query is stripped immediately so a reload does not ask
   * the guide the same thing again.
   */
  initialAsk?: string | null;
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
  /**
   * The conversations drawer, on a phone.
   *
   * Starts closed, and that is safe on a desktop too: above 1024px the
   * stylesheet puts the rail in the layout and ignores this flag entirely.
   * One flag meaning "in the layout" and "over the top of everything" at
   * once would need opposite defaults on the two viewports, which the
   * server cannot choose between.
   */
  const [railOpen, setRailOpen] = useState(false);

  const router = useRouter();

  /*
    Stable, for the same reason Composer's `onSend` is: HistoryRail is
    memoised, and an inline arrow here would hand it a new prop on every
    streaming token and make the memo a no-op.
  */
  const closeRail = useCallback(() => setRailOpen(false), []);
  const openRail = useCallback(() => setRailOpen(true), []);

  /**
   * Moving between conversations, with something on screen while it lands.
   *
   * `loading.tsx` covers the FIRST paint of `/chat` and nothing after it.
   * Clicking a row in the rail changes a search param, not a route segment,
   * so Next resolves it as a soft navigation: the loader never mounts, and
   * React holds the ENTIRE previous screen — old transcript, old sidebar,
   * old map — until the new payload arrives. On a signed-in session that is
   * middleware's `getUser` plus `listThreads` and `getThread` against the
   * database, which is the 2–3 seconds during which clicking a conversation
   * did nothing you could see. People clicked it again.
   *
   * `startTransition` is what makes the wait observable. Without it the
   * router still navigates and `pending` is never true, so there is nothing
   * to render a skeleton from; `router.push` inside one is the supported
   * way to ask React for the pending flag on an App Router navigation.
   *
   * Nothing resets `opening` — the page keys ChatView on the open thread, so
   * a committed navigation replaces this instance outright. `navigating`
   * going false is what takes the skeleton down if the router bails.
   */
  const [opening, setOpening] = useState<string | null>(null);
  const [navigating, startNavigation] = useTransition();

  const go = useCallback(
    (href: string) => {
      setRailOpen(false);
      setOpening(href);
      startNavigation(() => router.push(href));
    },
    [router],
  );

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
  /**
   * Whether the home page's sentence has already been sent.
   *
   * A ref and not state: the effect below depends on `send`, whose identity
   * changes on every token that arrives, so it re-runs constantly during
   * the very turn it started. This is what makes it fire once.
   */
  const askedRef = useRef(false);

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

        /**
         * Every non-2xx, not just the ones with no body.
         *
         * This used to read `!response.ok && !response.body`, which can
         * never be true: `/api/chat` reports its refusals with
         * `NextResponse.json(...)`, and a JSON response always HAS a body.
         * So the rate limit, the 400s, the missing API key and the daily
         * cap all fell through to the NDJSON reader — where they happened
         * to work, because a one-line JSON error frame is indistinguishable
         * from a one-line NDJSON error frame.
         *
         * Happened to. The case that does not survive it is an error that
         * is not our JSON at all: a 502 or a 504 from a proxy, which comes
         * back as HTML. The reader would parse nothing, dispatch nothing
         * and return; the `finally` below would strip the empty bubble; and
         * the visitor would be left having pressed Send with absolutely
         * nothing on screen — no answer and no error. Reading the status is
         * the whole fix.
         */
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as ChatEvent | null;
          setError(
            payload && payload.type === 'error'
              ? payload.message
              : 'The guide is unavailable right now.',
          );
          return;
        }

        /**
         * A 200 that carries nothing is the same dead end by another route.
         *
         * `readChatStream` returns immediately on a null body, and a stream
         * that is cut before its first frame dispatches no events at all.
         * Either way nothing would be said, so the count is checked rather
         * than assumed.
         */
        let frames = 0;

        await readChatStream(response, (event) => {
          frames += 1;
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

            case 'suggestions':
              setTurns((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last) next[next.length - 1] = { ...last, suggestions: event.items };
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
        // Silence is not success. Nothing arrived, so say so rather than
        // quietly removing the bubble and leaving the page as it was.
        if (frames === 0) setError('The guide did not answer. Please try again.');
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

  /**
   * Send the sentence the home page collected, exactly once.
   *
   * The query is stripped BEFORE the request goes out, not after it comes
   * back: a turn takes seconds, and a reload inside that window would
   * otherwise arrive on `/chat?ask=…` again and ask the guide — and bill a
   * model call — a second time. `replaceState` rather than a router
   * navigation, for the same reason the `saved` frame uses it: this view is
   * keyed on the thread, and a real navigation would remount it and throw
   * away the turn that is mid-flight.
   */
  useEffect(() => {
    if (!initialAsk || askedRef.current) return;
    askedRef.current = true;
    if (window.location.search) {
      window.history.replaceState(window.history.state, '', '/chat');
    }
    void send(initialAsk);
  }, [initialAsk, send]);

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
    setRailOpen(false);
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

  /**
   * New chat, wherever it is pressed from.
   *
   * Two shapes, one meaning. When the URL names a conversation — `?thread=`
   * or `?history=1` — the page has server state that has to be thrown away,
   * so it is a real navigation. When it does not, pushing `/chat` is a no-op
   * the router drops on the floor and the turns would simply stay on screen,
   * so the view clears itself instead.
   */
  const startNew = useCallback(() => {
    setRailOpen(false);
    if (historyOpen || initialThreadId) {
      go('/chat');
      return;
    }
    startFresh();
  }, [go, historyOpen, initialThreadId, startFresh]);

  /**
   * The screen the click asked for, read back off the href it pushed.
   *
   * Only while the transition is actually pending: `opening` outlives it by
   * a render or two and a skeleton that outlives its navigation is worse
   * than none. Three shapes because `/chat` has three — the hero, a
   * transcript, the history list — and they do not share a layout, so
   * drawing the wrong one would mean the real page arrives into a different
   * geometry, which is the relayout the skeleton exists to prevent.
   */
  const openingView: 'thread' | 'history' | 'new' | null =
    navigating && opening
      ? opening.includes('history=1')
        ? 'history'
        : opening.includes('thread=')
          ? 'thread'
          : 'new'
      : null;

  /** Layout, from the pending screen when there is one and this one otherwise. */
  const shape: 'thread' | 'history' | 'new' =
    openingView ?? (historyOpen ? 'history' : empty ? 'new' : 'thread');

  /**
   * The title of the conversation being opened, from the rail's own row.
   *
   * It is already on the client — the rail is rendering it — so the toolbar
   * can name the conversation before the server has said a word about it.
   * Without this the header keeps the PREVIOUS chat's title over a skeleton
   * of the next one, which is a worse lie than an empty header.
   */
  const openingTitle =
    openingView === 'thread'
      ? (threads.find((thread) => opening === `/chat?thread=${thread.id}`)?.title ?? null)
      : null;

  /*
    The brief and the map belong to the conversation on screen, and during a
    navigation there isn't one. Handing the sidebar the OLD search while the
    transcript beside it is a skeleton is the stale-screen bug in miniature.
  */
  const shownSlots = openingView ? null : slots;
  const shownResults = openingView ? null : results;

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
            const value = shownSlots ? field.format(shownSlots) : null;
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

      <ResultsPanel results={shownResults} embedded />
    </aside>
  );

  return (
    /*
      Two columns at the top level: the rail, and everything else.

      The rail is a sibling of the content rather than a third track inside
      `.split`, and that is what keeps the hero centred. `.pageEmpty .split`
      is a centred, max-width block — put the rail inside it and the
      headline centres against the remaining space instead of against the
      column it belongs to, which reads as a page that has slipped sideways.
    */
    <div
      className={`${styles.page} ${
        shape === 'history'
          ? styles.pageHistory
          : shape === 'new'
            ? styles.pageEmpty
            : styles.pageActive
      }`}
    >
      <HistoryRail
        threads={threads}
        signedIn={signedIn}
        activeId={initialThreadId}
        historyOpen={historyOpen}
        open={railOpen}
        onClose={closeRail}
        onNewChat={startNew}
        pendingHref={navigating ? opening : null}
        onOpen={go}
      />

      <div className={styles.content}>
      {shape === 'thread' ? (
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
            Search{shownResults ? ` (${shownResults.listings.length})` : ''}
          </button>
        </div>
      ) : null}

      <div className={styles.split}>
        <section
          className={`${styles.main} ${shape === 'thread' && tab === 'results' ? styles.hiddenMobile : ''}`}
          aria-label={shape === 'history' ? 'Past conversations' : 'Conversation'}
        >
          <ChatToolbar
            count={threads.length}
            historyOpen={historyOpen}
            activeTitle={openingView ? openingTitle : historyOpen ? null : liveTitle}
            onNewChat={startNew}
            onOpenRail={openRail}
          />

          {openingView ? (
            <OpeningSkeleton view={openingView} />
          ) : historyOpen ? (
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

                        {/*
                          The server's offer of a next step.

                          Only on the LAST turn, and never while a reply is
                          streaming. Chips on every answer turn the transcript
                          into a wall of buttons, and the ones higher up are
                          stale: they describe a search two questions ago.
                          Sending a new message makes this turn no longer last,
                          so the old chips retire by themselves.

                          Every one of these costs a billed turn to press, so
                          they are disabled while one is in flight — the same
                          rule the composer's own chips follow.
                        */}
                        {turn.suggestions?.length && i === turns.length - 1 && !streaming ? (
                          <div className={styles.suggests}>
                            {turn.suggestions.map((s) => (
                              <button
                                key={s.kind}
                                type="button"
                                className={styles.chipBtn}
                                onClick={() => send(s.send)}
                                disabled={streaming}
                              >
                                {s.label}
                              </button>
                            ))}
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
            </>
          )}
        </section>

        {shape === 'thread' ? sidebar : null}
      </div>
      </div>
    </div>
  );
}
