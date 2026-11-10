import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import { issueHandle, type HandleMap } from './handles';
import { runAssistantTool, type ToolContext } from './tools';

/** ADR 0089: the Bulk email chat making a repeating automation. */

const classifyRecipients = vi.hoisted(() => vi.fn());
const mergeValuesFor = vi.hoisted(() => vi.fn(async () => () => ({})));
const propose = vi.hoisted(() => vi.fn(async (_c: unknown, label: string, card: unknown) => ({ label, result: { proposed: true, card } })));
vi.mock('../template-email/batches', async (real) => ({ ...(await real<object>()), classifyRecipients, mergeValuesFor }));
vi.mock('./actions', async (real) => ({ ...(await real<object>()), propose }));

/** The skill's switch reads as on; today's sends, read the same way, as none. */
const skillOn = {
  select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([{ agent: '0', agency: '0' }]), { limit: async () => [{ enabled: true }] }) }) }),
} as unknown as Db;
const T = '11111111-1111-4111-8111-111111111111';
const F = '22222222-2222-4222-8222-222222222222';

function context(over: Partial<ToolContext> = {}) {
  const handles: HandleMap = {};
  const t = issueHandle(handles, 'T', T);
  const f = issueHandle(handles, 'F', F);
  const ctx = { env: undefined, db: skillOn, actor: { userId: 'u1', agencyId: 'a1', membershipRole: 'agent' }, timeZone: 'Australia/Sydney', handles, now: new Date('2026-11-09T01:00:00Z'), chatScope: 'email', skillsOff: async () => new Set(), proposal: { conversationId: 'c1', turnId: 't', toolUseId: 'x', made: { count: 0 } }, ...over } as ToolContext;
  return { ctx, input: { name: 'Monday buyers', template: t, list: f, schedule: { cadence: 'weekly', time: '09:30', weekday: 'mon' } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  classifyRecipients.mockResolvedValue({ agencyId: 'a1', template: { name: 'Spring', subject: 'Hi', body: 'Body' }, filter: { name: 'Buyers' }, recipients: [{ name: 'Sam', status: 'queued' }, { name: 'Lee', status: 'skipped' }] });
});

describe('an automation over the daily limit', () => {
  const people = (n: number, phoneNumberId: string | null = null) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, status: 'queued', phoneNumberId }));
  const used = (agent: string, agency: string) => ({ select: () => ({ from: () => ({ where: async () => [{ agent, agency }], then: undefined }) }) });

  it('is not made: the assistant says how many, and the limit', async () => {
    classifyRecipients.mockResolvedValue({ agencyId: 'a1', template: { name: 'Spring', subject: 'Hi', body: 'Body' }, filter: { name: 'Buyers' }, recipients: people(80) });
    const { ctx, input } = context({ env: { EMAIL_LIMIT_PER_AGENT_DAY: '50', EMAIL_LIMIT_PER_AGENCY_DAY: '200' } as never });
    const out = await runAssistantTool(ctx, 'create_automation', input);
    const said = JSON.stringify(out.result);
    expect(propose).not.toHaveBeenCalled();
    expect(said).toContain('80');
    expect(said).toContain('50');
    expect(said).toContain('limit');
  });

  it('the agency’s limit counts too', async () => {
    classifyRecipients.mockResolvedValue({ agencyId: 'a1', template: { name: 'Spring', subject: 'Hi', body: 'Body' }, filter: { name: 'Buyers' }, recipients: people(30) });
    const { ctx, input } = context({ env: { EMAIL_LIMIT_PER_AGENT_DAY: '50', EMAIL_LIMIT_PER_AGENCY_DAY: '20' } as never });
    const out = await runAssistantTool(ctx, 'create_automation', input);
    expect(propose).not.toHaveBeenCalled();
    expect(JSON.stringify(out.result)).toContain('20');
  });

  it('within the limit, the card says what each run takes of it', async () => {
    classifyRecipients.mockResolvedValue({ agencyId: 'a1', template: { name: 'Spring', subject: 'Hi', body: 'Body' }, filter: { name: 'Buyers' }, recipients: people(10) });
    const { ctx, input } = context({ env: { EMAIL_LIMIT_PER_AGENT_DAY: '50', EMAIL_LIMIT_PER_AGENCY_DAY: '200' } as never });
    await runAssistantTool(ctx, 'create_automation', input);
    const card = (propose.mock.calls[0]![2] as { card: { lines: { label: string; value: string }[] } }).card;
    expect(card.lines.find((l) => l.label === 'Daily limit')!.value).toContain('10 of your 50');
  });
});

describe('create_automation', () => {
  it('makes one card with what it does, when, and who today; nothing runs yet', async () => {
    const { ctx, input } = context();
    await runAssistantTool(ctx, 'create_automation', input);
    const sent = propose.mock.calls[0]![2] as { tool: string; args: { automation: Record<string, unknown> }; card: { lines: { label: string; value: string }[]; notes: string[] } };
    expect(sent.tool).toBe('create_workflow');
    expect(sent.args.automation).toMatchObject({ kind: 'bulk_email', name: 'Monday buyers', cadence: 'weekly', sendAtMinute: 570, sendOnWeekday: 1, timezone: 'Australia/Sydney', conversationId: 'c1', spec: { templateId: T, filterId: F, templateName: 'Spring', listName: 'Buyers' } });
    expect(sent.card.lines.find((l) => l.label === 'Who today')!.value).toContain('1 could receive');
    expect(sent.card.notes.join(' ')).toContain('by itself');
  });
  it('needs a saved list it was given, and a template it was given', async () => {
    const { ctx, input } = context();
    expect((await runAssistantTool(ctx, 'create_automation', { ...input, list: 'F99' })).isError).toBe(true);
    expect((await runAssistantTool(ctx, 'create_automation', { ...input, template: 'T99' })).isError).toBe(true);
    expect(propose).not.toHaveBeenCalled();
  });
  it('a weekly one needs its day', async () => {
    const { ctx, input } = context();
    expect((await runAssistantTool(ctx, 'create_automation', { ...input, schedule: { cadence: 'weekly', time: '09:30' } })).isError).toBe(true);
  });
  it('is refused in any other chat, and a chat from before ADR 0088', async () => {
    for (const chatScope of ['daily_work', 'listing_copy', null] as const) {
      const { ctx, input } = context({ chatScope });
      expect((await runAssistantTool(ctx, 'create_automation', input)).isError, String(chatScope)).toBe(true);
    }
    expect(propose).not.toHaveBeenCalled();
  });
  it('a read-only member cannot', async () => {
    const { ctx, input } = context({ actor: { userId: 'u1', agencyId: 'a1', membershipRole: 'read_only' } });
    expect((await runAssistantTool(ctx, 'create_automation', input)).isError).toBe(true);
    expect(propose).not.toHaveBeenCalled();
  });
  it('is off while Bulk email is off', async () => {
    const { ctx, input } = context({ skillsOff: async () => new Set(['bulk_email']) as never });
    expect(JSON.stringify((await runAssistantTool(ctx, 'create_automation', input)).result)).toContain('switched off');
  });
});
