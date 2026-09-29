import Anthropic from '@anthropic-ai/sdk';
import type { PublicSearchQuery } from '@repo/core/listings';
import { searchQueryToPath } from '@repo/core/listings';
import { getModel } from '../models';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V8 } from '../prompts/v8';
import { slotsToQuery } from '../schemas/chat-request';
import type { ChatEvent } from '../schemas/chat-events';
import { MAX_HISTORY_CHARS, toClientSlots, type ChatRequest, type ChatTurn } from '../schemas/chat-request';
import { buildSuggestions } from '../suggestions';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext, type TurnFacts } from '../tools';
import { trackAiRunQuietly } from '../usage';

const FEATURE = 'property-chat';

/**
 * Tool round-trips one turn may take before the model is made to answer.
 *
 * Three is enough for resolve → search → refine. On the fourth we re-issue with
 * tool_choice: 'none', so a model that has decided to keep searching still
 * leaves the visitor with words rather than a spinner.
 */
const MAX_TOOL_ROUNDS = 3;

export type PropertyChatInput = {
  /**
   * The key. The client is built here rather than passed in, so apps/ never
   * imports the Anthropic SDK at all — non-negotiable #3 in the strongest
   * form available: the app cannot call a model because it has no client.
   */
  apiKey: string;
  /** Test seam. Supplying one skips the real client; nothing in apps/ does. */
  client?: Anthropic;
  request: ChatRequest;
  catalogue: { suburbs: string[]; propertyTypes: string[] };
  tools: ToolContext;
  /** Writes ai_run. Injected so the pipeline does not choose a db handle. */
  track: (row: {
    model: string;
    usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
    latencyMs: number;
    entityId: string;
  }) => Promise<void>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

/**
 * Rebuild the conversation the server is willing to believe.
 *
 * Prior turns come back as plain text. Their tool_use and tool_result blocks
 * are NOT replayed — the client holds the transcript, and a client that could
 * send a tool result could send a price the database never quoted (#4).
 * Instead, a turn that searched gets one server-authored line appended, which
 * the server wrote from the query it ran.
 *
 * The consequence is deliberate: the model cannot quote an earlier listing's
 * price from memory and has to call get_listing. That is #4 enforced by
 * construction rather than by asking the model nicely.
 */
/**
 * The accumulated requirements, as operator text.
 *
 * One definition, two carriers. Which carrier is used is a property of the
 * model — see requirementsCarrier below — but the words are the same either
 * way, so they live here rather than being written twice and drifting.
 */
export function requirementsBlock(slots: PublicSearchQuery | undefined): string | null {
  if (!slots || Object.keys(slots).length === 0) return null;
  return (
    `<known_requirements>${JSON.stringify(slots)}</known_requirements>\n` +
    'Advisory only — what the visitor has told you so far. Do not read it back ' +
    'to them; use it to decide what is still missing.'
  );
}

export function reconstructMessages(
  request: ChatRequest,
  /**
   * Whether this model accepts `{ role: 'system' }` inside `messages`.
   *
   * Defaults to false, and the default is the point: a caller that forgets to
   * ask gets the carrier every model accepts, rather than the one that returns
   * HTTP 400 on all but the Opus and Fable families.
   */
  opts: { midConversationSystem?: boolean } = {},
): Anthropic.MessageParam[] {
  const kept: ChatTurn[] = [];
  let chars = request.message.length;

  // Newest first, so trimming drops the oldest context rather than the freshest.
  for (let i = request.turns.length - 1; i >= 0; i--) {
    const turn = request.turns[i];
    if (!turn) continue;
    const cost = turn.text.length + 160 * (turn.searches?.length ?? 0);
    if (chars + cost > MAX_HISTORY_CHARS) break;
    chars += cost;
    kept.unshift(turn);
  }

  const messages: Anthropic.MessageParam[] = [];

  for (const turn of kept) {
    const citations = (turn.searches ?? [])
      .map((s) => {
        const q = s.query as PublicSearchQuery;
        const where = q.near
          ? `within ${q.near.radiusKm} km of ${q.suburb ?? 'the searched point'}`
          : `in ${q.suburb ?? 'the searched area'}`;
        return `[searched: ${q.channel ?? 'any'} · ${where} → ${s.matched} matches, ${s.shown} shown]`;
      })
      .join(' ');

    const text = [turn.text, citations].filter(Boolean).join('\n\n');
    // A turn with neither text nor a search would be an empty content block,
    // which the API rejects.
    if (!text.trim()) continue;

    messages.push({ role: turn.role, content: text });
  }

  messages.push({ role: 'user', content: request.message });

  /**
   * The requirements gathered so far, as an operator instruction rather than
   * as words in the visitor's message.
   *
   * Never as text prepended to what the visitor typed: a visitor can close the
   * tag themselves and write their own requirements, which is the injection
   * this shape exists to avoid. Both carriers below are operator-authored.
   *
   * A mid-conversation system message is the better of the two when the model
   * has it — it sits after the conversation, so the requirements are the last
   * thing the model reads, and it is after every cache breakpoint so it costs
   * nothing in cache terms. But it is implemented on the Opus and Fable
   * families only. Sending it to Haiku, which this route runs, returns
   * `400 role 'system' is not supported on this model` and kills the turn.
   *
   * Placement, for the models that do accept it: it goes after the final user
   * message, so it is never messages[0] and it is either last or followed by
   * the assistant turn the tool loop appends. Both are required by the API.
   */
  const block = requirementsBlock(request.slots as PublicSearchQuery | undefined);
  if (block && opts.midConversationSystem) {
    messages.push({ role: 'system', content: block });
  }

  return messages;
}

/** What the guide still needs before a search is worth running. */
function missingSlots(slots: PublicSearchQuery): string[] {
  const missing: string[] = [];
  if (!slots.channel) missing.push('channel');
  if (!slots.suburb) missing.push('suburb');
  if (slots.priceTo === undefined) missing.push('priceTo');
  if (slots.bedrooms === undefined) missing.push('bedrooms');
  return missing;
}

function usageOf(usage: Anthropic.Usage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * One conversational turn, as a stream of events.
 *
 * The route handler serialises whatever this yields and does nothing else —
 * no business logic in apps/ (#10), and no LLM call outside packages/ai (#3).
 */
export async function* runPropertyChat(
  input: PropertyChatInput,
): AsyncGenerator<ChatEvent, void, void> {
  const { request, catalogue, tools, track, signal, env } = input;
  const client = input.client ?? new Anthropic({ apiKey: input.apiKey });
  const model = getModel(FEATURE, env ?? process.env);
  const turnId = crypto.randomUUID();

  /**
   * Seed the schedulable search from the brief the client carries.
   *
   * `tools` is built per HTTP request, so `lastSearch` starts empty on
   * every turn. Without this, "schedule that" on the turn after a search
   * made `draft_schedule` report that nothing had been searched, the model
   * re-ran the search to satisfy it, and the turn ran out of tool rounds
   * mid-sentence with no card on screen. Seen live.
   *
   * A real `search_listings` call still overwrites this with the query it
   * actually ran — this is only the floor, for the turn where the person
   * asks to schedule something they were shown a moment ago.
   */
  if (!tools.lastSearch && request.slots) {
    const carried = slotsToQuery(request.slots);
    if (carried) tools.lastSearch = carried as PublicSearchQuery;
  }

  yield { type: 'turn', id: turnId };

  const messages = reconstructMessages(request, {
    midConversationSystem: model.midConversationSystem,
  });

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: PROPERTY_CHAT_V8, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: catalogueBlock(catalogue.suburbs, catalogue.propertyTypes),
      cache_control: { type: 'ephemeral' },
    },
  ];

  /**
   * The fallback carrier, for a model with no system role in messages.
   *
   * A third system block, AFTER the two cached ones and deliberately without
   * `cache_control` of its own. Caching is a prefix match, so a block appended
   * past the last breakpoint changes every turn without invalidating anything
   * in front of it — the frozen prompt and the catalogue still come from the
   * cache. Putting the requirements in front of them, or adding a breakpoint
   * here, would rewrite the prefix on every turn and cache nothing.
   *
   * It loses one property the message carrier has: the requirements are read
   * before the conversation rather than after it. That is the cost of a model
   * that cannot take the better carrier, and it is a smaller cost than a 400.
   */
  const requirements = model.midConversationSystem
    ? null
    : requirementsBlock(request.slots as PublicSearchQuery | undefined);
  if (requirements) {
    system.push({ type: 'text', text: requirements });
  }

  let slots: PublicSearchQuery = { ...(request.slots as PublicSearchQuery | undefined) };
  /**
   * What the tools established, for the chips at the end of the turn.
   *
   * Accumulated beside `slots` rather than inside it: slots are the brief and
   * go back to the client to be echoed on the next request, while these are
   * facts about THIS turn only and are thrown away after the chips are built.
   */
  let facts: TurnFacts = {};
  /** A confirmation card went on screen. The chips must not offer a second. */
  let scheduleOffered = false;
  /** The turn ended in an error frame, so there is nothing to offer next. */
  let failed = false;
  let rounds = 0;
  /** Whether any round has produced prose yet — see the separator below. */
  let spokenSoFar = false;
  let stopReason: string | null = null;

  try {
    for (;;) {
      if (signal?.aborted) break;

      const startedAt = Date.now();
      const stream = client.messages.stream(
        {
          model: model.id,
          max_tokens: model.maxTokens,
          /*
           * Both of these are conditional because a model that does not
           * implement one rejects the entire request with HTTP 400 — there is no
           * "ignored if unsupported". Haiku 4.5 implements neither, so on the
           * current default both keys are absent. getModel owns which; this
           * file must not supply a fallback, because a fallback here is exactly
           * the 400 the capability table exists to prevent.
           */
          ...(model.adaptiveThinking ? { thinking: { type: 'adaptive' as const } } : {}),
          ...(model.effort ? { output_config: { effort: model.effort } } : {}),
          system,
          tools: [...PROPERTY_CHAT_TOOLS],
          // On the last permitted round the model is made to answer in words.
          ...(rounds >= MAX_TOOL_ROUNDS ? { tool_choice: { type: 'none' as const } } : {}),
          messages,
        },
        { signal },
      );

      /**
       * Rounds run together unless something separates them.
       *
       * A turn that searches writes text, calls a tool, then writes more — and
       * the client appends every delta to one string. With nothing between
       * them the visitor read
       *
       *   "…within 30 km of Pakenham.Within 30 km of Pakenham there are 3…"
       *
       * A blank line rather than a space, because the two halves are two
       * thoughts: one said what it was about to do, the other reports what it
       * found. The renderer turns it into a paragraph break.
       *
       * Emitted lazily — on the first delta of a later round, not at the top
       * of it — so a round that produces only a tool call and no prose does
       * not leave a trailing gap.
       */
      let wroteThisRound = false;

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (!wroteThisRound) {
            wroteThisRound = true;
            if (rounds > 0 && spokenSoFar) yield { type: 'text', delta: '\n\n' };
          }
          spokenSoFar = true;
          yield { type: 'text', delta: event.delta.text };
        }
      }

      const message = await stream.finalMessage();
      await track({
        model: model.id,
        usage: usageOf(message.usage),
        latencyMs: Date.now() - startedAt,
        entityId: turnId,
      });

      stopReason = message.stop_reason;

      if (message.stop_reason === 'refusal') {
        failed = true;
        yield {
          type: 'error',
          code: 'refusal',
          message: 'I cannot help with that one. Ask me about finding a property instead.',
        };
        break;
      }

      messages.push({ role: 'assistant', content: message.content });

      if (message.stop_reason !== 'tool_use') break;

      const uses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (uses.length === 0) break;

      const outcomes = await Promise.all(
        uses.map(async (use) => {
          const outcome = await dispatchTool(use.name, use.input, tools);
          return { use, outcome };
        }),
      );

      // Emitted after dispatch rather than before: a tool that answers from
      // place_cache finishes in a millisecond, and a "running" flash for
      // something already done is noise.
      for (const { use, outcome } of outcomes) {
        yield {
          type: 'tool',
          toolUseId: use.id,
          name: use.name,
          status: 'running',
          label: outcome.label ?? 'Working…',
        };
      }

      for (const { use, outcome } of outcomes) {
        if (outcome.slots) slots = { ...slots, ...outcome.slots };
        if (outcome.facts) facts = { ...facts, ...outcome.facts };
        if (outcome.scheduleDraft) {
          /**
           * The confirmation card.
           *
           * Yielded as its own frame rather than folded into the answer
           * text, because the person is about to agree to it: what they
           * press Accept on has to be the server's description of what
           * will be stored, not the model's account of what it did.
           */
          scheduleOffered = true;
          yield { type: 'schedule_draft', toolUseId: use.id, ...outcome.scheduleDraft };
        }

        if (outcome.resultsFrame) {
          yield { type: 'results', toolUseId: use.id, ...outcome.resultsFrame };
        }
      }

      /**
       * Every tool_result in ONE user message. Splitting them across several
       * messages silently teaches the model to stop making parallel calls.
       */
      messages.push({
        role: 'user',
        content: outcomes.map(({ use, outcome }) => ({
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: JSON.stringify(outcome.result),
          ...(outcome.isError ? { is_error: true } : {}),
        })),
      });

      rounds += 1;
      if (rounds > MAX_TOOL_ROUNDS) break;
    }
  } catch (err) {
    if (signal?.aborted) {
      // The visitor closed the tab. Not an error, and the ai_run rows for the
      // requests that did run were already written above.
      return;
    }
    console.error('[ai] property chat failed', err);
    failed = true;
    yield {
      type: 'error',
      code: 'upstream',
      message: 'Something went wrong reaching the assistant. Please try again.',
    };
  }

  const hasQuery = Boolean(slots.channel && slots.suburb);
  yield {
    type: 'state',
    slots: toClientSlots(slots),
    missing: missingSlots(slots),
    deepLink: hasQuery ? searchQueryToPath(slots) : null,
  };
  /**
   * The chips, after `state` and before `done`.
   *
   * After `state` because a chip and the slot panel describe the same brief
   * and the client should not paint them a frame apart. Before `done` because
   * a client is entitled to treat `done` as the end of the turn.
   *
   * Nothing is yielded when there is nothing to offer — an empty frame would
   * make the browser clear chips it never drew.
   */
  const suggestions = buildSuggestions({
    facts,
    slots,
    scheduling: tools.scheduling.state,
    scheduleOffered,
    failed,
  });
  if (suggestions.length > 0) yield { type: 'suggestions', items: suggestions };

  yield { type: 'done', stopReason, rounds };
}

/**
 * One import for the route handler.
 *
 * Deliberately re-exported here rather than left to the caller to assemble:
 * the route should have exactly one door into this package, so a future edit
 * cannot quietly reach past the pipeline into a tool or a prompt.
 */
export { FEATURE as PROPERTY_CHAT_FEATURE, PROMPT_VERSION, trackAiRunQuietly };
export { chatRequestSchema, toClientSlots, type ChatRequest } from '../schemas/chat-request';
export type { ChatEvent, ChatTurnResult } from '../schemas/chat-events';
export type { ToolContext } from '../tools';
