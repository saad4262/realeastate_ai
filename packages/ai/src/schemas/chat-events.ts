import type { PublicListingSummary, PublicSearchQuery } from '@repo/core/listings';

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
  slots: PublicSearchQuery;
  /** What the guide still needs, for the client to hint at. */
  missing: string[];
  deepLink: string | null;
};

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

export type ChatEvent =
  | TurnEvent
  | TextEvent
  | ToolEvent
  | ResultsEvent
  | StateEvent
  | ErrorEvent
  | DoneEvent;

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
  error: ErrorEvent | null;
  stopReason: string | null;
  rounds: number;
};
