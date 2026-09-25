import Anthropic from '@anthropic-ai/sdk';
import type { PublicSearchQuery } from '@repo/core/listings';
import { searchQueryToPath } from '@repo/core/listings';
import { getModel } from '../models';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V6 } from '../prompts/v6';
import type { ChatEvent } from '../schemas/chat-events';
import { MAX_HISTORY_CHARS, toClientSlots, type ChatRequest, type ChatTurn } from '../schemas/chat-request';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from '../tools';
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
export function reconstructMessages(request: ChatRequest): Anthropic.MessageParam[] {
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
   * A mid-conversation system message sits after every cache breakpoint, so it
   * costs nothing in cache terms, and it carries operator authority — unlike a
   * block prepended to the user's text, which a visitor could imitate by
   * typing the closing tag themselves.
   */
  const slots = request.slots;
  if (slots && Object.keys(slots).length > 0) {
    messages.push({
      role: 'system',
      content: `<known_requirements>${JSON.stringify(slots)}</known_requirements>\nAdvisory only — what the visitor has told you so far. Do not read it back to them; use it to decide what is still missing.`,
    });
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

  yield { type: 'turn', id: turnId };

  const messages = reconstructMessages(request);
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: PROPERTY_CHAT_V6, cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: catalogueBlock(catalogue.suburbs, catalogue.propertyTypes),
      cache_control: { type: 'ephemeral' },
    },
  ];

  let slots: PublicSearchQuery = { ...(request.slots as PublicSearchQuery | undefined) };
  let rounds = 0;
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

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
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
