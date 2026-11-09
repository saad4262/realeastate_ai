import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { automationWords, AUTOMATION_SKILL, bulkSmsSpecSchema } from './kinds';
import { AUTOMATION_RUNNERS, type RunnerDeps } from './runners';

/** ADR 0089: a repeating bulk text. Every SMS rule stays the batch's. */

const classifySmsRecipients = vi.hoisted(() => vi.fn());
const storePreparedSmsBatch = vi.hoisted(() => vi.fn(async () => ({ id: 'b1', notFound: 0 })));
const approveSmsBatch = vi.hoisted(() => vi.fn(async () => ({ result: 'approved', sendsAt: new Date() })));
const sendSmsBatch = vi.hoisted(() => vi.fn(async () => ({ sent: 2, failed: 0, skipped: 1, held: false })));
const loadSmsRules = vi.hoisted(() => vi.fn());
const inSmsHours = vi.hoisted(() => vi.fn());
const nextSmsTime = vi.hoisted(() => vi.fn());
vi.mock('../template-email/sms-batches', async (real) => ({ ...(await real<object>()), classifySmsRecipients, storePreparedSmsBatch, approveSmsBatch, sendSmsBatch }));
vi.mock('../phone/sms-rules', async (real) => ({ ...(await real<object>()), loadSmsRules, inSmsHours, nextSmsTime }));

const actor: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'agent' };
const ID = '00000000-0000-4000-8000-000000000001';
const spec = { templateId: ID, templateName: 'Hello', filterId: ID, listName: 'Buyers' };
const deps = { templateSend: null, sms: { phone: {} } } as unknown as RunnerDeps;
const NOW = new Date('2026-11-09T02:00:00Z');
const runner = AUTOMATION_RUNNERS.bulk_sms;

beforeEach(() => {
  vi.clearAllMocks();
  loadSmsRules.mockResolvedValue({ hours: {}, timeZone: 'Australia/Sydney' });
  inSmsHours.mockReturnValue(true);
  classifySmsRecipients.mockResolvedValue({ recipients: [{ contactId: 'c1', status: 'queued' }, { contactId: 'c2', status: 'skipped' }] });
});

describe('the bulk SMS kind', () => {
  it('reads and says itself, and answers to Bulk SMS’s switch', () => {
    expect(bulkSmsSpecSchema.safeParse(spec).success).toBe(true);
    expect(automationWords('bulk_sms', spec)).toBe('Texts “Hello” to everyone on “Buyers” who may receive it');
    expect(AUTOMATION_SKILL.bulk_sms.key).toBe('bulk_sms');
    expect(AUTOMATION_SKILL.bulk_sms.name).toBe('SMS');
  });
});

describe('the bulk SMS runner', () => {
  it('finds who may be texted, as the person', async () => {
    expect(await runner.people({} as Db, actor, spec, deps)).toEqual({ contactIds: ['c1'], skipped: 1 });
    expect(classifySmsRecipients.mock.calls[0]![2]).toMatchObject({ templateId: ID, filterId: ID });
  });
  it('says so when the phone is not set up', async () => {
    expect(await runner.people({} as Db, actor, spec, { templateSend: null, sms: null })).toEqual({ stop: expect.stringContaining('SMS') });
  });
  it('sends a slice through the screen’s own Approve', async () => {
    const r = await runner.send({} as Db, actor, spec, ['c1', 'c2'], deps, NOW);
    expect(storePreparedSmsBatch).toHaveBeenCalledTimes(1);
    expect(approveSmsBatch).toHaveBeenCalledTimes(1);
    expect(sendSmsBatch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: 2, failed: 0 });
  });
  it('outside the sending hours it waits, and prepares nothing', async () => {
    inSmsHours.mockReturnValue(false);
    const at = new Date('2026-11-09T22:00:00Z');
    nextSmsTime.mockReturnValue(at);
    const r = await runner.send({} as Db, actor, spec, ['c1'], deps, NOW);
    expect(r.retryAt).toEqual(at);
    expect(storePreparedSmsBatch).not.toHaveBeenCalled();
  });
  it('nobody left in a slice: nothing is prepared', async () => {
    classifySmsRecipients.mockResolvedValue({ recipients: [{ contactId: 'c2', status: 'skipped' }] });
    const r = await runner.send({} as Db, actor, spec, ['c2'], deps, NOW);
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(storePreparedSmsBatch).not.toHaveBeenCalled();
  });
});
