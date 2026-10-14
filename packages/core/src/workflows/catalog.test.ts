import { describe, expect, it } from 'vitest';
import { renderMerge, specInWords, specProblem, workflowSpecSchema, type WorkflowSpec } from './catalog';

/** ADR 0041 Part B: the workflow catalog — what a spec may be, and how it reads. */

const M1 = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const parse = (v: unknown) => workflowSpecSchema.safeParse(v);

describe('workflowSpecSchema — only catalog parts, never code', () => {
  it('a usual workflow parses', () => {
    const r = parse({
      trigger: { kind: 'lead.created', source: 'website' },
      conditions: [{ field: 'listing.suburb', op: 'in', values: ['Parramatta', 'Ryde'] }],
      actions: [{ type: 'assign_lead', to: M1 }, { type: 'wait', hours: 24 }, { type: 'remind_owner', text: 'Call {{contact_first_name}}' }],
    });
    expect(r.success).toBe(true);
  });
  it('refuses an unknown trigger, field, operator or action, and any extra key', () => {
    expect(parse({ trigger: { kind: 'lead.deleted' }, actions: [{ type: 'wait', hours: 1 }] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, conditions: [{ field: 'lead.price', op: 'eq', values: ['1'] }], actions: [{ type: 'remind_owner', text: 'x' }] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, conditions: [{ field: 'lead.kind', op: 'like', values: ['x'] }], actions: [{ type: 'remind_owner', text: 'x' }] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, actions: [{ type: 'run_sql', sql: 'drop table lead' }] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, actions: [{ type: 'send_template_email', template_id: T1, body: 'Hi' }] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, actions: [{ type: 'draft_email', instructions: 'x', to: 'a@b.co' }] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, actions: [], code: 'x' }).success).toBe(false);
  });
  it('bounds: 1–6 actions, up to 5 conditions, a wait up to 30 days, no-reply 1–14 days', () => {
    const a = { type: 'remind_owner', text: 'x' };
    expect(parse({ trigger: { kind: 'lead.created' }, actions: [] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, actions: Array(7).fill(a) }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.created' }, actions: [{ type: 'wait', hours: 721 }, a] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.no_reply', days: 15 }, actions: [a] }).success).toBe(false);
    expect(parse({ trigger: { kind: 'lead.no_reply', days: 3 }, actions: [a] }).success).toBe(true);
  });
});

describe('specProblem — what the schema cannot say', () => {
  const spec = (s: Partial<WorkflowSpec>): WorkflowSpec => ({ trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'remind_owner', text: 'x', mail_me: false }], ...s });
  it('an agent’s own workflow may not assign (D2); an agency-wide one may', () => {
    const s = spec({ actions: [{ type: 'assign_lead', to: M1 }] });
    expect(specProblem(s, 'mine')).toMatch(/only an agency-wide workflow/);
    expect(specProblem(s, 'agency')).toBeNull();
  });
  it('an action needs its trigger’s record: a listing change has no contact to email', () => {
    expect(specProblem(spec({ trigger: { kind: 'listing.status_changed', to: 'sold' }, actions: [{ type: 'draft_email', instructions: 'congrats' }] }), 'mine')).toMatch(/no contact to act on/);
    expect(specProblem(spec({ trigger: { kind: 'contact.created' }, actions: [{ type: 'set_lead_status', to: 'contacted' }] }), 'mine')).toMatch(/no lead to act on/);
    expect(specProblem(spec({ trigger: { kind: 'listing.status_changed', to: 'sold' } }), 'mine')).toBeNull();
  });
  it('a condition needs its record and a value from its list', () => {
    expect(specProblem(spec({ trigger: { kind: 'contact.created' }, conditions: [{ field: 'listing.suburb', op: 'eq', values: ['Ryde'] }] }), 'mine')).toMatch(/no listing to look at/);
    expect(specProblem(spec({ conditions: [{ field: 'lead.kind', op: 'eq', values: ['offer'] }] }), 'mine')).toMatch(/not one of/);
    expect(specProblem(spec({ conditions: [{ field: 'lead.kind', op: 'eq', values: ['enquiry', 'appraisal'] }] }), 'mine')).toMatch(/takes one value/);
    expect(specProblem(spec({ conditions: [{ field: 'assignee', op: 'eq', values: ['Ahmed'] }] }), 'mine')).toMatch(/team member/);
  });
  it('never ends on a wait', () => {
    expect(specProblem(spec({ actions: [{ type: 'remind_owner', text: 'x', mail_me: false }, { type: 'wait', hours: 2 }] }), 'mine')).toMatch(/end with a wait/);
  });
});

describe('renderMerge — filled from the database, never by the model', () => {
  it('fills the known fields, leaves nothing behind for a missing one, keeps an unknown one as written', () => {
    expect(renderMerge('Hi {{contact_first_name}}, about {{ listing_address }}', { contact_first_name: 'Sara', listing_address: '1 George St, Ryde' })).toBe('Hi Sara, about 1 George St, Ryde');
    expect(renderMerge('Call {{contact_first_name}} today', {})).toBe('Call today');
    expect(renderMerge('Price {{price}}', { contact_name: 'x' })).toBe('Price {{price}}');
  });
});

describe('specInWords — the card, the screen and the log say the same thing', () => {
  it('reads as a sentence, with names from the database', () => {
    const w = specInWords(
      {
        trigger: { kind: 'lead.created', source: 'website' },
        conditions: [{ field: 'listing.suburb', op: 'in', values: ['Parramatta', 'Ryde'] }],
        actions: [{ type: 'assign_lead', to: M1 }, { type: 'wait', hours: 24 }, { type: 'send_template_email', template_id: T1 }],
      },
      { [M1]: 'Ahmed', [T1]: 'Welcome' },
    );
    expect(w).toEqual({
      when: 'When an enquiry arrives from the website',
      if: ['the listing’s suburb is Parramatta or Ryde'],
      then: ['Give the lead to Ahmed', 'Wait 1 day', 'Send the template “Welcome” to the contact (only if they may receive it then)'],
    });
  });
});
