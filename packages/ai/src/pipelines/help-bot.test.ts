import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { answerHelp, type HelpAsk } from './help-bot';
import { helpSystem } from '../prompts/help-v1';

/** ADR 0088: the help bot's one request, against a fake model. */

function fakeClient(reply: Partial<{ text: string; stop: string }> = {}) {
  const create = vi.fn(async (_params: Record<string, unknown>) => ({
    stop_reason: reply.stop ?? 'end_turn',
    content: [{ type: 'text', text: reply.text ?? 'Open [Skills](/skills).' }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  const db = { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db;
  return { db, rows };
}

const ask: HelpAsk = { guide: '- Skills (/skills): switches.', pageName: 'Skills', messages: [{ role: 'user', text: 'where do I turn on bulk email' }], userId: 'u1', agencyId: 'a1' };

describe('answerHelp', () => {
  it('sends no tools, and the page by its name in the last message', async () => {
    const { client, create } = fakeClient();
    const { db } = fakeDb();
    await answerHelp({ apiKey: 'test', db, client, env: {} as NodeJS.ProcessEnv }, ask);
    const params = create.mock.calls[0]![0];
    expect(params.tools).toBeUndefined();
    expect((params.messages as { content: string }[]).at(-1)!.content).toBe('<current_page>Skills</current_page>\nwhere do I turn on bulk email');
  });

  it('only the last message carries the page', async () => {
    const { client, create } = fakeClient();
    const { db } = fakeDb();
    await answerHelp({ apiKey: 'test', db, client, env: {} as NodeJS.ProcessEnv }, { ...ask, messages: [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'three' }] });
    const sent = create.mock.calls[0]![0].messages as { content: string }[];
    expect(sent[0]!.content).toBe('one');
    expect(sent[1]!.content).toBe('two');
    expect(sent[2]!.content).toContain('<current_page>');
  });

  it('caches a system prompt that holds no date, and is the same every time', () => {
    expect(helpSystem('g')).toBe(helpSystem('g'));
    expect(helpSystem('g')).not.toMatch(/20\d\d/);
  });

  it('meters every request, under help, with its cached tokens, and keeps no words', async () => {
    const { client } = fakeClient();
    const { db, rows } = fakeDb();
    await answerHelp({ apiKey: 'test', db, client, env: {} as NodeJS.ProcessEnv }, ask);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'help-bot', userId: 'u1', agencyId: 'a1', cacheReadTokens: 900, promptVersion: 'help@v1' });
    expect(JSON.stringify(rows[0])).not.toContain('bulk email');
  });

  it('runs on the cheap model', async () => {
    const { client, create } = fakeClient();
    const { db } = fakeDb();
    await answerHelp({ apiKey: 'test', db, client, env: {} as NodeJS.ProcessEnv }, ask);
    expect(create.mock.calls[0]![0].model).toBe('claude-haiku-4-5');
  });

  it('a refusal or an empty answer is no answer', async () => {
    const { db } = fakeDb();
    expect(await answerHelp({ apiKey: 'test', db, client: fakeClient({ stop: 'refusal' }).client, env: {} as NodeJS.ProcessEnv }, ask)).toBeNull();
    expect(await answerHelp({ apiKey: 'test', db, client: fakeClient({ text: '   ' }).client, env: {} as NodeJS.ProcessEnv }, ask)).toBeNull();
  });
});
