import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { createColumnMapper, createRowCleaner, importAssistFromEnv, IMPORT_ASSIST_PROMPT_VERSION } from './import-assist';
import { IMPORT_CLEAN_SYSTEM, IMPORT_MAP_SYSTEM } from '../prompts/import-assist-v1';
import { getModel, isPricedModel } from '../models';

/** ADR 0056: the import's two structured-output requests — metered, parsed, never the network. */

function fakeClient(parsed: unknown, stop = 'end_turn') {
  const calls: Record<string, unknown>[] = [];
  const options: unknown[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (req: Record<string, unknown>, opts: unknown) => {
          calls.push(req);
          options.push(opts);
          return { parsed_output: parsed, stop_reason: stop, usage: { input_tokens: 1200, output_tokens: 150 } };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls, options };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}
const env = {} as NodeJS.ProcessEnv;
const who = { importId: 'imp-1', agencyId: 'agency-1', userId: 'user-1' };

describe('the column mapper', () => {
  it('sends headings and the masked samples it was given, and returns the first column per field', async () => {
    const { client, calls, options } = fakeClient({ columns: [{ field: 'phone', column: 2 }, { field: 'phone', column: 3 }, { field: 'roles', column: 3 }] });
    const { db, rows } = fakeDb();
    const out = await createColumnMapper({ apiKey: 'x', db, client, env }).suggest({ headers: ['Name', 'Email', 'Mob', 'Type'], samples: [['Xxxx', 'x@x.xxx', '9999 999 999', 'Xxxxx']], ...who });
    expect(out).toEqual({ phone: 2, roles: 3 });
    const req = calls[0] as { messages: { content: string }[]; output_config: { format?: unknown; effort?: string }; thinking?: unknown; tools?: unknown };
    expect(JSON.parse(req.messages[0]!.content)).toMatchObject({ headers: ['Name', 'Email', 'Mob', 'Type'], samples: [['Xxxx', 'x@x.xxx', '9999 999 999', 'Xxxxx']] });
    expect(req.output_config.format).toBeTruthy();
    expect(req.output_config.effort).toBe('low');
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.tools).toBeUndefined();
    expect(options[0]).toMatchObject({ timeout: 30_000 });
    expect(rows[0]).toMatchObject({ feature: 'import-map', agencyId: 'agency-1', userId: 'user-1', entityId: 'imp-1', promptVersion: IMPORT_ASSIST_PROMPT_VERSION });
  });
});

describe('the row cleaner', () => {
  it('returns one fix per row, the first value per field', async () => {
    const { client } = fakeClient({ rows: [{ rowNumber: 7, fixes: [{ field: 'email', value: 'jane@x.com' }, { field: 'email', value: 'other@x.com' }, { field: 'name', value: 'Jane Smith' }] }] });
    const { db, rows } = fakeDb();
    const fixes = await createRowCleaner({ apiKey: 'x', db, client, env }).clean({ rows: [{ rowNumber: 7, values: { email: 'jane @ x.com' }, problems: [] }], ...who });
    expect(fixes).toEqual([{ rowNumber: 7, values: { email: 'jane@x.com', name: 'Jane Smith' } }]);
    expect(rows[0]).toMatchObject({ feature: 'import-clean', agencyId: 'agency-1' });
  });

  it('an unknown field name costs that entry, not the answer', async () => {
    const cleaner = createRowCleaner({ apiKey: 'x', db: fakeDb().db, client: fakeClient({ rows: [{ rowNumber: 3, fixes: [{ field: 'note', value: 'x' }, { field: 'phone', value: '0412 345 678' }] }] }).client, env });
    expect(await cleaner.clean({ rows: [], ...who })).toEqual([{ rowNumber: 3, values: { phone: '0412 345 678' } }]);
    const mapper = createColumnMapper({ apiKey: 'x', db: fakeDb().db, client: fakeClient({ columns: [{ field: 'address', column: 4 }, { field: 'email', column: 1 }] }).client, env });
    expect(await mapper.suggest({ headers: [], samples: [], ...who })).toEqual({ email: 1 });
  });

  it('a refusal, a cut-off answer or one that does not parse is a failure — and is still metered', async () => {
    for (const [parsed, stop] of [[{ rows: [] }, 'refusal'], [{ rows: [] }, 'max_tokens'], [null, 'end_turn']] as const) {
      const { db, rows } = fakeDb();
      await expect(createRowCleaner({ apiKey: 'x', db, client: fakeClient(parsed, stop).client, env }).clean({ rows: [], ...who })).rejects.toThrow();
      expect(rows).toHaveLength(1);
    }
  });
});

describe('set-up', () => {
  it('both prompts carry no date, treat the file as data, and the model is priced', () => {
    for (const p of [IMPORT_MAP_SYSTEM, IMPORT_CLEAN_SYSTEM]) {
      expect(p).not.toMatch(/20\d\d|Monday|October/);
      expect(p).toMatch(/ignore them/);
    }
    expect(IMPORT_CLEAN_SYSTEM).toMatch(/Do not invent anything/);
    expect(isPricedModel(getModel('import-map', env).id)).toBe(true);
    expect(isPricedModel(getModel('import-clean', env).id)).toBe(true);
  });

  it('the model is an env choice, Opus 5.5 by default', () => {
    expect(getModel('import-clean', env).id).toBe('claude-opus-5-5');
    expect(getModel('import-map', { ANTHROPIC_IMPORT_MODEL: 'claude-sonnet-5-5' } as unknown as NodeJS.ProcessEnv).id).toBe('claude-sonnet-5-5');
  });

  it('is off without a key, or when switched off', () => {
    expect(importAssistFromEnv(fakeDb().db, env)).toBeNull();
    expect(importAssistFromEnv(fakeDb().db, { ANTHROPIC_API_KEY: 'k', IMPORT_AI: 'off' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
