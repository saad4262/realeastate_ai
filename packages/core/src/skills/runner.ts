import { and, asc, eq, isNull, lt, lte, sql } from 'drizzle-orm';
import { agentSkill, membership, skill, skillRun, user, type Db } from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { requireIntegrations } from '../integrations/accounts';
import { PROVIDERS } from '../integrations/providers';
import { checkAiBudget } from '../schedules/budget';
import { nextRunFor } from '../schedules/next-run';
import { buildSkillResultEmail, type EmailTransport, type SenderIdentity } from '../email';
import { checkCitedText, parseRankedLines } from './citations';
import {
  briefRecords,
  briefTemplate,
  gatherImportantEmails,
  gatherMorningBrief,
  templateRanking,
  type MorningBriefFacts,
  type SkillItem,
} from './facts';
import { parseSkillMarkdown, type SkillHandler, type SkillModelTier } from './skill-schema';
import { getMySkill, requiresOf, SkillError } from './skills';

/**
 * Running skills (docs/adr/0021). The search-alert scheduler's pattern:
 * claim due rows with FOR UPDATE SKIP LOCKED, the unique
 * (agent_skill_id, scheduled_for) slot as the real idempotency key, the next
 * slot anchored on the claimed one, three failures in a row and it stops
 * being claimed. Each run, in order: still a member → integrations →
 * budget → gather (as the agent) → model (optional) → citation check →
 * store → the agent's own email, if they asked. Network calls happen outside
 * every transaction.
 */

/** What packages/ai provides: one model call, metered there. Absent = templates only. */
export type SkillWriter = (input: {
  handler: SkillHandler;
  tier: SkillModelTier;
  /** The agent's own words, front-matter removed. */
  instructions: string;
  records: { ref: string; text: string }[];
  /** "Monday 6 October" in the agent's zone — in the user turn, never the system prompt (#5). */
  today: string;
  runId: string;
  userId: string;
}) => Promise<{ text: string | null; model: string | null }>;

export type SkillDeps = {
  write?: SkillWriter;
  mail?: { mailer: { sender: SenderIdentity; transport: EmailTransport }; urls: { agentUrl: string; agencyUrl: string } } | null;
  env?: NodeJS.ProcessEnv;
};

export const SKILL_CLAIM_LIMIT = 10;
export const SKILL_FAILURE_LIMIT = 3;

/** Claim what is due, move each cursor, open one run per slot. One short transaction. */
export async function claimDueSkills(db: Db, opts: { now?: Date; limit?: number; userId?: string } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: agentSkill.id,
        agencyId: agentSkill.agencyId,
        userId: agentSkill.userId,
        cadence: agentSkill.cadence,
        sendAtMinute: agentSkill.sendAtMinute,
        sendOnWeekday: agentSkill.sendOnWeekday,
        intervalMinutes: agentSkill.intervalMinutes,
        timezone: agentSkill.timezone,
        nextRunAt: agentSkill.nextRunAt,
      })
      .from(agentSkill)
      .where(
        and(
          // Disabled skills are never claimed — whatever their cursor says.
          eq(agentSkill.enabled, true),
          isNull(agentSkill.archivedAt),
          lte(agentSkill.nextRunAt, now),
          lt(agentSkill.consecutiveFailures, SKILL_FAILURE_LIMIT),
          ...(opts.userId ? [eq(agentSkill.userId, opts.userId)] : []),
        ),
      )
      .orderBy(asc(agentSkill.nextRunAt), asc(agentSkill.id))
      .limit(opts.limit ?? SKILL_CLAIM_LIMIT)
      .for('update', { of: agentSkill, skipLocked: true });

    const runIds: string[] = [];
    for (const row of due) {
      const slot = row.nextRunAt!;
      const next = nextRunFor({
        cadence: row.cadence,
        sendAtMinute: row.sendAtMinute,
        timezone: row.timezone,
        sendOnWeekday: row.sendOnWeekday ?? undefined,
        intervalMinutes: row.intervalMinutes ?? undefined,
        // Anchored on the slot, never on now: 7 AM stays 7 AM after an outage.
        after: slot,
      });
      await tx.update(agentSkill).set({ nextRunAt: next, updatedAt: sql`now()` }).where(eq(agentSkill.id, row.id));
      const [run] = await tx
        .insert(skillRun)
        .values({ agentSkillId: row.id, agencyId: row.agencyId, userId: row.userId, trigger: 'schedule', scheduledFor: slot })
        .onConflictDoNothing()
        .returning({ id: skillRun.id });
      if (run) runIds.push(run.id);
    }
    return runIds;
  });
}

async function memberActor(db: Db, userId: string, agencyId: string): Promise<Actor | null> {
  const [m] = await db
    .select({ role: membership.role, status: membership.status })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.agencyId, agencyId)))
    .limit(1);
  if (!m || m.status !== 'active') return null;
  return { userId, agencyId, membershipRole: m.role as MembershipRole };
}

function todayLabel(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(now);
}

export type BriefResult = { kind: 'morning_brief'; sections: MorningBriefFacts; cited: string[] };
export type EmailsResult = {
  kind: 'important_emails';
  items: (SkillItem & { reason: string | null })[];
  dropped: number;
};
export type SkillResult = BriefResult | EmailsResult;

type Finish = {
  status: 'succeeded' | 'failed' | 'skipped';
  summary?: string | null;
  summarySource?: 'model' | 'template' | 'none';
  result?: SkillResult | null;
  error?: string | null;
  items?: number;
  model?: string | null;
};

async function finish(db: Db, runId: string, agentSkillId: string, f: Finish): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(skillRun)
      .set({
        status: f.status,
        summary: f.summary ?? null,
        summarySource: f.summarySource ?? 'none',
        result: f.result ?? null,
        error: f.error ?? null,
        itemsProcessed: f.items ?? 0,
        model: f.model ?? null,
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`now()`,
      })
      .where(eq(skillRun.id, runId));
    await tx
      .update(agentSkill)
      .set({
        lastRunAt: sql`now()`,
        consecutiveFailures:
          f.status === 'failed' ? sql`${agentSkill.consecutiveFailures} + 1` : f.status === 'succeeded' ? 0 : agentSkill.consecutiveFailures,
        updatedAt: sql`now()`,
      })
      .where(eq(agentSkill.id, agentSkillId));
  });
}

export type RunOutcome = { runId: string; status: 'succeeded' | 'failed' | 'skipped'; reason?: string };

/** Run one claimed (or manually opened) run to the end. Never throws for a run's own failure. */
export async function executeSkillRun(db: Db, deps: SkillDeps, runId: string, now = new Date()): Promise<RunOutcome> {
  const [row] = await db
    .select({
      runId: skillRun.id,
      status: skillRun.status,
      agentSkillId: agentSkill.id,
      agencyId: agentSkill.agencyId,
      userId: agentSkill.userId,
      bodyMd: agentSkill.bodyMd,
      timezone: agentSkill.timezone,
      emailMe: agentSkill.emailMe,
      handler: skill.handler,
      modelTier: skill.modelTier,
      libraryRequires: skill.requires,
      skillName: skill.name,
      agentEmail: user.email,
      agentName: user.name,
    })
    .from(skillRun)
    .innerJoin(agentSkill, eq(agentSkill.id, skillRun.agentSkillId))
    .innerJoin(skill, eq(skill.id, agentSkill.skillId))
    .innerJoin(user, eq(user.id, agentSkill.userId))
    .where(eq(skillRun.id, runId))
    .limit(1);
  if (!row || row.status !== 'running') return { runId, status: 'skipped', reason: 'not running' };

  const skip = async (reason: string): Promise<RunOutcome> => {
    await finish(db, runId, row.agentSkillId, { status: 'skipped', error: reason });
    return { runId, status: 'skipped', reason };
  };

  try {
    const actor = await memberActor(db, row.userId, row.agencyId);
    if (!actor) return await skip('No longer an active member of the agency');

    const requires = requiresOf(row.libraryRequires, row.bodyMd);
    if (requires.length) {
      const check = await requireIntegrations(db, actor, requires);
      if (!check.ok) return await skip(`Connect ${check.missing.map((p) => PROVIDERS[p].label).join(' and ')} first`);
    }

    // Before any model is called — over the cap, nothing is spent.
    const budget = await checkAiBudget(db, { userId: row.userId, now, ...(deps.env ? { env: deps.env } : {}) });
    if (!budget.allowed) {
      return await skip(budget.reason === 'user_cap' ? 'Your daily AI budget is used up' : 'The daily AI budget is used up');
    }

    const parsed = parseSkillMarkdown(row.bodyMd);
    const handler = row.handler as SkillHandler;
    const tier = (parsed.model ?? row.modelTier) as SkillModelTier;
    const today = todayLabel(now, row.timezone);
    let outcome: Finish;

    if (handler === 'morning_brief') {
      const facts = await gatherMorningBrief(db, actor, row.timezone, now);
      const records = briefRecords(facts);
      let summary = briefTemplate(facts);
      let source: 'model' | 'template' = 'template';
      let model: string | null = null;
      let cited: string[] = [];
      // Nothing to say costs nothing: no model call on an empty day.
      if (records.length && deps.write) {
        const out = await deps.write({ handler, tier, instructions: parsed.instructions, records, today, runId, userId: row.userId });
        model = out.model;
        if (out.text) {
          const verdict = checkCitedText(out.text, records);
          if (verdict.ok) {
            summary = out.text.trim();
            source = 'model';
            cited = verdict.cited;
          }
        }
      }
      outcome = { status: 'succeeded', summary, summarySource: source, result: { kind: 'morning_brief', sections: facts, cited }, items: records.length, model };
    } else {
      const items = await gatherImportantEmails(db, actor);
      let ranked = templateRanking(items);
      let source: 'model' | 'template' = 'template';
      let model: string | null = null;
      let dropped = 0;
      if (items.length && deps.write) {
        const out = await deps.write({ handler, tier, instructions: parsed.instructions, records: items, today, runId, userId: row.userId });
        model = out.model;
        if (out.text) {
          const parsedLines = parseRankedLines(out.text, items);
          dropped = parsedLines.dropped;
          if (parsedLines.items.length) {
            ranked = parsedLines.items;
            source = 'model';
          }
        }
      }
      const byRef = new Map(items.map((i) => [i.ref, i]));
      const result: EmailsResult = {
        kind: 'important_emails',
        items: ranked.map((r) => ({ ...byRef.get(r.ref)!, reason: r.reason })),
        dropped,
      };
      outcome = {
        status: 'succeeded',
        summary: items.length ? null : 'Nothing is waiting for an answer.',
        summarySource: source,
        result,
        items: items.length,
        model,
      };
    }

    await finish(db, runId, row.agentSkillId, outcome);

    // The agent's own copy by email — after the write, never inside it.
    if (row.emailMe && deps.mail && outcome.result) {
      try {
        const host = can(actor, 'console:agency', { type: 'console' }) ? `${deps.mail.urls.agencyUrl}/skills` : `${deps.mail.urls.agentUrl}/my-skills`;
        const message = buildSkillResultEmail({
          to: { email: row.agentEmail, ...(row.agentName ? { name: row.agentName } : {}) },
          from: deps.mail.mailer.sender.from,
          postalAddress: deps.mail.mailer.sender.postalAddress,
          skillName: row.skillName,
          today,
          summary: outcome.summary ?? null,
          summaryByAssistant: outcome.summarySource === 'model',
          lines: emailLines(outcome.result, row.timezone),
          resultUrl: `${host}/${row.agentSkillId}/runs/${runId}`,
        });
        const sent = await deps.mail.mailer.transport.send(message);
        if (sent.ok) await db.update(skillRun).set({ emailedAt: sql`now()` }).where(eq(skillRun.id, runId));
      } catch (err) {
        console.error(`[skills] result email for run ${runId} failed`, err instanceof Error ? err.message : 'unknown');
      }
    }
    return { runId, status: 'succeeded' };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'Unknown error';
    await finish(db, runId, row.agentSkillId, { status: 'failed', error: message });
    return { runId, status: 'failed', reason: message };
  }
}

function emailLines(result: SkillResult, timeZone: string): string[] {
  const time = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
  if (result.kind === 'morning_brief') {
    const s = result.sections;
    return [
      ...s.appointments.map((a) => `${time(a.at)} — ${a.title} (${a.detail})`),
      ...s.nextActions.map((c) => `Overdue: ${c.title} — ${c.detail ?? ''}`),
      ...s.emails.map((e) => `Waiting: ${e.title} — ${e.detail ?? ''}`),
      ...s.leads.map((l) => `New lead: ${l.title} — ${l.detail ?? ''}`),
    ];
  }
  return result.items.map((i, n) => `${n + 1}. ${i.title} — ${i.detail ?? ''}${i.reason ? ` · ${i.reason}` : ''}`);
}

export type SkillTickReport = { claimed: number; succeeded: number; failed: number; skipped: number };

/** One tick: claim what is due and run it, one after another. */
export async function runSkillTick(db: Db, deps: SkillDeps, now = new Date()): Promise<SkillTickReport> {
  const runIds = await claimDueSkills(db, { now });
  const report: SkillTickReport = { claimed: runIds.length, succeeded: 0, failed: 0, skipped: 0 };
  for (const id of runIds) {
    const o = await executeSkillRun(db, deps, id, now);
    report[o.status] += 1;
  }
  return report;
}

/**
 * "Run now" — the agent's own, switched on, every requirement connected.
 * Opens a manual run and runs it to the end; the caller shows the result.
 */
export async function runSkillNow(db: Db, deps: SkillDeps, actor: Actor, agentSkillId: string, now = new Date()): Promise<RunOutcome> {
  const s = await getMySkill(db, actor, agentSkillId);
  if (!can(actor, 'agent_skill:manage', { type: 'agent_skill', id: s.id, agencyId: s.agencyId, ownerId: s.userId })) {
    throw new SkillError('forbidden', 'You can view this skill but not run it');
  }
  if (!s.enabled) throw new SkillError('conflict', 'Switch the skill on to run it');
  if (s.requires.length) {
    const check = await requireIntegrations(db, actor, s.requires);
    if (!check.ok) {
      throw new SkillError('missing_integrations', `Connect ${check.missing.map((p) => PROVIDERS[p].label).join(' and ')} first`, check.missing);
    }
  }
  const [run] = await db
    .insert(skillRun)
    .values({ agentSkillId: s.id, agencyId: s.agencyId, userId: s.userId, trigger: 'manual', scheduledFor: sql`clock_timestamp()` })
    .returning({ id: skillRun.id });
  return executeSkillRun(db, deps, run!.id, now);
}
