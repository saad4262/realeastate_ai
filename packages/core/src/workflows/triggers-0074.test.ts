import { describe, expect, it } from 'vitest';
import type { Actor } from '../permissions';
import { actionInWords, renderMerge, specProblem, TRIGGER_GUIDE, triggerInWords, workflowSpecSchema } from './catalog';
import { inScope, stepsFor, triggerMatches, type Facts } from './engine';
import { specFrom } from '../assistant/workflow-tools';

/** ADR 0074 (ROADMAP 3.4, part 1): the trigger "a call is missed". */

const A = 'agency-a';
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const spec = (trigger: unknown, actions: unknown[] = [{ type: 'remind_owner', text: 'Call {{caller_phone}} back' }]) => workflowSpecSchema.parse({ trigger, actions });
const facts = (over: Partial<Facts> = {}): Facts => ({
  agencyId: A, leadId: null, leadStatus: null, leadKind: null, leadSource: null, leadAssignee: null, leadListingId: null,
  contactId: null, contactName: null, contactAssignee: null, contactRoles: [], listingId: null, listingSuburb: null,
  listingChannel: null, listingAddress: null, listingLat: null, listingLng: null, appointmentId: null, appointmentType: null, appointmentAgent: null,
  dealAgent: null, callAgent: AGENT, callerPhone: '0412 555 019', ...over,
});
const agent: Actor = { userId: AGENT, agencyId: A, membershipRole: 'agent' };
const now = new Date('2026-11-02T00:00:00Z');

describe('call.missed in the catalog', () => {
  it('parses with an optional caller: known, new, or either', () => {
    expect(spec({ kind: 'call.missed' }).trigger).toEqual({ kind: 'call.missed' });
    expect(spec({ kind: 'call.missed', caller: 'new' }).trigger).toEqual({ kind: 'call.missed', caller: 'new' });
    expect(() => spec({ kind: 'call.missed', caller: 'vip' })).toThrow();
  });
  it('a new number has no contact: a step that needs one is refused, a reminder is fine', () => {
    const newCaller = { kind: 'call.missed', caller: 'new' };
    expect(specProblem(spec(newCaller, [{ type: 'add_note', text: 'x' }]), 'mine')).toMatch(/new number has no contact yet/);
    expect(specProblem(spec(newCaller, [{ type: 'send_template_email', template_id: '33333333-3333-4333-8333-333333333333' }]), 'mine')).toMatch(/no contact yet/);
    expect(specProblem(spec(newCaller), 'mine')).toBeNull();
    expect(specProblem(spec({ kind: 'call.missed', caller: 'known' }, [{ type: 'add_note', text: 'x' }]), 'mine')).toBeNull();
  });
  it('has no lead to act on', () => {
    expect(specProblem(spec({ kind: 'call.missed' }, [{ type: 'set_lead_status', to: 'contacted' }]), 'agency')).toMatch(/no lead to act on/);
  });
  it('says itself in words, and is in the Calls group of the guide', () => {
    expect(triggerInWords({ kind: 'call.missed', caller: 'new' })).toBe('When a call from a number not in Contacts is missed');
    expect(triggerInWords({ kind: 'call.missed' })).toBe('When a call is missed');
    expect(TRIGGER_GUIDE['call.missed'].group).toBe('Calls');
  });
});

describe('matching a missed call', () => {
  it('compares the caller kind when the workflow names one', () => {
    expect(triggerMatches({ kind: 'call.missed' }, { caller: 'new' })).toBe(true);
    expect(triggerMatches({ kind: 'call.missed', caller: 'new' }, { caller: 'new' })).toBe(true);
    expect(triggerMatches({ kind: 'call.missed', caller: 'new' }, { caller: 'known' })).toBe(false);
  });
  it('a personal workflow: only calls to its owner’s own number, whoever the contact belongs to', () => {
    expect(inScope(agent, { scope: 'mine', agencyId: A }, facts(), 'call.missed')).toBe(true);
    expect(inScope(agent, { scope: 'mine', agencyId: A }, facts({ callAgent: OTHER, contactId: 'c1', contactAssignee: AGENT }), 'call.missed')).toBe(false);
    expect(inScope(agent, { scope: 'mine', agencyId: A }, facts({ callAgent: null }), 'call.missed')).toBe(false);
  });
});

describe('the run', () => {
  it('fills the caller’s number into a reminder — from the call row, never from a model', () => {
    const out = stepsFor({ name: 'Missed' }, spec({ kind: 'call.missed', caller: 'new' }), facts(), { caller_phone: '0412 555 019' }, now, 'Australia/Melbourne');
    expect('problem' in out).toBe(false);
    expect((out as { args: { text?: string } }[])[0]!.args.text).toBe('Call 0412 555 019 back');
    expect(renderMerge('Call {{caller_phone}}', {})).toBe('Call');
  });
  it('a caller who is not a contact, with a step that needs one: skipped, and it says why', () => {
    const out = stepsFor({ name: 'Missed' }, spec({ kind: 'call.missed' }, [{ type: 'add_note', text: 'x' }]), facts(), {}, now, 'Australia/Melbourne');
    expect(out).toEqual({ problem: 'the caller is not in Contacts' });
  });
  it('reads in words like the other steps', () => {
    expect(actionInWords({ type: 'remind_owner', text: 'Call {{caller_phone}} back', mail_me: false })).toBe('Remind you: “Call {{caller_phone}} back”');
  });
});

describe('the assistant’s part', () => {
  const ctx = { handles: new Map() } as never;
  const base = { name: 'x', scope: 'mine' as const, conditions: [], actions: [{ type: 'remind_owner' as const, text: 'Call {{caller_phone}}' }] };
  it('passes the caller kind through, and leaves it out when not given', () => {
    expect(specFrom(ctx, { ...base, trigger: { kind: 'call.missed', caller: 'new' } } as never)).toMatchObject({ spec: { trigger: { kind: 'call.missed', caller: 'new' } } });
    expect(specFrom(ctx, { ...base, trigger: { kind: 'call.missed' } } as never)).toMatchObject({ spec: { trigger: { kind: 'call.missed' } } });
  });
});
