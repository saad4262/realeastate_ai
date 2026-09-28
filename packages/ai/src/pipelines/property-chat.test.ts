import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import type { ResolvedPlace } from '@repo/core/geo/schema';
import type { PublicListing } from '@repo/core/listings';
import type { ChatEvent } from '../schemas/chat-events';
import type { ToolContext } from '../tools';
import { reconstructMessages, runPropertyChat, type PropertyChatInput } from './property-chat';

/** Typed so mock.calls keeps its shape — an untyped vi.fn() erases the argument. */
type TrackRow = Parameters<PropertyChatInput['track']>[0];
const trackSpy = () => vi.fn(async (_row: TrackRow) => {});

const PLACE: ResolvedPlace = {
  placeId: null,
  formatted: 'Pakenham VIC 3810, Australia',
  unit: null,
  streetNumber: null,
  street: null,
  suburb: 'Pakenham',
  state: 'VIC',
  postcode: '3810',
  latitude: -38.0709,
  longitude: 145.4844,
  kind: 'locality',
};

const LISTING: PublicListing = {
  id: '00000000-0000-4000-8000-000000000001',
  propertyId: '00000000-0000-4000-8000-000000000901',
  address: '8 Henry St, Pakenham VIC 3810',
  suburb: 'Pakenham',
  state: 'VIC',
  postcode: '3810',
  channel: 'sale',
  headline: null,
  description: null,
  priceDisplay: null,
  priceFrom: 780_000,
  priceTo: null,
  rentPw: null,
  bedrooms: 3,
  bathrooms: 2,
  carSpaces: 2,
  propertyType: 'House',
  landAreaSqm: 450,
  latitude: -38.07,
  longitude: 145.48,
  distanceKm: null,
  agencyName: 'Saadiii',
  mainPhotoKey: null,
  agents: [],
  publishedAt: null,
};

function textDelta(text: string) {
  return { type: 'content_block_delta', delta: { type: 'text_delta', text } } as const;
}

function message(over: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
    ...over,
  } as Anthropic.Message;
}

/**
 * A stand-in for client.messages.stream.
 *
 * Each queued turn is a list of stream events plus the final message, so a
 * whole multi-round conversation is declared up front. It also records the
 * params it was called with, which is how the cache-prefix and tool_choice
 * assertions below are made.
 */
function fakeClient(turns: { events: unknown[]; final: Anthropic.Message }[]) {
  const calls: Record<string, unknown>[] = [];
  let i = 0;

  const client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        calls.push(params);
        const turn = turns[Math.min(i, turns.length - 1)];
        i += 1;
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of turn!.events) yield event;
          },
          finalMessage: async () => turn!.final,
        };
      },
    },
  } as unknown as Anthropic;

  return { client, calls };
}

function tools(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as Db,
    places: new Map(),
    // These tests are about finding homes, not scheduling. `signed_out` is
    // the honest default: no session, so the scheduling tools refuse.
    scheduling: { state: 'signed_out' },
    resolvePlace: vi.fn(async () => PLACE),
    search: vi.fn(async () => [LISTING]),
    getListing: vi.fn(async () => LISTING),
    nearbyMarket: vi.fn(async () => ({ listings: [], bySuburb: [], unpriced: 0 })),
    ...over,
  };
}

async function collect(gen: AsyncGenerator<ChatEvent, void, void>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const SEARCH_CALL: Anthropic.ToolUseBlock = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'search_listings',
  caller: { type: 'direct' },
  input: { channel: 'sale', suburb: 'Pakenham', priceTo: 900_000, bedrooms: 3 },
};

describe('runPropertyChat', () => {
  it('streams a plain answer with no tools', async () => {
    const { client } = fakeClient([
      {
        events: [textDelta('What is '), textDelta('your budget?')],
        final: message({ content: [{ type: 'text', text: 'What is your budget?', citations: [] }] }),
      },
    ]);
    const track = trackSpy();

    const events = await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'I want a house', turns: [] },
        catalogue: { suburbs: ['Pakenham'], propertyTypes: ['House'] },
        tools: tools(),
        track,
      }),
    );

    expect(events.map((e) => e.type)).toEqual(['turn', 'text', 'text', 'state', 'done']);
    expect(track).toHaveBeenCalledTimes(1);
    // Nothing was searched, so there is nothing to link to.
    const state = events.find((e) => e.type === 'state');
    expect(state?.type === 'state' && state.deepLink).toBeNull();
    expect(state?.type === 'state' && state.missing).toContain('channel');
  });

  it('emits results for the panel and writes one ai_run per request', async () => {
    const { client } = fakeClient([
      { events: [], final: message({ stop_reason: 'tool_use', content: [SEARCH_CALL] }) },
      {
        events: [textDelta('Found one in Pakenham.')],
        final: message({ content: [{ type: 'text', text: 'Found one in Pakenham.', citations: [] }] }),
      },
    ]);
    const track = trackSpy();

    const events = await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: '3 bed under 900k in Pakenham', turns: [] },
        catalogue: { suburbs: ['Pakenham'], propertyTypes: ['House'] },
        tools: tools(),
        track,
      }),
    );

    expect(events.map((e) => e.type)).toEqual([
      'turn',
      'tool',
      'results',
      'text',
      'state',
      'done',
    ]);

    // Two API requests, two rows, correlated by the turn they belonged to.
    expect(track).toHaveBeenCalledTimes(2);
    const ids = track.mock.calls.map(([row]) => row.entityId);
    expect(ids[0]).toBe(ids[1]);

    const results = events.find((e) => e.type === 'results');
    expect(results?.type === 'results' && results.listings).toHaveLength(1);
    expect(results?.type === 'results' && results.deepLink).toContain('suburb=Pakenham');

    const state = events.find((e) => e.type === 'state');
    expect(state?.type === 'state' && state.slots.suburb).toBe('Pakenham');
    expect(state?.type === 'state' && state.missing).toEqual([]);
    // The turn-level link, from the accumulated brief rather than the last tool
    // call. The chat falls back to it on a turn that asked a question instead of
    // searching, so it has to be a real path and it has to carry the brief.
    expect(state?.type === 'state' && state.deepLink).toMatch(/^\/search\?/);
    expect(state?.type === 'state' && state.deepLink).toContain('suburb=Pakenham');
    // Same rule as the results frame: a named suburb is re-resolved server-side.
    expect(state?.type === 'state' && state.deepLink).not.toContain('lat=');
  });

  it('makes the model answer in words once it has used its tool rounds', async () => {
    // A model that keeps searching must still leave the visitor with something
    // to read rather than a spinner.
    const { client, calls } = fakeClient([
      { events: [], final: message({ stop_reason: 'tool_use', content: [SEARCH_CALL] }) },
      { events: [], final: message({ stop_reason: 'tool_use', content: [SEARCH_CALL] }) },
      { events: [], final: message({ stop_reason: 'tool_use', content: [SEARCH_CALL] }) },
      {
        events: [textDelta('Here is what I found.')],
        final: message({ content: [{ type: 'text', text: 'Here is what I found.', citations: [] }] }),
      },
    ]);

    const events = await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'keep looking', turns: [] },
        catalogue: { suburbs: [], propertyTypes: [] },
        tools: tools(),
        track: trackSpy(),
      }),
    );

    expect(calls).toHaveLength(4);
    expect(calls[0]?.tool_choice).toBeUndefined();
    expect(calls[3]?.tool_choice).toEqual({ type: 'none' });
    expect(events.at(-1)).toMatchObject({ type: 'done', rounds: 3 });
  });

  it('stops on an aborted signal and still records what was spent', async () => {
    const { client, calls } = fakeClient([
      { events: [], final: message({ content: [] }) },
    ]);
    const track = trackSpy();
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'hello', turns: [] },
        catalogue: { suburbs: [], propertyTypes: [] },
        tools: tools(),
        track,
        signal: controller.signal,
      }),
    );

    // Never called the model, so nothing was spent on this turn.
    expect(calls).toHaveLength(0);
    expect(track).not.toHaveBeenCalled();
    // The turn still closes cleanly rather than hanging.
    expect(events.map((e) => e.type)).toEqual(['turn', 'state', 'done']);
  });

  it('reports a refusal as an error frame rather than empty content', async () => {
    const { client } = fakeClient([
      { events: [], final: message({ stop_reason: 'refusal', content: [] }) },
    ]);

    const events = await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'something off-topic', turns: [] },
        catalogue: { suburbs: [], propertyTypes: [] },
        tools: tools(),
        track: trackSpy(),
      }),
    );

    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'refusal' });
  });

  it('caches the system prompt and keeps the tool list identical between turns', async () => {
    // tools render before system, which renders before messages. If either the
    // tool array or the frozen prompt is rebuilt per request, every cache read
    // on this route is lost and nothing on screen says so.
    const { client, calls } = fakeClient([
      { events: [], final: message({ stop_reason: 'tool_use', content: [SEARCH_CALL] }) },
      { events: [], final: message({ content: [] }) },
    ]);

    await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'hi', turns: [] },
        catalogue: { suburbs: ['Pakenham'], propertyTypes: ['House'] },
        tools: tools(),
        track: trackSpy(),
      }),
    );

    const system = calls[0]?.system as { cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(calls[1]?.system).toEqual(calls[0]?.system);
    expect(calls[1]?.tools).toEqual(calls[0]?.tools);
  });

  it('sends every tool result in one user message', async () => {
    // Splitting them teaches the model to stop making parallel calls, quietly.
    const two = [
      SEARCH_CALL,
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'resolve_location',
        caller: { type: 'direct' },
        input: { place: 'Officer' },
      } satisfies Anthropic.ToolUseBlock,
    ];
    const { client, calls } = fakeClient([
      { events: [], final: message({ stop_reason: 'tool_use', content: two }) },
      { events: [], final: message({ content: [] }) },
    ]);

    await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'compare two suburbs', turns: [] },
        catalogue: { suburbs: [], propertyTypes: [] },
        tools: tools(),
        track: trackSpy(),
      }),
    );

    const messages = calls[1]?.messages as Anthropic.MessageParam[];
    const results = messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toHaveLength(2);
  });
});

describe('reconstructMessages', () => {
  it('never replays a tool result, only a line the server wrote', async () => {
    // The client holds the transcript. A client that could send a tool result
    // could send a price the database never quoted — non-negotiable #4.
    const messages = reconstructMessages({
      message: 'tell me about the second one',
      turns: [
        { role: 'user', text: '3 bed in Pakenham' },
        {
          role: 'assistant',
          text: 'Found a few.',
          searches: [
            {
              query: { channel: 'sale', suburb: 'Pakenham' },
              matched: 37,
              shown: 8,
            },
          ],
        },
      ],
    });

    const json = JSON.stringify(messages);
    expect(json).not.toContain('tool_result');
    expect(json).not.toContain('tool_use');
    expect(json).toContain('[searched: sale · in Pakenham → 37 matches, 8 shown]');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'tell me about the second one' });
  });

  it('carries the known requirements as an operator instruction, not as the visitor speaking', async () => {
    const messages = reconstructMessages(
      {
        message: 'anything cheaper?',
        turns: [],
        slots: { channel: 'sale', suburb: 'Pakenham', priceTo: 900_000 },
      },
      { midConversationSystem: true },
    );

    const last = messages.at(-1)!;
    expect(last.role).toBe('system');
    expect(String(last.content)).toContain('known_requirements');
    // The visitor's own message is still its own turn, unmodified.
    expect(messages.at(-2)).toEqual({ role: 'user', content: 'anything cheaper?' });
  });

  it('adds no system message when the model was not said to accept one', async () => {
    /**
     * The default is the fix.
     *
     * This function used to push `{ role: 'system' }` unconditionally, and on
     * Haiku — which this route runs — that is
     * `400 role 'system' is not supported on this model`. A caller that does
     * not say whether the model has the capability must get the carrier every
     * model accepts, not the one that works on two families.
     *
     * runPropertyChat then puts the requirements on the system array instead;
     * that half is asserted further down, against the recorded request.
     */
    const messages = reconstructMessages({
      message: 'anything cheaper?',
      turns: [],
      slots: { channel: 'sale', suburb: 'Pakenham', priceTo: 900_000 },
    });

    expect(messages.map((m) => m.role)).not.toContain('system');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'anything cheaper?' });
  });

  it('adds no system message when nothing is known yet', async () => {
    const messages = reconstructMessages({ message: 'hi', turns: [] });
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops the oldest turns when the history grows past its budget', async () => {
    const long = 'x'.repeat(3000);
    const turns = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `${i}:${long}`,
    }));

    const messages = reconstructMessages({ message: 'and now?', turns });

    expect(messages.length).toBeLessThan(13);
    // Compare on the turn index each message opens with, not on a substring of
    // the whole blob — "0:" is inside "10:" and would always be found.
    const indices = messages
      .map((m) => /^(\d+):/.exec(String(m.content))?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);

    // The freshest context survives; the opening turns are what go.
    expect(indices).toContain(11);
    expect(indices).not.toContain(0);
    expect(Math.min(...indices)).toBeGreaterThan(0);
    // And the visitor's actual question is always the last thing said.
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'and now?' });
  });

  it('skips a turn with no text and no searches rather than sending empty content', async () => {
    const messages = reconstructMessages({
      message: 'hello',
      turns: [{ role: 'assistant', text: '   ' }],
    });
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

/**
 * What actually goes on the wire.
 *
 * This is the layer the Haiku switch broke and the layer nothing was testing.
 * `output_config: { effort }` and `thinking: { type: 'adaptive' }` are rejected
 * with HTTP 400 by a model that does not implement them — Haiku 4.5 rejects
 * both — so sending them is not a wasted parameter, it is a chat that answers
 * nothing. getModel decides; this asserts the request obeys it.
 *
 * A fake client accepts any params at all, which is precisely why the assertion
 * has to read the recorded params rather than trust the call to have succeeded.
 */
describe('the request body only carries parameters the model accepts', () => {
  const answer = () => ({
    events: [textDelta('Sure.')],
    final: message({ content: [{ type: 'text', text: 'Sure.', citations: [] }] }),
  });

  async function paramsFor(env: NodeJS.ProcessEnv) {
    const { client, calls } = fakeClient([answer()]);
    await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'a house in Pakenham', turns: [] },
        catalogue: { suburbs: ['Pakenham'], propertyTypes: ['House'] },
        tools: tools(),
        track: trackSpy(),
        env,
      }),
    );
    return calls[0]!;
  }

  it('omits both keys entirely on Haiku', async () => {
    const params = await paramsFor({ ANTHROPIC_CHAT_MODEL: 'claude-haiku-4-5' } as NodeJS.ProcessEnv);
    expect(params.model).toBe('claude-haiku-4-5');
    // `in`, not a truthiness check: a key present with an undefined value is
    // still a key, and the SDK has been known to serialise one.
    expect('output_config' in params).toBe(false);
    expect('thinking' in params).toBe(false);
  });

  it('sends both on a model that accepts them', async () => {
    const params = await paramsFor({ ANTHROPIC_CHAT_MODEL: 'claude-opus-5' } as NodeJS.ProcessEnv);
    expect(params.output_config).toEqual({ effort: 'medium' });
    expect(params.thinking).toEqual({ type: 'adaptive' });
  });

  it('omits both on an unrecognised model', async () => {
    const params = await paramsFor({
      ANTHROPIC_CHAT_MODEL: 'claude-something-7',
    } as NodeJS.ProcessEnv);
    expect('output_config' in params).toBe(false);
    expect('thinking' in params).toBe(false);
  });

  it('keeps max_tokens whatever the model is', async () => {
    for (const id of ['claude-haiku-4-5', 'claude-opus-5']) {
      const params = await paramsFor({ ANTHROPIC_CHAT_MODEL: id } as NodeJS.ProcessEnv);
      expect(params.max_tokens).toBe(4096);
    }
  });
});

/**
 * The second capability to take this route down.
 *
 * `{ role: 'system' }` inside `messages` is a real feature — a mid-conversation
 * operator instruction that does not invalidate the cached prefix — and it is
 * implemented on the Opus and Fable families only. Haiku 4.5, which this route
 * runs, answers `400 role 'system' is not supported on this model`.
 *
 * It fired only once the guide had gathered a requirement worth sending, so the
 * opening turns of every conversation worked and the rest did not, and the
 * visitor saw "Something went wrong reaching the assistant" halfway through.
 *
 * Both halves are asserted, because "it no longer 400s" is satisfied by simply
 * dropping the requirements on the floor. They have to still reach the model.
 */
describe('the accumulated requirements reach the model by a carrier it accepts', () => {
  const SLOTS = { channel: 'rent' as const, suburb: 'Berwick', priceTo: 800 };

  const answer = () => ({
    events: [textDelta('Right.')],
    final: message({ content: [{ type: 'text', text: 'Right.', citations: [] }] }),
  });

  async function paramsFor(modelId: string, slots?: Record<string, unknown>) {
    const { client, calls } = fakeClient([answer()]);
    await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'i need in berwick', turns: [], ...(slots ? { slots } : {}) },
        catalogue: { suburbs: ['Berwick'], propertyTypes: ['House'] },
        tools: tools(),
        track: trackSpy(),
        env: { ANTHROPIC_CHAT_MODEL: modelId } as NodeJS.ProcessEnv,
      }),
    );
    return calls[0]!;
  }

  const systemText = (params: { system?: unknown }) =>
    ((params.system ?? []) as { text?: string }[]).map((b) => b.text ?? '').join('\n');

  it('never puts a system role in messages on Haiku', async () => {
    const params = await paramsFor('claude-haiku-4-5', SLOTS);
    const roles = (params.messages as { role: string }[]).map((m) => m.role);
    expect(roles).not.toContain('system');
  });

  it('still sends the requirements on Haiku, as a trailing system block', async () => {
    const params = await paramsFor('claude-haiku-4-5', SLOTS);
    expect(systemText(params)).toContain('<known_requirements>');
    expect(systemText(params)).toContain('Berwick');

    // After the cached blocks and uncached itself. Caching is a prefix match,
    // so a breakpoint here would rewrite the prefix every turn and cache
    // nothing — the frozen prompt and the catalogue must stay in front of it.
    const blocks = params.system as { cache_control?: unknown; text: string }[];
    const last = blocks.at(-1)!;
    expect(last.text).toContain('<known_requirements>');
    expect('cache_control' in last).toBe(false);
    expect(blocks.slice(0, -1).every((b) => 'cache_control' in b)).toBe(true);
  });

  it('uses the message carrier on a model that has it, and not both', async () => {
    const params = await paramsFor('claude-opus-5', SLOTS);
    const messages = params.messages as { role: string; content: unknown }[];
    const system = messages.filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(String(system[0]!.content)).toContain('<known_requirements>');

    // Not duplicated onto the system array — the model would read the same
    // requirements twice, once stale.
    expect(systemText(params)).not.toContain('<known_requirements>');
  });

  it('places the system message where the API allows it', async () => {
    /**
     * Three rules, all rejected by the API rather than ignored: it may not be
     * messages[0], it must follow a user turn, and it must be either the last
     * entry or followed by an assistant turn.
     *
     * The array read here is the SAME array the tool loop keeps appending to —
     * the fake client records the params object by reference — so by the time
     * this runs the assistant turn is already on the end. That is the second
     * of the two legal shapes, and asserting "must be last" instead failed
     * against a request that was perfectly valid.
     */
    const params = await paramsFor('claude-opus-5', SLOTS);
    const messages = params.messages as { role: string }[];
    const at = messages.findIndex((m) => m.role === 'system');

    expect(at).toBeGreaterThan(0);
    expect(messages[at - 1]!.role).toBe('user');

    const after = messages[at + 1];
    expect(after === undefined || after.role === 'assistant').toBe(true);
  });

  it('sends no requirements at all when none have been gathered', async () => {
    for (const id of ['claude-haiku-4-5', 'claude-opus-5']) {
      const params = await paramsFor(id);
      expect((params.messages as { role: string }[]).map((m) => m.role)).not.toContain('system');
      expect(systemText(params)).not.toContain('<known_requirements>');
    }
  });

  it('omits the message carrier on an unrecognised model', async () => {
    // Unknown ids fall to NO_CAPABILITIES. Guessing the other way would be a
    // 400 on every turn of every conversation that got as far as a requirement.
    const params = await paramsFor('claude-something-7', SLOTS);
    expect((params.messages as { role: string }[]).map((m) => m.role)).not.toContain('system');
    expect(systemText(params)).toContain('<known_requirements>');
  });
});

/**
 * Two rounds of prose are two thoughts, not one run-on sentence.
 *
 * A turn that searches says what it is about to do, calls the tool, then
 * reports what it found — and the client appends every delta to one string.
 * With nothing between them the visitor read
 *
 *   "…within 30 km of Pakenham.Within 30 km of Pakenham there are 3 homes…"
 *
 * which was on screen in the bug report that started this.
 */
describe('text from separate rounds is separated', () => {
  const searchCall = () => ({
    events: [textDelta("Now I'll search for homes near Pakenham.")],
    final: message({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: "Now I'll search for homes near Pakenham.", citations: [] },
        SEARCH_CALL,
      ],
    }),
  });
  const reply = () => ({
    events: [textDelta('Within 30 km of Pakenham there are 3 homes.')],
    final: message({
      content: [{ type: 'text', text: 'Within 30 km of Pakenham there are 3 homes.', citations: [] }],
    }),
  });

  async function fullText() {
    const { client } = fakeClient([searchCall(), reply()]);
    const events = await collect(
      runPropertyChat({
        apiKey: 'test-key',
        client,
        request: { message: 'a house in Pakenham', turns: [] },
        catalogue: { suburbs: ['Pakenham'], propertyTypes: ['House'] },
        tools: tools(),
        track: trackSpy(),
        env: { ANTHROPIC_CHAT_MODEL: 'claude-haiku-4-5' } as NodeJS.ProcessEnv,
      }),
    );
    return events
      .filter((e): e is Extract<typeof e, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
  }

  it('puts a blank line between the two halves', async () => {
    const text = await fullText();
    expect(text).not.toContain('Pakenham.Within');
    expect(text).toContain('Pakenham.\n\nWithin');
  });

  it('adds nothing before the first round', async () => {
    // The separator is emitted on the first delta of a LATER round, so a turn
    // never opens with a blank line.
    const text = await fullText();
    expect(text.startsWith("Now I'll")).toBe(true);
  });
});
