import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { createWorkflowDraftWriter, WORKFLOW_DRAFT_PROMPT_VERSION } from './workflow-draft';
import { WORKFLOW_DRAFT_SYSTEM } from '../prompts/workflow-draft-v1';

/** ADR 0041 D1: the workflow's email draft — one metered call, a subject and a body, never sent here. A fake client: never the network. */

function fakeClient(text: string, stop = 'end_turn') {
  const calls: unknown[] = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        calls.push(req);
        return { content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 90, output_tokens: 40 } };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}
const input = {
  instructions: 'Thank them for enquiring and ask when they could inspect.',
  facts: { contactName: 'Sara Khan', contactFirstName: 'Sara', listingAddress: '1 George St, Ryde', agentName: 'Omar', agencyName: 'Harbour Realty' },
  workflowName: 'Welcome',
  agencyId: 'agency-1',
  userId: 'user-1',
};

describe('the workflow draft writer', () => {
  it('returns the subject and body, meters the call to its agency and person, and sends nothing', async () => {
    const { client, calls } = fakeClient('{"subject":"Thanks for your enquiry","body":"Hi Sara,\\n\\nThanks for asking about 1 George St. When could you inspect?"}');
    const { db, rows } = fakeDb();
    const out = await createWorkflowDraftWriter({ apiKey: 'x', db, client, env: {} as NodeJS.ProcessEnv })(input);
    expect(out.subject).toBe('Thanks for your enquiry');
    expect(rows[0]).toMatchObject({ feature: 'workflow:draft_email', userId: 'user-1', agencyId: 'agency-1', promptVersion: WORKFLOW_DRAFT_PROMPT_VERSION });
    const req = calls[0] as { system: { text: string }[]; messages: { content: string }[]; tools?: unknown };
    expect(req.tools).toBeUndefined();
    expect(req.messages[0]!.content).toContain('"contact_first_name":"Sara"');
    expect(req.messages[0]!.content).toContain('INSTRUCTIONS:\nThank them');
  });
  it('the system prompt carries no date and forbids invented figures', () => {
    expect(WORKFLOW_DRAFT_SYSTEM).not.toMatch(/20\d\d|Monday|October/);
    expect(WORKFLOW_DRAFT_SYSTEM).toMatch(/Never invent a price, a date, a time/);
  });
  it('a refusal, a cut-off or a wrong shape is no draft (and still metered)', async () => {
    for (const [text, stop] of [['{"subject":"x","body":"y"}', 'refusal'], ['{"subject":"x"', 'max_tokens'], ['not json', 'end_turn'], ['{"subject":"x","body":"y","to":"a@b.co"}', 'end_turn']] as const) {
      const { db, rows } = fakeDb();
      await expect(createWorkflowDraftWriter({ apiKey: 'x', db, client: fakeClient(text, stop).client, env: {} as NodeJS.ProcessEnv })(input)).rejects.toThrow();
      expect(rows).toHaveLength(1);
    }
  });
});
