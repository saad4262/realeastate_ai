import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { specInWords, stopsOnReply, workflowSpecSchema } from './catalog';
import { repliedSinceRun, STOPPED_BY_REPLY } from './reply-stop';
import { lastRunWords } from './manage';

/** ADR 0103: a reply from the run's person stops the steps still to come. The query's behaviour is in smoke. */

const fake = (rows: unknown[]) => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: SQL) => {
      seen.push(new PgDialect().sqlToQuery(q));
      return rows;
    },
  } as unknown as DbOrTx;
  return { db, seen };
};

describe('repliedSinceRun', () => {
  it('asks once, for the task, and only for inbound mail or texts after the run, in its agency', async () => {
    const { db, seen } = fake([{ replied: true }]);
    expect(await repliedSinceRun(db, 'task-1')).toBe(true);
    expect(seen).toHaveLength(1);
    const q = seen[0]!.sql;
    expect(seen[0]!.params).toEqual(['task-1']);
    expect(q).toContain('r.task_id = $1');
    expect(q.match(/direction = 'in'/g)).toHaveLength(2);
    expect(q.match(/created_at > r\.created_at/g)).toHaveLength(2);
    expect(q).toContain('t.agency_id = r.agency_id');
    expect(q).toContain('s.agency_id = r.agency_id');
    expect(q).toContain("coalesce(w.spec->>'stop_on_reply', 'true') <> 'false'");
    expect(q).toContain('(t.contact_id = r.contact_id or t.lead_id = r.lead_id)');
  });
  it('no run, a workflow set to carry on, or no reply: the step runs', async () => {
    expect(await repliedSinceRun(fake([]).db, 'task-1')).toBe(false);
    expect(await repliedSinceRun(fake([{ replied: false }]).db, 'task-1')).toBe(false);
  });
});

describe('stop_on_reply in the spec', () => {
  const base = { trigger: { kind: 'lead.created' as const }, conditions: [], actions: [{ type: 'remind_owner' as const, text: 'Call them', mail_me: false }] };
  it('is on unless it says false, so saved workflows stop too', () => {
    expect(stopsOnReply(base)).toBe(true);
    expect(stopsOnReply({ ...base, stop_on_reply: true })).toBe(true);
    expect(stopsOnReply({ ...base, stop_on_reply: false })).toBe(false);
    expect(workflowSpecSchema.safeParse(base).success).toBe(true);
    expect(workflowSpecSchema.safeParse({ ...base, stop_on_reply: false }).success).toBe(true);
    expect(workflowSpecSchema.safeParse({ ...base, stop_on_reply: 'no' }).success).toBe(false);
  });
  it('the card says what a reply does, and says nothing where nobody could reply', () => {
    const spec = workflowSpecSchema.parse(base);
    expect(specInWords(spec).onReply).toBe('If they email or text back, every step still to come stops');
    expect(specInWords({ ...spec, stop_on_reply: false }).onReply).toBe('It carries on even if they email or text back');
    const listing = workflowSpecSchema.parse({ ...base, trigger: { kind: 'listing.status_changed', to: 'sold' } });
    expect(specInWords(listing).onReply).toBeUndefined();
    const newCaller = workflowSpecSchema.parse({ ...base, trigger: { kind: 'call.missed', caller: 'new' } });
    expect(specInWords(newCaller).onReply).toBeUndefined();
  });
});

describe('lastRunWords (ADR 0105: what the AI Assistant reports)', () => {
  const r = (run: string, task: string | null, why: string | null = null, error: string | null = null) => lastRunWords({ run, task, why, error });
  it('says how the latest run went, with the reason it carries', () => {
    expect(r('started', 'active')).toBe('running now');
    expect(r('started', 'done')).toBe('finished every step');
    expect(r('started', 'cancelled', STOPPED_BY_REPLY)).toBe(`stopped: ${STOPPED_BY_REPLY}`);
    expect(r('started', 'failed', 'Step 2: no consent')).toBe('failed: Step 2: no consent');
    expect(r('skipped', null, null, 'Not run: “Workflow texts” is switched off in Skills.')).toBe('did not run: Not run: “Workflow texts” is switched off in Skills.');
    expect(r('failed', null)).toBe('failed');
  });
});
