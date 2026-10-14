import { describe, expect, it } from 'vitest';
import type { Actor } from '../permissions';
import { conditionsHold, inScope, stepsFor, triggerMatches, type Facts } from './engine';

/** ADR 0041 Part B: the engine's decisions that need no database. */

const A = 'agency-a';
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T1 = '33333333-3333-4333-8333-333333333333';

const facts = (over: Partial<Facts> = {}): Facts => ({
  agencyId: A,
  leadId: 'lead-1',
  leadStatus: 'new',
  leadKind: 'enquiry',
  leadSource: 'website',
  leadAssignee: AGENT,
  leadListingId: 'listing-1',
  contactId: 'contact-1',
  contactName: 'Sara Khan',
  contactAssignee: AGENT,
  contactRoles: ['buyer'],
  listingId: 'listing-1',
  listingSuburb: 'Parramatta',
  listingChannel: 'sale',
  listingAddress: '1 George St, Parramatta, NSW 2150',
  appointmentId: null,
  appointmentType: null,
  appointmentAgent: null,
  ...over,
});
const agent = (userId = AGENT, listingAgentOf: string[] = []): Actor => ({ userId, agencyId: A, membershipRole: 'agent', listingAgentOf });
const admin: Actor = { userId: 'boss', agencyId: A, membershipRole: 'admin' };

describe('triggerMatches', () => {
  it('compares only the trigger’s own facts', () => {
    expect(triggerMatches({ kind: 'lead.created' }, { source: 'manual' })).toBe(true);
    expect(triggerMatches({ kind: 'lead.created', source: 'website' }, { source: 'manual' })).toBe(false);
    expect(triggerMatches({ kind: 'lead.status_changed', to: 'closed' }, { to: 'closed' })).toBe(true);
    expect(triggerMatches({ kind: 'lead.status_changed', to: 'closed' }, { to: 'qualified' })).toBe(false);
    expect(triggerMatches({ kind: 'lead.no_reply', days: 3 }, { days: 2 })).toBe(false);
  });
});

describe('conditionsHold — the record as it is now', () => {
  it('all must hold; suburbs ignore case; not_in is the opposite; a missing value never matches `in`', () => {
    expect(conditionsHold([{ field: 'listing.suburb', op: 'in', values: ['parramatta', 'Ryde'] }], facts())).toBe(true);
    expect(conditionsHold([{ field: 'listing.suburb', op: 'not_in', values: ['Parramatta'] }], facts())).toBe(false);
    expect(conditionsHold([{ field: 'contact.role', op: 'eq', values: ['seller'] }], facts())).toBe(false);
    expect(conditionsHold([{ field: 'listing.suburb', op: 'eq', values: ['Ryde'] }, { field: 'lead.kind', op: 'eq', values: ['enquiry'] }], facts())).toBe(false);
    expect(conditionsHold([{ field: 'appointment.type', op: 'in', values: ['zoom'] }], facts())).toBe(false);
    expect(conditionsHold([{ field: 'assignee', op: 'eq', values: [AGENT] }], facts())).toBe(true);
  });
});

describe('inScope — an agent’s workflow never touches a colleague’s record (D2)', () => {
  const mine = { scope: 'mine', agencyId: A };
  it('their own lead: yes; a colleague’s lead: no; an unassigned lead on their listing: yes', () => {
    expect(inScope(agent(), mine, facts())).toBe(true);
    expect(inScope(agent(), mine, facts({ leadAssignee: OTHER }))).toBe(false);
    expect(inScope(agent(AGENT, ['listing-1']), mine, facts({ leadAssignee: null }))).toBe(true);
    expect(inScope(agent(AGENT, []), mine, facts({ leadAssignee: null }))).toBe(false);
  });
  it('a contact assigned to them only; an appointment of theirs only', () => {
    const noLead = { leadId: null, leadAssignee: null };
    expect(inScope(agent(), mine, facts({ ...noLead, contactAssignee: OTHER }))).toBe(false);
    expect(inScope(agent(), mine, facts({ ...noLead, appointmentId: 'ap-1', appointmentAgent: OTHER }))).toBe(false);
    expect(inScope(agent(), mine, facts({ ...noLead, appointmentId: 'ap-1', appointmentAgent: AGENT }))).toBe(true);
  });
  it('agency-wide: every record, while its owner is an owner/admin; a read-only owner: nothing', () => {
    expect(inScope(admin, { scope: 'agency', agencyId: A }, facts({ leadAssignee: OTHER }))).toBe(true);
    expect(inScope(agent(), { scope: 'agency', agencyId: A }, facts())).toBe(false);
    expect(inScope({ userId: AGENT, agencyId: A, membershipRole: 'read_only' }, mine, facts())).toBe(false);
  });
});

describe('stepsFor — the run’s steps', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  it('fills the record and the merge fields; a wait becomes the next step’s gap; a template is an ADR 0040 part', () => {
    const steps = stepsFor(
      { name: 'Welcome' },
      {
        trigger: { kind: 'lead.created' },
        conditions: [],
        actions: [
          { type: 'add_note', text: 'New enquiry from {{contact_first_name}} on {{listing_address}}' },
          { type: 'wait', hours: 24 },
          { type: 'send_template_email', template_id: T1 },
          { type: 'draft_email', instructions: 'Ask when they can inspect' },
        ],
      },
      facts(),
      { contact_first_name: 'Sara', listing_address: '1 George St, Parramatta, NSW 2150' },
      now,
    );
    if ('problem' in steps) throw new Error(steps.problem);
    expect(steps.map((s) => s.tool)).toEqual(['add_note', 'send_template_email', 'draft_email']);
    expect(steps[0]!.args).toMatchObject({ contactId: 'contact-1', body: 'New enquiry from Sara on 1 George St, Parramatta, NSW 2150' });
    expect(steps[1]!.args).toMatchObject({ templateId: T1, contactIds: ['contact-1'], gapHours: 24, part: { n: 1, of: 1 } });
    expect(steps[2]!.args).toEqual({ tool: 'draft_email', contactId: 'contact-1', instructions: 'Ask when they can inspect', workflowName: 'Welcome' });
  });
  it('a step that needs a contact the record no longer has: the run is not made, and says why', () => {
    const out = stepsFor({ name: 'X' }, { trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'add_note', text: 'x' }] }, facts({ contactId: null }), {}, now);
    expect(out).toEqual({ problem: 'the contact is archived, merged or gone' });
  });
});
