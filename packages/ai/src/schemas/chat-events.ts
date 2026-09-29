import type { PublicListingSummary, PublicSearchQuery } from '@repo/core/listings';
import type { ChatSlots } from './chat-request';

/**
 * What the chat route sends down the wire, one JSON object per line.
 *
 * THIS FILE IS THE ONLY PART OF @repo/ai THE BROWSER MAY TOUCH, and only with
 * `import type`. It imports no SDK and no database driver, because @repo/ai is
 * in the web app's transpilePackages list: one accidental value import from a
 * client component would pull the Anthropic client and postgres.js into the
 * browser bundle. Keep this file types-only.
 *
 * NDJSON rather than SSE: EventSource is the only zero-dependency SSE client
 * and it is GET-only, so it cannot carry a POST body. The client parses the
 * body by hand either way, and once you are doing that, one JSON object per
 * line beats event:/data:/blank-line framing.
 */

/** Opens the stream. Exists to flush the response head before the first token. */
export type TurnEvent = { type: 'turn'; id: string };

/** A piece of the assistant's reply. Concatenate into the open bubble. */
export type TextEvent = { type: 'text'; delta: string };

/** A tool started. The only signal while the model is thinking. */
export type ToolEvent = {
  type: 'tool';
  toolUseId: string;
  name: string;
  status: 'running';
  /** Something short and human: "Searching Pakenham…". Server-authored. */
  label: string;
};

/**
 * Listings for the panel beside the conversation.
 *
 * `query` is what the SERVER ran after validation — not what the model asked
 * for and not what the client claimed. The filter chips on screen are built
 * from this, so what the visitor reads is always what was searched.
 *
 * The panel renders these rows directly. It never renders model text, which is
 * what keeps non-negotiable #4 true on screen regardless of what the model says.
 */
export type ResultsEvent = {
  type: 'results';
  toolUseId: string;
  query: PublicSearchQuery;
  deepLink: string;
  /** Capped — `capped: true` means "at least this many". */
  matched: number;
  capped: boolean;
  listings: PublicListingSummary[];
};

/** The accumulated requirements after this turn. The client echoes `slots` back. */
export type StateEvent = {
  type: 'state';
  /**
   * Client-safe shape only — radius as a number, never lat/lng. See
   * `toClientSlots`. Echoing a PublicSearchQuery `near` here 400s the next turn.
   */
  slots: ChatSlots;
  /** What the guide still needs, for the client to hint at. */
  missing: string[];
  deepLink: string | null;
};

/**
 * One chip under an answer: the obvious next thing to ask.
 *
 * SERVER-AUTHORED, like the schedule card and unlike the answer above it.
 * The model does not write these, is never shown them, and cannot add one.
 * That is what keeps non-negotiable #4 true on a chip that quotes a price:
 * every figure in a `label` was either copied from the query the server had
 * just run, or formatted by `priceLabel` from a number Postgres returned.
 *
 * `label` and `send` differ on purpose. A chip has room for three words; the
 * guide answers a whole sentence far better than a fragment, and the sentence
 * is what lands in the transcript as the visitor's own words.
 *
 * Pressing one costs a full model turn, so the list is deliberately short —
 * see MAX_SUGGESTIONS in ../suggestions.ts.
 */
export type ChatSuggestionKind =
  /** A neighbouring suburb with cheaper live stock, named by SQL. */
  | 'nearby_cheaper'
  /** The suburb itself was empty and no radius had been tried. */
  | 'widen_radius'
  /** Nothing matched, and one filter the visitor gave is the likely cause. */
  | 'drop_filter'
  /** Several matches and nobody has asked which is cheapest yet. */
  | 'cheapest_first'
  /** Listings inside the radius that say "contact agent" and were not ranked. */
  | 'unpriced'
  /** Run this same search on a schedule and email what is new. */
  | 'schedule';

export type ChatSuggestion = {
  kind: ChatSuggestionKind;
  /** What the chip says. Short. */
  label: string;
  /** The message posted when it is pressed. A whole sentence. */
  send: string;
};

/**
 * The chips for this turn. Often absent — silence is the common case.
 *
 * Emitted once, after `state` and before `done`, so the client has the final
 * slot state before it draws anything that depends on it. A turn that failed
 * emits none: chips under an error message read as though the error were a
 * menu.
 */
export type SuggestionsEvent = { type: 'suggestions'; items: ChatSuggestion[] };

export type ChatErrorCode =
  | 'rate_limited'
  | 'daily_cap'
  | 'unconfigured'
  | 'bad_request'
  | 'upstream'
  | 'refusal';

export type ErrorEvent = { type: 'error'; code: ChatErrorCode; message: string };

export type DoneEvent = {
  type: 'done';
  stopReason: string | null;
  /** Tool round-trips this turn took. Useful in a log, harmless on screen. */
  rounds: number;
};

/**
 * The conversation was saved, and this is its id.
 *
 * Emitted by the ROUTE, not by the pipeline — the model knows nothing about
 * storage and `runPropertyChat` never yields this. It is in this union
 * because the browser has one NDJSON parser and giving storage a second one
 * would mean two things that must agree about a wire format.
 *
 * Only ever sent to a signed-in visitor. An anonymous conversation is not
 * stored, so there is no id and no frame.
 */
export type SavedEvent = { type: 'saved'; threadId: string };

/**
 * A schedule the guide has proposed and nobody has agreed to yet.
 *
 * `token` is an HMAC-signed copy of the whole draft. The browser may read
 * it and may hand it back on Accept; it cannot change the search or the
 * frequency inside it without the signature failing. Nothing is stored
 * until that Accept arrives.
 *
 * `search` and `cadence` are the SERVER's description of what will be
 * saved, not the model's — the card is what somebody is agreeing to, so it
 * has to say what the row will contain.
 */
export type ScheduleDraftEvent = {
  type: 'schedule_draft';
  toolUseId: string;
  token: string;
  search: string;
  cadence: string;
  searchPath: string;
};

export type ChatEvent =
  | TurnEvent
  | TextEvent
  | ToolEvent
  | ResultsEvent
  | StateEvent
  | ErrorEvent
  | DoneEvent
  | SavedEvent
  | ScheduleDraftEvent
  | SuggestionsEvent;

/**
 * The whole turn at once, for callers that cannot stream.
 *
 * `pnpm smoke` uses this, so the NDJSON parser never has to be written twice —
 * once in the browser and once in a test runner that would then be testing its
 * own copy rather than the one that ships.
 */
export type ChatTurnResult = {
  id: string;
  text: string;
  results: ResultsEvent[];
  state: StateEvent | null;
  /** The chips the turn ended with. Empty when it offered none. */
  suggestions: ChatSuggestion[];
  error: ErrorEvent | null;
  stopReason: string | null;
  rounds: number;
};
