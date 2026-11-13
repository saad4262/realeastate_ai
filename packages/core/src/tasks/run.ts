import { eq, sql } from 'drizzle-orm';
import { scheduleRun, searchSchedule, type Db } from '@repo/db';
import { escapeHtml, requireSenderFooter, type EmailTransport, type MarketingMessage, type SenderIdentity } from '../email';
import { unsubscribeUrl } from '../email/unsubscribe';
import { claimDueSchedules, DEFAULT_CLAIM_LIMIT, type ClaimedSchedule } from '../schedules/claim';
import { toRuntimeQuery, type ScheduleDeps } from '../schedules/run-schedule';
import { checkAiBudget } from '../ai-budget';
import { pausedConsumerSkills } from '../consumer-skills/catalog';
import { passesVerdictRule } from '../research/assist';
import { buildTaskReport, type TaskReport } from './report';
import { readSections, TASK_SECTION_TEXT, taskSummaryPasses, taskTemplateSummary } from './sections';

/**
 * The Tasks runner (ADR 0080, C8 decisions 5–7): the alerts' claim with `kind = 'task'` (only for buyers who switched
 * Tasks on), a report from SQL, a short paragraph that is handed no figures, and an email — skipped when nothing is new
 * and the buyer asked for that. The same order rule as an alert: every network call before the one short write.
 */

/** What the paragraph's writer is handed: which sections have something — never a figure (non-negotiable 7's scope). */
export type TaskSummaryFacts = { taskName: string; suburb: string | null; sections: { title: string; hasSomething: boolean }[] };
export type TaskSummaryOut = { source: 'model'; text: string } | { source: 'template'; text: null };

export type TaskDeps = Omit<ScheduleDeps, 'summarise'> & {
  summariseTask?: (facts: TaskSummaryFacts, ctx: { runId: string; userId: string }) => Promise<TaskSummaryOut>;
};

export type TaskTickReport = { claimed: number; delivered: number; empty: number; failed: number; emailsSent: number; emailsSkipped: number; skipped?: string };

const LABEL = 'Written by the property guide';

export function buildTaskEmail(input: { to: string; sender: SenderIdentity; baseUrl: string; taskId: string; name: string; summary: string; summaryIsModel: boolean; report: TaskReport; unsubscribeUrl: string }): MarketingMessage {
  requireSenderFooter(input.sender.from, input.sender.postalAddress, 'Tasks');
  const base = input.baseUrl.replace(/\/$/, '');
  const font = "font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;";
  const subject = `Your report: ${input.name}`;
  const link = (href?: string) => (href ? `${base}${href}` : null);
  const html = `<div style="max-width:600px;margin:0 auto;">
  <h1 style="${font}font-size:20px;font-weight:700;margin:0 0 12px;">${escapeHtml(subject)}</h1>
  ${input.summaryIsModel ? `<p style="${font}font-size:11px;color:#1d4e89;margin:0 0 4px;">${LABEL}</p>` : ''}
  <p style="${font}margin:0 0 16px;">${escapeHtml(input.summary)}</p>
  ${input.report.sections
    .map(
      (s) => `<h2 style="${font}font-size:15px;font-weight:700;margin:16px 0 4px;">${escapeHtml(s.title)}</h2>
  ${s.rows.length ? s.rows.map((r) => `<p style="${font}margin:2px 0;">${link(r.href) ? `<a href="${escapeHtml(link(r.href)!)}" style="color:#0b3d2e;">${escapeHtml(r.text)}</a>` : escapeHtml(r.text)}${r.detail ? ` — ${escapeHtml(r.detail)}` : ''}</p>`).join('\n  ') : `<p style="${font}margin:2px 0;color:#5c5c5c;">${escapeHtml(s.note ?? 'Nothing this time.')}</p>`}`,
    )
    .join('\n  ')}
  <p style="${font}font-size:12px;color:#8c8577;margin:24px 0 0;">Every figure is from this site's records. <a href="${escapeHtml(`${base}/account/tasks/${input.taskId}`)}">This task</a> · <a href="${escapeHtml(input.unsubscribeUrl)}">Stop this task</a><br>${escapeHtml(input.sender.from.name)} · ${escapeHtml(input.sender.postalAddress)}</p>
</div>`;
  const text = [
    subject,
    '',
    ...(input.summaryIsModel ? [LABEL] : []),
    input.summary,
    '',
    ...input.report.sections.flatMap((s) => [s.title, ...(s.rows.length ? s.rows.map((r) => `  ${r.text}${r.detail ? ` — ${r.detail}` : ''}`) : [`  ${s.note ?? 'Nothing this time.'}`]), '']),
    `This task: ${base}/account/tasks/${input.taskId}`,
    `Stop this task: ${input.unsubscribeUrl}`,
    `${input.sender.from.name} · ${input.sender.postalAddress}`,
  ].join('\n');
  return { kind: 'marketing', to: { email: input.to }, from: input.sender.from, subject, html, text, listUnsubscribeUrl: input.unsubscribeUrl, tags: { feature: 'tasks' } };
}

export async function runOneTask(db: Db, deps: TaskDeps, claimed: ClaimedSchedule): Promise<'delivered' | 'empty' | 'failed'> {
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  try {
    const sections = readSections(claimed.sections);
    const runtimeQuery = await toRuntimeQuery(claimed.query, deps.resolvePlace);
    const report = await buildTaskReport(db, { search: deps.search }, {
      userId: claimed.userId,
      query: claimed.query,
      runtimeQuery,
      sections,
      since: claimed.previousRunAt,
      previousListingIds: claimed.previousListingIds,
      now,
      timeZone: claimed.timezone,
    });

    let summary: TaskSummaryOut = { source: 'template', text: null };
    if (deps.summariseTask && report.hasNews) {
      const budget = await checkAiBudget(db, { userId: claimed.userId, now, env });
      if (budget.allowed) {
        const out = await deps.summariseTask(
          { taskName: claimed.name, suburb: claimed.query.suburb ?? null, sections: report.sections.map((s, i) => ({ title: TASK_SECTION_TEXT[sections[i]!].title, hasSomething: s.rows.length > 0 })) },
          { runId: claimed.runId, userId: claimed.userId },
        ).catch(() => ({ source: 'template' as const, text: null }));
        // The Smart Alerts rule and C5's verdict rule, in core: a figure, a counting word or a verdict and it is the template.
        if (out.source === 'model' && out.text && taskSummaryPasses(out.text, passesVerdictRule)) summary = out;
      }
    }
    const summaryText = summary.source === 'model' ? summary.text : taskTemplateSummary(claimed.name, report.hasNews);

    let emailStatus: 'sent' | 'failed' | 'skipped' = 'skipped';
    let emailError: string | null = null;
    if (report.hasNews || !claimed.skipEmpty) {
      const sent = await deps.transport.send({
        ...buildTaskEmail({
          to: claimed.email,
          sender: deps.sender,
          baseUrl: deps.baseUrl,
          taskId: claimed.scheduleId,
          name: claimed.name,
          summary: summaryText,
          summaryIsModel: summary.source === 'model',
          report,
          unsubscribeUrl: unsubscribeUrl(deps.baseUrl, claimed.scheduleId, claimed.userId, deps.unsubscribeSecret),
        }),
        idempotencyKey: `task:${claimed.runId}`,
      });
      emailStatus = sent.ok ? 'sent' : 'failed';
      emailError = sent.ok ? null : sent.error;
    }

    const status = report.hasNews ? 'delivered' : 'empty';
    await db.transaction(async (tx) => {
      await tx
        .update(scheduleRun)
        .set({
          status,
          newCount: report.sections.reduce((n, s) => n + s.rows.length, 0),
          // The new-homes diff, as an alert's: the next run reports only homes not in this list.
          listingIds: report.newListingIds,
          report,
          summary: summaryText,
          summarySource: summary.source,
          emailStatus,
          emailedAt: emailStatus === 'sent' ? now : null,
          emailError,
          finishedAt: now,
          updatedAt: sql`now()`,
        })
        .where(eq(scheduleRun.id, claimed.runId));
      await tx.update(searchSchedule).set({ consecutiveFailures: 0, updatedAt: sql`now()` }).where(eq(searchSchedule.id, claimed.scheduleId));
    });
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Run failed';
    await db.transaction(async (tx) => {
      await tx.update(scheduleRun).set({ status: 'failed', error: message.slice(0, 500), finishedAt: now, updatedAt: sql`now()` }).where(eq(scheduleRun.id, claimed.runId));
      const failures = claimed.consecutiveFailures + 1;
      await tx
        .update(searchSchedule)
        .set({ consecutiveFailures: failures, ...(failures >= 3 ? { status: 'failing' as const } : {}), updatedAt: sql`now()` })
        .where(eq(searchSchedule.id, claimed.scheduleId));
    });
    return 'failed';
  }
}

export async function runTaskTick(db: Db, deps: TaskDeps, opts: { limit?: number; ownerId?: string } = {}): Promise<TaskTickReport> {
  const report: TaskTickReport = { claimed: 0, delivered: 0, empty: 0, failed: 0, emailsSent: 0, emailsSkipped: 0 };
  // Paused for everyone: claim nothing, so every task stays due and runs on the first tick after (the alerts' rule).
  if (pausedConsumerSkills(deps.env ?? process.env).has('tasks')) return { ...report, skipped: 'paused' };
  const claimed = await claimDueSchedules(db, { now: deps.now?.() ?? new Date(), limit: opts.limit ?? DEFAULT_CLAIM_LIMIT, kind: 'task', ...(opts.ownerId ? { ownerId: opts.ownerId } : {}) });
  report.claimed = claimed.length;
  for (const c of claimed) {
    const outcome = await runOneTask(db, deps, c);
    report[outcome] += 1;
  }
  return report;
}
