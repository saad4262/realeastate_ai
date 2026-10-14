import { describe, expect, it } from 'vitest';
import { issueHandle, type HandleMap } from './handles';
import { specFrom } from './workflow-tools';

/** ADR 0041 Part C: the model's references become the stored spec's ids — or the reply names what is wrong. */

const M = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';

describe('specFrom', () => {
  const handles: HandleMap = {};
  const m = issueHandle(handles, 'M', M);
  const tpl = issueHandle(handles, 'T', T);
  const ctx = { handles };
  it('resolves M and T references, and the trigger’s own field', () => {
    const out = specFrom(ctx, {
      name: 'W',
      scope: 'agency',
      trigger: { kind: 'lead.status_changed', lead_status: 'qualified' },
      conditions: [{ field: 'assignee', op: 'eq', values: [m] }],
      actions: [{ type: 'assign_lead', member: m }, { type: 'wait', hours: 2 }, { type: 'send_template_email', template: tpl }],
    });
    expect(out).toEqual({
      spec: {
        trigger: { kind: 'lead.status_changed', to: 'qualified' },
        conditions: [{ field: 'assignee', op: 'eq', values: [M] }],
        actions: [{ type: 'assign_lead', to: M }, { type: 'wait', hours: 2 }, { type: 'send_template_email', template_id: T }],
      },
    });
  });
  it('names what is missing or not a reference this conversation was given', () => {
    const p = (over: object) => specFrom(ctx, { name: 'W', scope: 'mine', trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'remind_owner', text: 'x' }], ...over } as never);
    expect(p({ trigger: { kind: 'lead.no_reply' } })).toEqual({ problem: 'trigger: no reply needs days (1 to 14)' });
    expect(p({ actions: [{ type: 'send_template_email', template: 'T9' }] })).toMatchObject({ problem: expect.stringMatching(/T reference/) });
    expect(p({ actions: [{ type: 'assign_lead', member: 'M9' }] })).toMatchObject({ problem: expect.stringMatching(/M reference/) });
    expect(p({ conditions: [{ field: 'assignee', op: 'eq', values: ['M9'] }] })).toMatchObject({ problem: expect.stringMatching(/condition 1/) });
    expect(p({ actions: [{ type: 'add_note' }] })).toEqual({ problem: 'action 1 (add_note) needs text' });
  });
});
