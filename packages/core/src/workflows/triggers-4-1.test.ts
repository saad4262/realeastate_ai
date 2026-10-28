import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { specProblem, TRIGGER_GUIDE, TRIGGER_KINDS, triggerInWords, workflowSpecSchema } from './catalog';
import { inScope, triggerMatches, type Facts } from './engine';
import { runTriggerScans } from './scans';
import { specFrom } from '../assistant/workflow-tools';

/** ADR 0066 (ROADMAP 4.1): seven more triggers — deals, buyer matches, appointments, past clients. */

const A = 'agency-a';
const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const spec = (trigger: unknown, actions: unknown[] = [{ type: 'remind_owner', text: 'Call {{contact_first_name}}' }]) => workflowSpecSchema.parse({ trigger, actions });

describe('the new triggers in the catalog', () => {
  it('parse with their settings, a deal side defaulting to the vendor', () => {
    expect(spec({ kind: 'deal.stage_reached', to: 'contract' }).trigger).toEqual({ kind: 'deal.stage_reached', to: 'contract', who: 'vendor' });
    expect(spec({ kind: 'deal.settled', who: 'buyer' }).trigger).toEqual({ kind: 'deal.settled', who: 'buyer' });
    expect(() => spec({ kind: 'appointment.upcoming', hours: 73 })).toThrow();
    expect(() => spec({ kind: 'appraisal.not_listed', days: 31 })).toThrow();
    expect(() => spec({ kind: 'sale.anniversary', years: 0 })).toThrow();
    expect(spec({ kind: 'buyer.matched' }).trigger.kind).toBe('buyer.matched');
  });
  it('refuse a step their record cannot give: there is no lead on a deal, a match or an anniversary', () => {
    for (const trigger of [{ kind: 'deal.settled' }, { kind: 'buyer.matched' }, { kind: 'sale.anniversary', years: 5 }, { kind: 'appointment.completed' }]) {
      expect(specProblem(spec(trigger, [{ type: 'set_lead_status', to: 'closed' }]), 'agency')).toMatch(/no lead to act on/);
      expect(specProblem(spec(trigger, [{ type: 'send_template_email', template_id: '33333333-3333-4333-8333-333333333333' }]), 'agency')).toBeNull();
    }
  });
  it('say themselves in words', () => {
    expect(triggerInWords(spec({ kind: 'deal.stage_reached', to: 'contract', who: 'buyer' }).trigger)).toBe('When a deal reaches Contract — the buyer');
    expect(triggerInWords(spec({ kind: 'appointment.upcoming', hours: 24, type: 'inspection' }).trigger)).toBe('1 day before an inspection starts');
    expect(triggerInWords(spec({ kind: 'sale.anniversary', years: 5 }).trigger)).toBe('5 years to the day after we sold an address — its owners and buyer');
  });
  it('are all in the Automations tab’s guide, seven of them new', () => {
    expect(Object.keys(TRIGGER_GUIDE).sort()).toEqual([...TRIGGER_KINDS].sort());
    expect(TRIGGER_KINDS.filter((k) => TRIGGER_GUIDE[k].isNew)).toHaveLength(7);
  });
  it('are exactly what the database’s CHECK allows (the newest migration that sets it)', () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/drizzle');
    const latest = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().reverse()
      .map((f) => readFileSync(resolve(dir, f), 'utf8'))
      .find((s) => s.includes('ADD CONSTRAINT "workflow_event_kind_check"'))!;
    const allowed = latest.match(/workflow_event_kind_check" CHECK \(kind IN \(([^)]*)\)\)/)![1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(allowed.sort()).toEqual([...TRIGGER_KINDS].sort());
  });
});

describe('matching an event', () => {
  it('compares each trigger’s own settings, and a deal’s side', () => {
    expect(triggerMatches({ kind: 'deal.stage_reached', to: 'contract', who: 'vendor' }, { to: 'contract', who: 'vendor' })).toBe(true);
    expect(triggerMatches({ kind: 'deal.stage_reached', to: 'contract', who: 'vendor' }, { to: 'contract', who: 'buyer' })).toBe(false);
    expect(triggerMatches({ kind: 'deal.stage_reached', to: 'contract', who: 'vendor' }, { to: 'offers', who: 'vendor' })).toBe(false);
    expect(triggerMatches({ kind: 'deal.settled', who: 'buyer' }, { who: 'buyer', to: 'settlement' })).toBe(true);
    expect(triggerMatches({ kind: 'appointment.upcoming', hours: 24, type: 'inspection' }, { hours: 24, type: 'appraisal' })).toBe(false);
    expect(triggerMatches({ kind: 'appointment.upcoming', hours: 24 }, { hours: 24, type: 'appraisal' })).toBe(true);
    expect(triggerMatches({ kind: 'appointment.completed', type: 'inspection' }, { type: 'inspection' })).toBe(true);
    expect(triggerMatches({ kind: 'appraisal.not_listed', days: 7 }, { days: 3 })).toBe(false);
    expect(triggerMatches({ kind: 'sale.anniversary', years: 5 }, { years: 5 })).toBe(true);
  });
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  agencyId: A, leadId: null, leadStatus: null, leadKind: null, leadSource: null, leadAssignee: null, leadListingId: null,
  contactId: 'contact-1', contactName: 'Priya Mehta', contactAssignee: OTHER, contactRoles: [], listingId: 'listing-1', listingSuburb: 'Pakenham',
  listingChannel: 'sale', listingAddress: '12 Rogers St', listingLat: null, listingLng: null, appointmentId: null, appointmentType: null, appointmentAgent: null,
  dealAgent: null, ...over,
});
const agent = (listingAgentOf: string[] = []): Actor => ({ userId: AGENT, agencyId: A, membershipRole: 'agent', listingAgentOf });
const mine = { scope: 'mine', agencyId: A };

describe('a personal workflow stays on the agent’s own records', () => {
  it('a deal: theirs as its agent or on its listing — not because the vendor is someone else’s contact', () => {
    expect(inScope(agent(), mine, facts({ dealAgent: AGENT }), 'deal.settled')).toBe(true);
    expect(inScope(agent(['listing-1']), mine, facts(), 'deal.stage_reached')).toBe(true);
    expect(inScope(agent(), mine, facts({ contactAssignee: AGENT }), 'deal.settled')).toBe(false);
  });
  it('a buyer match: only a buyer assigned to them', () => {
    expect(inScope(agent(['listing-1']), mine, facts(), 'buyer.matched')).toBe(false);
    expect(inScope(agent(), mine, facts({ contactAssignee: AGENT }), 'buyer.matched')).toBe(true);
  });
  it('an anniversary: their contact, or the sale was theirs', () => {
    expect(inScope(agent(), mine, facts(), 'sale.anniversary')).toBe(false);
    expect(inScope(agent(['listing-1']), mine, facts(), 'sale.anniversary')).toBe(true);
  });
});

describe('the scans', () => {
  const dialect = new PgDialect();
  const fakeDb = (wanted: Record<string, unknown>[]) => {
    const seen: { sql: string; params: unknown[] }[] = [];
    let first = true;
    const db = {
      execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
        const r = dialect.sqlToQuery(q);
        seen.push({ sql: r.sql, params: r.params });
        if (first) {
          first = false;
          return wanted;
        }
        return [];
      },
    } as unknown as Db;
    return { db, seen };
  };
  it('cost one query when no workflow wants them', async () => {
    const { db, seen } = fakeDb([]);
    await runTriggerScans(db, new Date('2026-10-28T00:00:00Z'));
    expect(seen).toHaveLength(1);
  });
  it('write each event once, keyed, typed, and never reach back before the workflow was made', async () => {
    const since = '2026-10-27T00:00:00Z';
    const { db, seen } = fakeDb([
      { agency_id: A, kind: 'deal.settled', setting: null, since },
      { agency_id: A, kind: 'buyer.matched', setting: null, since },
      { agency_id: A, kind: 'appointment.upcoming', setting: 24, since },
      { agency_id: A, kind: 'appraisal.not_listed', setting: 7, since },
      { agency_id: A, kind: 'sale.anniversary', setting: 5, since },
      { agency_id: A, kind: 'appointment.upcoming', setting: 999, since },
    ]);
    await runTriggerScans(db, new Date('2026-10-28T00:00:00Z'));
    const inserts = seen.slice(1);
    expect(inserts).toHaveLength(5); // the out-of-range setting is ignored
    for (const q of inserts) {
      expect(q.sql).toContain('insert into workflow_event');
      expect(q.sql).toContain('on conflict do nothing');
    }
    expect(inserts[0]!.sql).toContain("'deal:' || de.id");
    expect(inserts[0]!.sql).toContain("(values ('vendor'), ('buyer'))");
    expect(inserts[1]!.sql).toContain("br.status = 'active'");
    expect(inserts[2]!.sql).toMatch(/make_interval\(hours => \$\d+::int\)/);
    expect(inserts[3]!.sql).toContain('li.created_at > a.starts_at');
    expect(inserts[4]!.sql).toContain('v.vendor_contact_id = c.id');
    expect(inserts[4]!.sql).toContain('cp.created_at > li.sold_date');
    expect(inserts.slice(0, 2).every((q) => q.params.includes(since))).toBe(true);
  });
});

describe('the assistant’s parts', () => {
  const ctx = { handles: new Map() } as never;
  const base = { name: 'x', scope: 'agency' as const, conditions: [], actions: [{ type: 'remind_owner' as const, text: 'hi' }] };
  it('need each trigger’s setting, and give a deal the vendor unless told', () => {
    expect(specFrom(ctx, { ...base, trigger: { kind: 'deal.stage_reached' } } as never)).toEqual({ problem: expect.stringContaining('deal_stage') });
    expect(specFrom(ctx, { ...base, trigger: { kind: 'deal.stage_reached', deal_stage: 'contract' } } as never)).toMatchObject({ spec: { trigger: { kind: 'deal.stage_reached', to: 'contract', who: 'vendor' } } });
    expect(specFrom(ctx, { ...base, trigger: { kind: 'appointment.upcoming' } } as never)).toEqual({ problem: expect.stringContaining('hours') });
    expect(specFrom(ctx, { ...base, trigger: { kind: 'lead.no_reply', days: 20 } } as never)).toEqual({ problem: expect.stringContaining('1 to 14') });
    expect(specFrom(ctx, { ...base, trigger: { kind: 'sale.anniversary', years: 10 } } as never)).toMatchObject({ spec: { trigger: { kind: 'sale.anniversary', years: 10 } } });
  });
});
