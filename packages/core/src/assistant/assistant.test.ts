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

describe('write tools (Phase B) — schema and refusals before any database work', () => {
  const C = issueHandle({}, 'C', contactId);
  const valid: Record<string, Record<string, unknown>> = {
    add_note: { contact: 'C1', body: 'Called — wants a Saturday inspection.' },
    set_next_action: { contact: 'S1', text: 'Send the contract', date: '2026-10-09', time: '10:00' },
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
      expect(ASSISTANT_TOOL_INPUTS.set_next_action.safeParse({ ...valid.set_next_action, contact }).success, contact).toBe(false);
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
    expect(ASSISTANT_TOOL_INPUTS.set_next_action.safeParse({ ...valid.set_next_action, time: '3pm' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.set_next_action.safeParse({ ...valid.set_next_action, time: '25:00' }).success).toBe(false);
    expect(ASSISTANT_TOOL_INPUTS.set_next_action.safeParse({ ...valid.set_next_action, date: 'tomorrow' }).success).toBe(false);
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

});
