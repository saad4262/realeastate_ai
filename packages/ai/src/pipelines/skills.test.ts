import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { createSkillWriter } from './skills';

/** A fake client: records the request, answers what it is told. Never the network. */
function fakeClient(text: string, stop: string = 'end_turn') {
  const calls: unknown[] = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        calls.push(req);
        return {
          content: [{ type: 'text', text }],
          stop_reason: stop,
          usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function fakeDb() {
  const rows: unknown[] = [];
  const db = { insert: () => ({ values: async (v: unknown) => { rows.push(v); } }) } as unknown as Db;
  return { db, rows };
}

const input = {
  handler: 'morning_brief' as const,
  tier: 'summary' as const,
  instructions: 'Lead with appointments.',
  records: [{ ref: 'A1', text: 'Appraisal with Tom' }],
  today: 'Monday 6 October',
  runId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
};

describe('the skill writer', () => {
  it('uses Haiku for the summary tier, puts the date in the user turn only, and meters the call', async () => {
    const { client, calls } = fakeClient('Appraisal with Tom first [A1].');
    const { db, rows } = fakeDb();
    const out = await createSkillWriter({ apiKey: 'x', db, client, env: {} as NodeJS.ProcessEnv })(input);
    expect(out).toEqual({ text: 'Appraisal with Tom first [A1].', model: 'claude-haiku-4-5' });
    const req = calls[0] as { model: string; system: { text: string }[]; messages: { content: string }[]; output_config?: unknown };
    expect(req.model).toBe('claude-haiku-4-5');
    expect(req.system[0]!.text).not.toMatch(/Monday|October|20\d\d/);
    expect(req.messages[0]!.content).toContain('Today is Monday 6 October');
    expect(req.messages[0]!.content).toContain('[A1] Appraisal with Tom');
    // Haiku rejects effort: it must be absent, not defaulted.
    expect(req.output_config).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'skill:morning_brief', model: 'claude-haiku-4-5', entityId: input.runId, userId: input.userId });
  });

  it('treats a refusal or a cut-off answer as no answer — but still meters it', async () => {
    for (const stop of ['refusal', 'max_tokens']) {
      const { client } = fakeClient('partial', stop);
      const { db, rows } = fakeDb();
      const out = await createSkillWriter({ apiKey: 'x', db, client, env: {} as NodeJS.ProcessEnv })(input);
      expect(out.text).toBeNull();
      expect(rows).toHaveLength(1);
    }
  });

  it('sends effort only to a model that takes it', async () => {
    const { client, calls } = fakeClient('ok [A1].');
    const { db } = fakeDb();
    await createSkillWriter({ apiKey: 'x', db, client, env: { ANTHROPIC_SKILL_SUMMARY_MODEL: 'claude-sonnet-5-5' } as NodeJS.ProcessEnv })(input);
    expect((calls[0] as { output_config?: { effort: string } }).output_config).toEqual({ effort: 'low' });
  });
});
