import { describe, expect, it } from 'vitest';
import { conditionInWords, specProblem, workflowSpecSchema } from './catalog';
import { AI_WAIT_MS, conditionsHold, stepsFor, waitsForUnderstanding, type Facts } from './engine';
import { SKILL_OF_WORKFLOW_STEP } from '../skill-switches/catalog';

/** ADR 0078 (ROADMAP 4.5 C): conditions on what the AI understood, the brief step, and waiting for it. */

const now = new Date('2026-11-02T10:00:00Z');
const facts = (over: Partial<Facts> = {}): Facts => ({
  agencyId: 'a', leadId: 'lead-1', leadStatus: 'new', leadKind: 'enquiry', leadSource: 'website', leadAssignee: null, leadListingId: null,
  contactId: 'c-1', contactName: 'Priya Shah', contactAssignee: null, contactRoles: [], listingId: null, listingSuburb: null, listingChannel: null,
  listingAddress: null, listingLat: null, listingLng: null, appointmentId: null, appointmentType: null, appointmentAgent: null,
  leadAiIntent: 'buyer', leadAiUrgency: 'high', leadAiStatus: 'done', leadCreatedAt: new Date(now.getTime() - 30_000), ...over,
});
const spec = (conditions: unknown[], actions: unknown[] = [{ type: 'remind_owner', text: 'Call them' }], trigger: unknown = { kind: 'lead.created' }) =>
  workflowSpecSchema.parse({ trigger, conditions, actions });

describe('conditions on what the AI understood', () => {
  it('match the lead’s type and urgency', () => {
    expect(conditionsHold(spec([{ field: 'lead.urgency', op: 'eq', values: ['high'] }]).conditions, facts())).toBe(true);
    expect(conditionsHold(spec([{ field: 'lead.intent', op: 'in', values: ['seller', 'landlord'] }]).conditions, facts())).toBe(false);
    expect(conditionsHold(spec([{ field: 'lead.intent', op: 'not_in', values: ['tenant'] }]).conditions, facts())).toBe(true);
  });
  it('nothing understood (skill off, budget, not yet) never matches a positive condition', () => {
    expect(conditionsHold(spec([{ field: 'lead.urgency', op: 'eq', values: ['high'] }]).conditions, facts({ leadAiUrgency: null, leadAiStatus: 'off' }))).toBe(false);
  });
  it('only known values, only on a trigger with a lead, and say themselves in words', () => {
    expect(specProblem(spec([{ field: 'lead.urgency', op: 'eq', values: ['panic'] }]), 'mine')).toMatch(/not one of high, normal/);
    expect(specProblem(spec([{ field: 'lead.intent', op: 'eq', values: ['buyer'] }], undefined, { kind: 'contact.created' }), 'mine')).toMatch(/no lead to look at/);
    expect(conditionInWords({ field: 'lead.intent', op: 'eq', values: ['seller'] })).toBe('what the AI understood they are is a seller');
  });
});

describe('the brief step', () => {
  it('needs a lead, and leaves a card (propose_ai_brief) — it never saves anything itself', () => {
    expect(specProblem(spec([], [{ type: 'save_ai_brief' }], { kind: 'contact.created' }), 'mine')).toMatch(/no lead to act on/);
    const out = stepsFor({ name: 'New buyers' }, spec([], [{ type: 'save_ai_brief' }]), facts(), {}, now, 'Australia/Melbourne');
    expect(out).toMatchObject([{ tool: 'propose_ai_brief', args: { tool: 'propose_ai_brief', leadId: 'lead-1', workflowName: 'New buyers' } }]);
  });
  it('is behind the skill "AI understands enquiries"', () => {
    expect(SKILL_OF_WORKFLOW_STEP.save_ai_brief).toBe('ai_understand_enquiries');
  });
});

describe('waiting for the understanding', () => {
  const ai = [spec([{ field: 'lead.intent', op: 'eq', values: ['buyer'] }])];
  it('a workflow with an AI condition waits while the lead is new and not looked at', () => {
    expect(waitsForUnderstanding(ai, facts({ leadAiStatus: null }), now)).toBe(true);
  });
  it('not once it is understood, nor after the wait, nor without an AI condition, nor without a lead', () => {
    expect(waitsForUnderstanding(ai, facts(), now)).toBe(false);
    expect(waitsForUnderstanding(ai, facts({ leadAiStatus: null, leadCreatedAt: new Date(now.getTime() - AI_WAIT_MS) }), now)).toBe(false);
    expect(waitsForUnderstanding([spec([])], facts({ leadAiStatus: null }), now)).toBe(false);
    expect(waitsForUnderstanding(ai, facts({ leadId: null, leadAiStatus: null }), now)).toBe(false);
  });
});
