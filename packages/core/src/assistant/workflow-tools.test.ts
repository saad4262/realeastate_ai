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
  it('names what is missing or not a reference this conversation was given', () => {
    const p = (over: object) => specFrom(ctx, { name: 'W', scope: 'mine', trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'remind_owner', text: 'x' }], ...over } as never);
    expect(p({ trigger: { kind: 'lead.no_reply' } })).toEqual({ problem: 'trigger: no reply needs days (1 to 14)' });
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
