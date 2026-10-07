import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { issueHandle, parseHandleMap, resolveHandle, type HandleMap } from './handles';
import { ASSISTANT_TOOL_INPUTS, assistantTurnRequestSchema, handleSchema } from './schema';
import { runAssistantTool, type ToolContext } from './tools';

/**
 * The assistant's injection boundary (ADR 0025 §3–4), without a database:
 * references, schemas, and the refusals that happen before any query.
 * Scope against real rows is in the smoke suite ("Console assistant").
 */

const agencyId = '11111111-1111-1111-1111-111111111111';
const contactId = '22222222-2222-2222-2222-222222222222';

/** A db that fails the test if anything reaches it. */
const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;

function ctx(handles: HandleMap = {}, role: 'agent' | 'owner' | 'read_only' = 'agent'): ToolContext {
  return { db: noDb, actor: { userId: 'u1', agencyId, membershipRole: role }, timeZone: 'Australia/Melbourne', handles, now: new Date('2026-10-06T03:00:00Z') };
}

describe('handles', () => {
  it('names a row once per conversation and counts up per kind', () => {
    const map: HandleMap = {};
    expect(issueHandle(map, 'C', 'a')).toBe('C1');
    expect(issueHandle(map, 'C', 'b')).toBe('C2');
    expect(issueHandle(map, 'C', 'a')).toBe('C1');
    expect(issueHandle(map, 'L', 'x')).toBe('L1');
    expect(issueHandle(map, 'S', 'a')).toBe('S1');
  });

  it('resolves only names it issued, for the kind asked', () => {
    const map: HandleMap = {};
    issueHandle(map, 'C', contactId);
    issueHandle(map, 'L', 'lead-1');
    expect(resolveHandle(map, 'C1', 'contact')).toBe(contactId);
    expect(resolveHandle(map, 'C2', 'contact')).toBeNull();
    expect(resolveHandle(map, 'L1', 'contact')).toBeNull();
  });

  it('drops anything malformed or mislabelled from a stored map', () => {
    const map = parseHandleMap({
      C1: { k: 'contact', id: 'a' },
      C2: { k: 'lead', id: 'b' },
      X1: { k: 'contact', id: 'c' },
      L1: { k: 'lead' },
      S1: { k: 'contact', id: 'd' },
    });
    expect(Object.keys(map).sort()).toEqual(['C1', 'S1']);
    expect(parseHandleMap('nonsense')).toEqual({});
  });
});

describe('schemas', () => {
  it('a reference is a handle — never a UUID, a name or an email', () => {
    for (const ok of ['C1', 'L20', 'S3', 'A999']) expect(handleSchema.safeParse(ok).success).toBe(true);
    for (const bad of [contactId, 'Ali Khan', 'ali@example.com', 'C0', 'C1000', 'C1; drop table', 'c1', 'Z1', '']) {
      expect(handleSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses unknown fields and limits over 20', () => {
    expect(ASSISTANT_TOOL_INPUTS.find_contacts.safeParse({ text: 'a', agency_id: agencyId }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.find_contacts.safeParse({ limit: 21 }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.find_leads.safeParse({ contact: 'L1' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.find_leads.safeParse({ contact: 'S2', since: '7d' }).success).toBe(true);
  });

  it('a turn request carries ids only for selection, a real zone, and a bounded message', () => {
    const base = { message: 'my leads this week', timeZone: 'Australia/Perth' };
    expect(assistantTurnRequestSchema.safeParse(base).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'x'.repeat(2001) }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, selection: { contactIds: ['Ali'] } }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, selection: { contactIds: Array(21).fill(contactId) } }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, userId: 'someone-else' }).success).toBe(false);
  });
});

describe('runAssistantTool refuses before reaching the database', () => {
  it('a tool that does not exist (nothing writes, nothing approves)', async () => {
    for (const name of ['send_email', 'approve_action', 'create_appointment', 'run_sql']) {
      const out = await runAssistantTool(ctx(), name, {});
      expect(out.isError).toBe(true);
      expect(JSON.stringify(out.result)).toMatch(/no tool called/);
    }
  });

  it('a reference this conversation never issued', async () => {
    for (const tool of ['find_leads', 'find_appointments']) {
      const out = await runAssistantTool(ctx({}), tool, { contact: 'C9' });
      expect(out.isError).toBe(true);
      expect(JSON.stringify(out.result)).toMatch(/not one you were given/);
    }
  });

  it('a raw id, name or email where a reference goes', async () => {
    for (const contact of [contactId, 'Ali Khan', 'ali@example.com']) {
      const out = await runAssistantTool(ctx(), 'find_leads', { contact });
      expect(out.isError).toBe(true);
    }
  });

  it('someone with no agency membership', async () => {
    const out = await runAssistantTool({ ...ctx(), actor: { userId: 'u1' } }, 'find_contacts', {});
    expect(out.isError).toBe(true);
  });
});

describe('the assistant module writes nothing but its own tables — every other write goes through a screen’s own core function', () => {
  it('no insert/update/delete of a domain table under core/src/assistant', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/\.(insert|update|delete)\(\s*([A-Za-z]+)/g)) {
        if (!['assistantConversation', 'assistantTurn', 'proposedAction'].includes(m[2]!)) offenders.push(`${file}: .${m[1]}(${m[2]})`);
      }
      if (/\b(insert into|update \w+ set|delete from)\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) offenders.push(`${file}: raw SQL write`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Each read is a known number of round trips (CLAUDE.md: an N+1 is a bug) —
 * measured with three rows, because zero rows hide a per-row query.
 */
function countingDb() {
  let queries = 0;
  const row = (i: number) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    name: `Person ${i}`,
    archivedAt: null,
    assignedTo: 'u1',
    assigneeName: 'U',
    roles: '{buyer}',
    total: '3',
    status: 'new',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    contactId: `00000000-0000-4000-8000-00000000010${i}`,
    contactVisible: 't',
    contactName: 'C',
    title: 'Appraisal',
    type: 'appraisal',
    startsAt: new Date('2026-10-07T00:00:00Z'),
    suburb: 'Pakenham',
    state: 'VIC',
    postcode: '3810',
  });
  const rows = [row(1), row(2), row(3)];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'selectDistinct', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'offset']) chain[m] = () => chain;
  const terminal = () => {
    queries += 1;
    return Promise.resolve(rows);
  };
  chain.execute = terminal;
  chain.returning = terminal;
  chain.then = (res: (v: unknown) => unknown) => terminal().then(res);
  return { db: chain as unknown as Db, count: () => queries };
}

describe('each tool is one statement, and totals are numbers', () => {
  for (const [tool, input] of [
    ['find_contacts', {}],
    ['find_leads', { since: '7d', listing_text: 'Smoke' }],
    ['find_appointments', { range: 'tomorrow' }],
    ['check_connections', { providers: ['google_calendar', 'zoom'] }],
  ] as const) {
    it(tool, async () => {
      const { db, count } = countingDb();
      const out = await runAssistantTool({ ...ctx({}, 'owner'), db }, tool, input);
      expect(out.isError ?? false).toBe(false);
      expect(count()).toBe(1);
      const frame = out.frame as { total?: unknown } | undefined;
      if (frame && 'total' in frame) expect(typeof frame.total).toBe('number');
    });
  }

  it('the same row keeps its reference across tools in one conversation', async () => {
    const handles: HandleMap = {};
    const { db } = countingDb();
    await runAssistantTool({ ...ctx(handles, 'owner'), db }, 'find_contacts', {});
    const before = { ...handles };
    await runAssistantTool({ ...ctx(handles, 'owner'), db }, 'find_contacts', { text: 'Person' });
    expect(handles).toEqual(before);
  });
});

describe('write tools (Phases B and C) — schema and refusals before any database work', () => {
  const C = issueHandle({}, 'C', contactId);
  const valid: Record<string, Record<string, unknown>> = {
    add_note: { contact: 'C1', body: 'Called — wants a Saturday inspection.' },
    set_next_action: { contact: 'S1', text: 'Send the contract', date: '2026-10-09', time: '10:00' },
    schedule_appointment: { contact: 'C1', type: 'appraisal', title: 'Appraisal', date: '2026-10-09', time: '15:00' },
    reschedule_appointment: { appointment: 'A1', date: '2026-10-10', time: '09:30' },
    cancel_appointment: { appointment: 'A1', reason: 'Vendor asked' },
    send_template_email: { template: 'T1', recipients: ['S1', 'C2'] },
  };

  it('accepts the documented shape for each', () => {
    expect(C).toBe('C1');
    for (const [tool, input] of Object.entries(valid)) {
      expect(ASSISTANT_TOOL_INPUTS[tool as keyof typeof ASSISTANT_TOOL_INPUTS].safeParse(input).success, tool).toBe(true);
    }
  });

  it('never takes an id, a name, an email, or a reference of the wrong kind', () => {
    for (const contact of [contactId, 'Ali Khan', 'ali@example.com', 'L1', 'A1']) {
      expect(ASSISTANT_TOOL_INPUTS.add_note.safeParse({ ...valid.add_note, contact }).success, contact).toBe(false);
      expect(ASSISTANT_TOOL_INPUTS.schedule_appointment.safeParse({ ...valid.schedule_appointment, contact }).success, contact).toBe(false);
    }
    for (const appointment of ['C1', 'S1', contactId]) {
      expect(ASSISTANT_TOOL_INPUTS.cancel_appointment.safeParse({ appointment }).success, appointment).toBe(false);
    }
  });

  it('refuses extra fields — no recipient, owner, agency or status can be smuggled in', () => {
    for (const extra of [{ to: 'everyone@x.com' }, { userId: 'u2' }, { agencyId }, { status: 'approved' }, { approve: true }]) {
      for (const [tool, input] of Object.entries(valid)) {
        expect(ASSISTANT_TOOL_INPUTS[tool as keyof typeof ASSISTANT_TOOL_INPUTS].safeParse({ ...input, ...extra }).success, `${tool} ${JSON.stringify(extra)}`).toBe(false);
      }
    }
  });

  it('dates and times must be real calendar values, and lengths are bounded', () => {
    expect(ASSISTANT_TOOL_INPUTS.schedule_appointment.safeParse({ ...valid.schedule_appointment, time: '3pm' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.schedule_appointment.safeParse({ ...valid.schedule_appointment, time: '25:00' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.schedule_appointment.safeParse({ ...valid.schedule_appointment, date: 'tomorrow' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.schedule_appointment.safeParse({ ...valid.schedule_appointment, duration_minutes: 600 }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.add_note.safeParse({ ...valid.add_note, body: 'x'.repeat(5001) }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.set_next_action.safeParse({ ...valid.set_next_action, text: 'x'.repeat(301) }).success).toBe(false);
  });

  it('a reference this conversation never issued is refused before the database is touched', async () => {
    for (const [tool, input] of Object.entries(valid)) {
      const out = await runAssistantTool(ctx({}), tool, input);
      expect(out.isError, tool).toBe(true);
      expect(JSON.stringify(out.result), tool).toMatch(/not one you were given/);
    }
  });

  it('a contact reference is not an appointment reference, even with the same id', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    const out = await runAssistantTool(ctx(handles), 'cancel_appointment', { appointment: 'A1' });
    expect(out.isError).toBe(true);
  });
});

describe('send_template_email (Phase D) — recipients are references, never text', () => {
  const ok = { template: 'T1', recipients: ['S1', 'S2', 'C3'] };
  it('accepts a template reference and contact references', () => {
    expect(ASSISTANT_TOOL_INPUTS.send_template_email.safeParse(ok).success).toBe(true);
  });
  it('refuses an address, a name, an id, a lead or appointment reference, or a template where a person goes', () => {
    for (const bad of ['ali@example.com', 'Ali Khan', contactId, 'L1', 'A1', 'T2']) {
      expect(ASSISTANT_TOOL_INPUTS.send_template_email.safeParse({ ...ok, recipients: ['S1', bad] }).success, bad).toBe(false);
    }
    expect(ASSISTANT_TOOL_INPUTS.send_template_email.safeParse({ ...ok, template: 'C1' }).success).toBe(false);
  });
  it('refuses email text, extra recipients fields and more than 20 people', () => {
    for (const extra of [{ subject: 'Hi' }, { body: 'Buy now' }, { to: 'x@y.z' }, { cc: ['x@y.z'] }, { filter: 'all' }]) {
      expect(ASSISTANT_TOOL_INPUTS.send_template_email.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(ASSISTANT_TOOL_INPUTS.send_template_email.safeParse({ ...ok, recipients: Array.from({ length: 21 }, (_, i) => `C${i + 1}`) }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.send_template_email.safeParse({ ...ok, recipients: [] }).success).toBe(false);
  });
  it('a template or recipient reference never issued is refused before the database', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'S', contactId);
    const noTemplate = await runAssistantTool(ctx(handles), 'send_template_email', { template: 'T1', recipients: ['S1'] });
    expect(noTemplate.isError).toBe(true);
    issueHandle(handles, 'T', '33333333-3333-3333-3333-333333333333');
    const strangerRecipient = await runAssistantTool(ctx(handles), 'send_template_email', { template: 'T1', recipients: ['S1', 'C9'] });
    expect(strangerRecipient.isError).toBe(true);
    expect(JSON.stringify(strangerRecipient.result)).toMatch(/C9/);
  });
  it('a read-only member cannot propose it (refused before preparing anything)', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'S', contactId);
    issueHandle(handles, 'T', '33333333-3333-3333-3333-333333333333');
    const out = await runAssistantTool(ctx(handles, 'read_only'), 'send_template_email', { template: 'T1', recipients: ['S1'] });
    expect(out.isError).toBe(true);
  });
});


describe('assign_contacts (owners and admins only) — contacts and the receiver are references', () => {
  const ok = { contacts: ['C1', 'S2'], to: 'M1' };
  it('accepts contact references and one member reference', () => {
    expect(ASSISTANT_TOOL_INPUTS.assign_contacts.safeParse(ok).success).toBe(true);
    expect(issueHandle({}, 'M', 'someone')).toBe('M1');
  });
  it('the receiver is a member reference — never a name, an email, an id or a contact', () => {
    for (const to of ['Sara', 'sara@example.com', contactId, 'C1', 'S1', 'A1']) {
      expect(ASSISTANT_TOOL_INPUTS.assign_contacts.safeParse({ ...ok, to }).success, to).toBe(false);
    }
    expect(ASSISTANT_TOOL_INPUTS.assign_contacts.safeParse({ ...ok, contacts: ['C1', 'M1'] }).success).toBe(false);
  });
  it('at most 20 contacts on one card, and never by filter or "all"', () => {
    expect(ASSISTANT_TOOL_INPUTS.assign_contacts.safeParse({ ...ok, contacts: Array.from({ length: 21 }, (_, i) => `C${i + 1}`) }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.assign_contacts.safeParse({ ...ok, contacts: [] }).success).toBe(false);
    for (const extra of [{ all: true }, { filter: 'buyers' }, { role: 'buyer' }, { lead: 'L1' }]) {
      expect(ASSISTANT_TOOL_INPUTS.assign_contacts.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
  it('an agent or a read-only member is refused before the database — to assign and to list the team', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    issueHandle(handles, 'S', '44444444-4444-4444-4444-444444444444');
    issueHandle(handles, 'M', '55555555-5555-5555-5555-555555555555');
    for (const role of ['agent', 'read_only'] as const) {
      const assign = await runAssistantTool(ctx(handles, role), 'assign_contacts', ok);
      expect(assign.isError, role).toBe(true);
      expect(JSON.stringify(assign.result), role).toMatch(/owner or admin/);
      const team = await runAssistantTool(ctx(handles, role), 'find_team_members', {});
      expect(team.isError, role).toBe(true);
    }
  });
  it('a receiver reference this conversation never issued is refused before the database', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    const out = await runAssistantTool(ctx(handles, 'owner'), 'assign_contacts', { contacts: ['C1'], to: 'M1' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/not one you were given/);
  });
});

describe('record / withdraw marketing consent — references only, a stated "how", never in bulk', () => {
  const ok = { contacts: ['C1', 'S1'], how: 'Said yes on the phone, 7 Oct' };
  it('accepts contact references and how they agreed', () => {
    expect(ASSISTANT_TOOL_INPUTS.record_marketing_consent.safeParse(ok).success).toBe(true);
    expect(ASSISTANT_TOOL_INPUTS.withdraw_marketing_consent.safeParse({ contacts: ['C1'], reason: 'Asked us to stop on the phone' }).success).toBe(true);
  });
  it('"how" is required — missing or blank is refused, with an instruction to ask', () => {
    for (const how of [undefined, '', '   ']) {
      const r = ASSISTANT_TOOL_INPUTS.record_marketing_consent.safeParse({ contacts: ['C1'], ...(how === undefined ? {} : { how }) });
      expect(r.success, JSON.stringify(how)).toBe(false);
    }
    for (const reason of [undefined, '', '  ']) {
      expect(ASSISTANT_TOOL_INPUTS.withdraw_marketing_consent.safeParse({ contacts: ['C1'], ...(reason === undefined ? {} : { reason }) }).success).toBe(false);
    }
  });
  it('never "all", a filter, a name or more than 20 on a card', () => {
    for (const extra of [{ all: true }, { filter: 'buyers' }, { role: 'buyer' }, { suburb: 'Pakenham' }]) {
      expect(ASSISTANT_TOOL_INPUTS.record_marketing_consent.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const c of ['Ali Khan', 'ali@example.com', contactId, 'M1', 'L1']) {
      expect(ASSISTANT_TOOL_INPUTS.record_marketing_consent.safeParse({ ...ok, contacts: [c] }).success, c).toBe(false);
    }
    expect(ASSISTANT_TOOL_INPUTS.record_marketing_consent.safeParse({ ...ok, contacts: Array.from({ length: 21 }, (_, i) => `C${i + 1}`) }).success).toBe(false);
  });
  it('a blank "how" is refused before the database, and says to ask the person', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    const out = await runAssistantTool(ctx(handles), 'record_marketing_consent', { contacts: ['C1'], how: ' ' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/Ask the person how/);
  });
  it('a read-only member is refused before the database', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    for (const [tool, input] of [['record_marketing_consent', ok], ['withdraw_marketing_consent', { contacts: ['C1'], reason: 'x' }]] as const) {
      const out = await runAssistantTool(ctx(handles, 'read_only'), tool, { ...input, contacts: ['C1'] });
      expect(out.isError, tool).toBe(true);
    }
  });
});

describe('update_contact / set_contact_archived — the edit form’s details only; never assignment, consent, next action or delete', () => {
  const ok = { contact: 'C1', name: 'Ali Khan', email: 'ali@example.com', phone: '0412 345 678', roles: ['buyer'] };
  it('accepts a reference and any of name, email, phone and roles', () => {
    expect(ASSISTANT_TOOL_INPUTS.update_contact.safeParse(ok).success).toBe(true);
    expect(ASSISTANT_TOOL_INPUTS.update_contact.safeParse({ contact: 'S1', phone: '' }).success).toBe(true);
    expect(ASSISTANT_TOOL_INPUTS.set_contact_archived.safeParse({ contact: 'C1', archived: true }).success).toBe(true);
  });
  it('has no way to change who it is assigned to, consent, the next action, the archive or to delete', () => {
    for (const extra of [
      { assigned_to: 'M1' }, { assignedTo: 'M1' }, { to: 'M1' }, { marketing_consent: true }, { consent: true },
      { how: 'said yes' }, { next_action: 'call' }, { archived: true }, { delete: true }, { deleted: true }, { merge: 'C2' },
    ]) {
      expect(ASSISTANT_TOOL_INPUTS.update_contact.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const extra of [{ delete: true }, { name: 'x' }, { assigned_to: 'M1' }]) {
      expect(ASSISTANT_TOOL_INPUTS.set_contact_archived.safeParse({ contact: 'C1', archived: true, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(Object.keys(ASSISTANT_TOOL_INPUTS).filter((t) => /delete|merge/.test(t))).toEqual([]);
  });
  it('an email must be an email; the contact must be a reference; one contact per card', () => {
    expect(ASSISTANT_TOOL_INPUTS.update_contact.safeParse({ ...ok, email: 'not an email' }).success).toBe(false);
    for (const contact of ['Ali Khan', contactId, 'M1', 'L1']) {
      expect(ASSISTANT_TOOL_INPUTS.update_contact.safeParse({ ...ok, contact }).success, contact).toBe(false);
    }
    expect(ASSISTANT_TOOL_INPUTS.update_contact.safeParse({ ...ok, contact: ['C1', 'C2'] }).success).toBe(false);
  });
  it('a card that changes nothing is refused before the database', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    const out = await runAssistantTool(ctx(handles), 'update_contact', { contact: 'C1' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/which detail/);
  });
  it('a read-only member is refused before the database', async () => {
    const handles: HandleMap = {};
    issueHandle(handles, 'C', contactId);
    for (const [tool, input] of [['update_contact', { contact: 'C1', name: 'X' }], ['set_contact_archived', { contact: 'C1', archived: true }]] as const) {
      const out = await runAssistantTool(ctx(handles, 'read_only'), tool, input);
      expect(out.isError, tool).toBe(true);
      expect(JSON.stringify(out.result), tool).toMatch(/not change them/);
    }
  });
});
