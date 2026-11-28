import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { conditionsHold, distanceKm, inScope, pickInTurn, scanNoReply, stepsFor, triggerMatches, type Facts } from './engine';
import { specProblem, workflowSpecSchema } from './catalog';

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
  listingLat: -33.8151,
  listingLng: 151.0034,
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
  it('ADR 0085: a 6-hour wait and a wait in days answer only their own events', () => {
    expect(triggerMatches({ kind: 'lead.no_reply', hours: 6 }, { hours: 6 })).toBe(true);
    expect(triggerMatches({ kind: 'lead.no_reply', hours: 6 }, { days: 6 })).toBe(false);
    expect(triggerMatches({ kind: 'lead.no_reply', days: 2 }, { days: 2 })).toBe(true);
    expect(triggerMatches({ kind: 'lead.no_reply', days: 6 }, { hours: 6 })).toBe(false);
  });
});

describe('the no-reply scan (ADR 0085)', () => {
  const dialect = new PgDialect();
  const run = async (wanted: Record<string, unknown>[], message: Record<string, unknown>[]) => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const inserted: Record<string, unknown>[] = [];
    let call = 0;
    const db = {
      execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
        const r = dialect.sqlToQuery(q);
        seen.push({ sql: r.sql, params: r.params });
        return call++ === 0 ? wanted : message;
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'e' }] }) };
        },
      }),
    } as unknown as Db;
    const made = await scanNoReply(db, new Date('2026-11-07T12:00:00Z'));
    return { made, seen, inserted };
  };
  const msg = [{ lead_id: 'L', contact_id: 'C', listing_id: null, message_id: 'M' }];

  it('looks back 6 hours, and carries the hours on the event and its key', async () => {
    const { made, seen, inserted } = await run([{ agency_id: A, days: null, hours: 6 }], msg);
    expect(made).toBe(1);
    expect(seen[1]!.sql).toMatch(/make_interval\(hours => \$\d+::int\)/);
    expect(seen[1]!.params).toEqual(expect.arrayContaining([6, 54]));
    expect(inserted[0]).toMatchObject({ kind: 'lead.no_reply', data: { hours: 6 }, dedupeKey: 'noreply:L:M:6h' });
  });
  it('a new enquiry nobody has answered counts for the 6-hour wait, if it came from the website and is still New', async () => {
    const { made, seen, inserted } = await run([{ agency_id: A, days: null, hours: 6 }], [{ lead_id: 'L', contact_id: 'C', listing_id: null, message_id: null }]);
    expect(made).toBe(1);
    expect(seen[1]!.sql).toContain('left join lateral');
    expect(seen[1]!.sql).toContain("m.id is null and l.status = 'new' and l.source = 'website'");
    expect(inserted[0]).toMatchObject({ data: { hours: 6 }, dedupeKey: 'noreply:L:enquiry:6h' });
  });
  it('a wait in days looks back the same as before, keeps its key, and still ignores a new enquiry', async () => {
    const { seen, inserted } = await run([{ agency_id: A, days: 2, hours: null }], msg);
    expect(seen[1]!.params).toEqual(expect.arrayContaining([48, 96]));
    expect(seen[1]!.sql).not.toContain('m.id is null');
    expect(seen[1]!.sql).toContain("m.direction = 'in'");
    expect(inserted[0]).toMatchObject({ data: { days: 2 }, dedupeKey: 'noreply:L:M:2' });
  });
  it('asks nothing for a wait the catalog does not allow', async () => {
    const { made, seen } = await run([{ agency_id: A, days: null, hours: 3 }, { agency_id: A, days: 15, hours: null }, { agency_id: A, days: null, hours: null }, { agency_id: A, days: 2, hours: 3 }], msg);
    expect(made).toBe(0);
    expect(seen).toHaveLength(1);
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
      'Australia/Sydney',
    );
    if ('problem' in steps) throw new Error(steps.problem);
    expect(steps.map((s) => s.tool)).toEqual(['add_note', 'send_template_email', 'draft_email']);
    expect(steps[0]!.args).toMatchObject({ contactId: 'contact-1', body: 'New enquiry from Sara on 1 George St, Parramatta, NSW 2150' });
    expect(steps[1]!.args).toMatchObject({ templateId: T1, contactIds: ['contact-1'], gapHours: 24, part: { n: 1, of: 1 } });
    expect(steps[2]!.args).toEqual({ tool: 'draft_email', contactId: 'contact-1', instructions: 'Ask when they can inspect', workflowName: 'Welcome' });
  });
  it('each step’s title names its template and people, as the card did, with its merge fields filled (ADR 0106 part 3)', () => {
    const M = '22222222-2222-4222-8222-222222222222';
    const steps = stepsFor({ name: 'W' }, { trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'send_template_email', template_id: T1 }, { type: 'message_colleagues', to: [M], subject: 'New lead', body: 'Yours' }, { type: 'remind_owner', text: 'Call {{contact_first_name}}', mail_me: false }] }, facts(), { contact_first_name: 'Sara' }, now, 'Australia/Sydney', { [T1]: 'Welcome', [M]: 'Liam Carter' });
    if ('problem' in steps) throw new Error(steps.problem);
    expect(steps.map((s) => s.card.title)).toEqual(['Send the template “Welcome” to the contact (only if they may receive it then)', 'Message Liam Carter: “New lead”', 'Remind you: “Call Sara”']);
  });
  it('a step that needs a contact the record no longer has: the run is not made, and says why', () => {
    const out = stepsFor({ name: 'X' }, { trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'add_note', text: 'x' }] }, facts({ contactId: null }), {}, now, 'Australia/Sydney');
    expect(out).toEqual({ problem: 'the contact is archived, merged or gone' });
  });
  it('ADR 0048: a wait_until becomes the next step’s window on the agency’s clock, after any wait; the step after has none', () => {
    const steps = stepsFor(
      { name: 'Office hours' },
      {
        trigger: { kind: 'lead.created' },
        conditions: [],
        actions: [
          { type: 'wait', hours: 2 },
          { type: 'wait_until', from: '09:00', to: '17:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
          { type: 'send_template_email', template_id: T1 },
          { type: 'remind_owner', text: 'Sent', mail_me: false },
        ],
      },
      facts(),
      {},
      now,
      'Australia/Perth',
    );
    if ('problem' in steps) throw new Error(steps.problem);
    expect(steps[0]!.args).toMatchObject({ gapHours: 2, window: { from: 540, to: 1020, days: [1, 2, 3, 4, 5], tz: 'Australia/Perth' } });
    expect(steps[1]!.args).not.toHaveProperty('window');
  });
});

describe('conditionsHold — ADR 0048: names, listings, distance', () => {
  const near = (km: number) => ({ field: 'listing.near' as const, op: 'within' as const, km, place: { label: 'Parramatta NSW 2150', lat: -33.8136, lng: 151.0034 } });
  it('a name: the whole name (eq/in), or a word in it (contains); case and spacing ignored', () => {
    expect(conditionsHold([{ field: 'contact.name', op: 'eq', values: ['sara  KHAN'] }], facts())).toBe(true);
    expect(conditionsHold([{ field: 'contact.name', op: 'eq', values: ['Sara'] }], facts())).toBe(false);
    expect(conditionsHold([{ field: 'contact.name', op: 'contains', values: ['smith', 'khan'] }], facts())).toBe(true);
    expect(conditionsHold([{ field: 'contact.name', op: 'not_contains', values: ['khan'] }], facts())).toBe(false);
    expect(conditionsHold([{ field: 'contact.name', op: 'contains', values: ['khan'] }], facts({ contactName: null }))).toBe(false);
  });
  it('a listing: by id', () => {
    expect(conditionsHold([{ field: 'listing', op: 'in', values: ['listing-1', 'listing-9'] }], facts())).toBe(true);
    expect(conditionsHold([{ field: 'listing', op: 'not_in', values: ['listing-1'] }], facts())).toBe(false);
  });
  it('within N km of the place; a listing without a pin never matches', () => {
    expect(distanceKm({ lat: -33.8688, lng: 151.2093 }, { lat: -33.8136, lng: 151.0034 })).toBeCloseTo(20, 0);
    expect(conditionsHold([near(1)], facts())).toBe(true);
    expect(conditionsHold([near(0.1)], facts())).toBe(false);
    expect(conditionsHold([near(50)], facts({ listingLat: null, listingLng: null }))).toBe(false);
  });
});

describe('PLATFORM-PLAN 3.4: an import starts only what asked for imports', () => {
  it('"When a contact is added" leaves imported contacts alone; "…is imported" takes only them; "…by hand" only manual ones', () => {
    const any = { kind: 'contact.created' } as Parameters<typeof triggerMatches>[0];
    const imported = { kind: 'contact.created', source: 'import' } as Parameters<typeof triggerMatches>[0];
    const byHand = { kind: 'contact.created', source: 'manual' } as Parameters<typeof triggerMatches>[0];
    expect([triggerMatches(any, { source: 'manual' }), triggerMatches(any, { source: 'import' })]).toEqual([true, false]);
    expect([triggerMatches(imported, { source: 'manual' }), triggerMatches(imported, { source: 'import' })]).toEqual([false, true]);
    expect([triggerMatches(byHand, { source: 'manual' }), triggerMatches(byHand, { source: 'import' })]).toEqual([true, false]);
  });
});

describe('ADR 0107: in turn, the agent told, a tag, Nurture', () => {
  const now = new Date('2026-11-28T00:00:00Z');
  const THIRD = '44444444-4444-4444-8444-444444444444';
  const spec = (actions: unknown[]) => workflowSpecSchema.parse({ trigger: { kind: 'lead.created' }, conditions: [], actions });
  const names = { [AGENT]: 'Liam Carter', [OTHER]: 'Olivia Nguyen', [THIRD]: 'Noah Patel' };

  it('the turn goes round the members still in the agency, in their order', () => {
    const pool = [AGENT, OTHER, THIRD];
    expect([1, 2, 3, 4, 5].map((t) => pickInTurn(pool, t))).toEqual([AGENT, OTHER, THIRD, AGENT, OTHER]);
    expect(pickInTurn([OTHER], 7)).toBe(OTHER);
    expect(pickInTurn([], 1)).toBeNull();
  });

  it('assign_in_turn gives the lead AND the contact to the member whose turn it is; a wait before it belongs to the first', () => {
    const s = stepsFor({ name: 'W' }, spec([{ type: 'wait', hours: 2 }, { type: 'assign_in_turn', among: [AGENT, OTHER, THIRD] }]), facts({ leadAssignee: null, contactAssignee: null }), {}, now, 'Australia/Sydney', names, OTHER);
    if ('problem' in s) throw new Error(s.problem);
    expect(s.map((x) => x.args)).toEqual([
      { tool: 'assign_lead', leadId: 'lead-1', to: OTHER, from: null, gapHours: 2 },
      { tool: 'assign_contacts', to: OTHER, contactIds: ['contact-1'], from: { 'contact-1': null } },
    ]);
    expect(s.map((x) => x.card.title)).toEqual(['Give the lead to Olivia Nguyen, in turn', 'Give the contact to Olivia Nguyen, in turn']);
  });

  it('with nobody left to take a turn, the run is not made and says why', () => {
    expect(stepsFor({ name: 'W' }, spec([{ type: 'assign_in_turn', among: [AGENT, OTHER] }]), facts(), {}, now, 'Australia/Sydney', names, null)).toEqual({
      problem: 'none of the members it gives leads to in turn is still in the agency',
    });
  });

  it('message_assigned_agent tells whoever this run gave it to — else the lead’s agent, else the contact’s, else nobody', () => {
    const msg = { type: 'message_assigned_agent', subject: 'New lead for {{contact_first_name}}', body: 'It is yours' };
    const turn = stepsFor({ name: 'W' }, spec([{ type: 'assign_in_turn', among: [AGENT, OTHER] }, msg]), facts(), { contact_first_name: 'Sara' }, now, 'Australia/Sydney', names, OTHER);
    if ('problem' in turn) throw new Error(turn.problem);
    expect(turn[2]!.args).toEqual({ tool: 'message_colleagues', to: [OTHER], subject: 'New lead for Sara', body: 'It is yours' });
    expect(turn[2]!.card.title).toBe('Message Olivia Nguyen: “New lead for Sara”');
    const lead = stepsFor({ name: 'W' }, spec([msg]), facts({ leadAssignee: THIRD, contactAssignee: AGENT }), {}, now, 'Australia/Sydney');
    expect(!('problem' in lead) && lead[0]!.args).toMatchObject({ to: [THIRD] });
    const contactOnly = stepsFor({ name: 'W' }, spec([msg]), facts({ leadAssignee: null, contactAssignee: AGENT }), {}, now, 'Australia/Sydney');
    expect(!('problem' in contactOnly) && contactOnly[0]!.args).toMatchObject({ to: [AGENT] });
    expect(stepsFor({ name: 'W' }, spec([msg]), facts({ leadAssignee: null, contactAssignee: null }), {}, now, 'Australia/Sydney')).toEqual({ problem: 'nobody has been given it yet, so there is no agent to message' });
  });

  it('tag_contact tags the run’s contact; set_lead_status takes Nurture', () => {
    const s = stepsFor({ name: 'W' }, spec([{ type: 'tag_contact', tag: 'Cold' }, { type: 'set_lead_status', to: 'nurture' }]), facts(), {}, now, 'Australia/Sydney');
    if ('problem' in s) throw new Error(s.problem);
    expect(s.map((x) => x.args)).toEqual([
      { tool: 'tag_contact', contactId: 'contact-1', tag: 'Cold' },
      { tool: 'set_lead_status', leadId: 'lead-1', status: 'nurture', before: 'new' },
    ]);
    expect(s.map((x) => x.card.title)).toEqual(['Tag the contact “Cold”', 'Move the lead to Nurture']);
    expect(s[0]!.contactId).toBe('contact-1');
  });

  it('in turn is agency-wide only, needs 2 to 20 different members; a tag is 1 to 30 characters', () => {
    const one = (a: unknown) => workflowSpecSchema.safeParse({ trigger: { kind: 'lead.created' }, conditions: [], actions: [a] });
    expect(specProblem(spec([{ type: 'assign_in_turn', among: [AGENT, OTHER] }]), 'mine')).toMatch(/only an agency-wide workflow/);
    expect(specProblem(spec([{ type: 'assign_in_turn', among: [AGENT, OTHER] }]), 'agency')).toBeNull();
    expect(one({ type: 'assign_in_turn', among: [AGENT] }).success).toBe(false);
    expect(one({ type: 'assign_in_turn', among: [AGENT, AGENT] }).success).toBe(false);
    expect(one({ type: 'tag_contact', tag: 'x'.repeat(31) }).success).toBe(false);
    expect(one({ type: 'tag_contact', tag: '  ' }).success).toBe(false);
  });
});
