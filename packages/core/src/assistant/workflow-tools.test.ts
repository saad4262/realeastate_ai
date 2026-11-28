import { describe, expect, it } from 'vitest';
import { issueHandle, type HandleMap } from './handles';
import { nearPlaces, specFrom } from './workflow-tools';

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
  it('stores stop_on_reply only when it is off (ADR 0103)', () => {
    const p = (over: object) => specFrom(ctx, { name: 'W', scope: 'mine', trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'remind_owner', text: 'x' }], ...over } as never);
    expect(p({ stop_on_reply: false })).toMatchObject({ spec: { stop_on_reply: false } });
    expect('stop_on_reply' in (p({}) as { spec: object }).spec).toBe(false);
    expect('stop_on_reply' in (p({ stop_on_reply: true }) as { spec: object }).spec).toBe(false);
    const decide = { question: 'Buy or sell?', choices: [{ label: 'Buy', actions: [{ type: 'remind_owner', text: 'b' }] }, { label: 'Sell', actions: [{ type: 'remind_owner', text: 's' }] }] };
    expect(p({ decide, stop_on_reply: false })).toMatchObject({ spec: { decide: { question: 'Buy or sell?' }, stop_on_reply: false } });
  });
  it('names what is missing or not a reference this conversation was given', () => {
    const p = (over: object) => specFrom(ctx, { name: 'W', scope: 'mine', trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'remind_owner', text: 'x' }], ...over } as never);
    expect(p({ trigger: { kind: 'lead.no_reply' } })).toEqual({ problem: 'trigger: no reply needs hours (6) or days (1 to 14)' });
    expect(p({ trigger: { kind: 'lead.no_reply', hours: 3 } })).toEqual({ problem: 'trigger: no reply needs hours (6) or days (1 to 14)' });
    expect(p({ trigger: { kind: 'lead.no_reply', hours: 6, days: 2 } })).toEqual({ problem: 'trigger: no reply needs hours (6) or days (1 to 14)' });
    expect(p({ trigger: { kind: 'lead.no_reply', hours: 6 } })).toMatchObject({ spec: { trigger: { kind: 'lead.no_reply', hours: 6 } } });
    expect(p({ actions: [{ type: 'send_template_email', template: 'T9' }] })).toMatchObject({ problem: expect.stringMatching(/T reference/) });
    expect(p({ actions: [{ type: 'assign_lead', member: 'M9' }] })).toMatchObject({ problem: expect.stringMatching(/M reference/) });
    expect(p({ conditions: [{ field: 'assignee', op: 'eq', values: ['M9'] }] })).toMatchObject({ problem: expect.stringMatching(/condition 1/) });
    expect(p({ actions: [{ type: 'add_note' }] })).toEqual({ problem: 'action 1 (add_note) needs text' });
  });
});

describe('specFrom — ADR 0048', () => {
  const L = '33333333-3333-4333-8333-333333333333';
  const handles: HandleMap = {};
  const pRef = issueHandle(handles, 'P', L);
  const ctx = { handles };
  const base = { name: 'W', scope: 'mine' as const, trigger: { kind: 'lead.created' as const }, conditions: [], actions: [{ type: 'remind_owner' as const, text: 'x' }] };
  const bondi = { label: 'Bondi Beach NSW 2026, Australia', lat: -33.891, lng: 151.277 };

  it('a distance takes the place as the server found it — the model only named it', () => {
    const input = { ...base, conditions: [{ field: 'listing.near' as const, op: 'within' as const, values: ['Bondi Beach'], km: 5 }] };
    expect(nearPlaces(input)).toEqual(['Bondi Beach']);
    expect(specFrom(ctx, input, { 'Bondi Beach': bondi })).toMatchObject({ spec: { conditions: [{ field: 'listing.near', op: 'within', km: 5, place: bondi }] } });
    expect(specFrom(ctx, input, { 'Bondi Beach': null })).toMatchObject({ problem: expect.stringMatching(/could not be found on the map/) });
    expect(specFrom(ctx, { ...input, conditions: [{ field: 'listing.near', op: 'within', values: ['Bondi Beach'] }] }, { 'Bondi Beach': bondi })).toMatchObject({ problem: expect.stringMatching(/needs op "within", km/) });
    expect(specFrom(ctx, { ...input, conditions: [{ field: 'listing.suburb', op: 'within', values: ['Ryde'], km: 2 }] })).toMatchObject({ problem: expect.stringMatching(/only for listing.near/) });
  });

  it('a listing is a P reference; a name is words; wait_until keeps only what was given', () => {
    const out = specFrom(ctx, {
      ...base,
      conditions: [{ field: 'listing', op: 'in', values: [pRef] }, { field: 'contact.name', op: 'contains', values: ['Smith'] }],
      actions: [{ type: 'wait_until', time: '09:00', until: '17:00', days: ['mon'] }, { type: 'remind_owner', text: 'x' }],
    });
    expect(out).toMatchObject({
      spec: {
        conditions: [{ field: 'listing', op: 'in', values: [L] }, { field: 'contact.name', op: 'contains', values: ['Smith'] }],
        actions: [{ type: 'wait_until', from: '09:00', to: '17:00', days: ['mon'] }, { type: 'remind_owner' }],
      },
    });
    expect(specFrom(ctx, { ...base, conditions: [{ field: 'listing', op: 'in', values: ['P9'] }] })).toMatchObject({ problem: expect.stringMatching(/P references from find_listings/) });
    expect(specFrom(ctx, { ...base, actions: [{ type: 'wait_until' }, { type: 'remind_owner', text: 'x' }] })).toEqual({ problem: 'action 1 (wait_until) needs time' });
  });
});

describe('ADR 0107: the model’s steps for in turn, the agent told, a tag', () => {
  const M2 = '33333333-3333-4333-8333-333333333333';
  const handles: HandleMap = {};
  const m1 = issueHandle(handles, 'M', M);
  const m2 = issueHandle(handles, 'M', M2);
  const build = (actions: unknown[]) => specFrom({ handles }, { name: 'W', scope: 'agency', trigger: { kind: 'lead.created' }, conditions: [], actions } as never);

  it('become assign_in_turn with the members’ ids, message_assigned_agent, tag_contact', () => {
    const out = build([
      { type: 'assign_in_turn', members: [m1, m2] },
      { type: 'message_assigned_agent', subject: 'New lead', body: 'Yours' },
      { type: 'tag_contact', tag: 'Cold' },
      { type: 'set_lead_status', lead_status: 'nurture' },
    ]);
    expect(out).toMatchObject({
      spec: {
        actions: [
          { type: 'assign_in_turn', among: [M, M2] },
          { type: 'message_assigned_agent', subject: 'New lead', body: 'Yours' },
          { type: 'tag_contact', tag: 'Cold' },
          { type: 'set_lead_status', to: 'nurture' },
        ],
      },
    });
  });

  it('say what is missing: two members, a subject and body, the tag', () => {
    expect(build([{ type: 'assign_in_turn', members: [m1] }])).toMatchObject({ problem: expect.stringMatching(/2 to 20 M references/) });
    expect(build([{ type: 'assign_in_turn', members: [m1, 'M9'] }])).toMatchObject({ problem: expect.stringMatching(/assign_in_turn/) });
    expect(build([{ type: 'message_assigned_agent', subject: 'x' }])).toMatchObject({ problem: expect.stringMatching(/needs body/) });
    expect(build([{ type: 'tag_contact' }])).toMatchObject({ problem: expect.stringMatching(/needs tag/) });
  });
});
