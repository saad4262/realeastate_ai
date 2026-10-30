import { NextResponse, type NextRequest } from 'next/server';
import { syncDepsFromEnv, teamMeetingDepsFromEnv } from '@repo/core/appointments';
import { minuteJobs, runTick } from '@repo/core/cron';
import { noticeMailFromEnv } from '@repo/core/email';
import { mailDepsFromEnv } from '@repo/core/mail';
import { phoneDepsFromEnv, voiceFromEnv } from '@repo/core/phone';
import { teamMessageDepsFromEnv } from '@repo/core/team-messages';
import { authoriseCronRequest } from '@repo/core/schedules';
import { templateSendDepsFromEnv } from '@repo/core/template-email';
import { workflowDraftWriterFromEnv } from '@repo/ai/workflow-draft';
import { workflowDeciderFromEnv } from '@repo/ai/workflow-decide';
import { getWebDb } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The runner stops STARTING rounds here; the rest of maxDuration is headroom for the last one. */
const BUDGET_MS = 45_000;

/**
 * The every-minute tick (ADR 0035, batched by ADR 0073): the work whose point is its TIME — an
 * approved action due at 9:00, a meeting's reminder, an AI call back — plus what runs beside it.
 *
 * Which jobs, in what order, how big a batch and which repeat are packages/core's (`minuteJobs`);
 * `runTick` gives every job one round, then drains the full queues until the budget is spent, so one
 * busy job never starves the rest and the tick never runs past its time. This route only builds the
 * dependencies from env.
 *
 * Same door as the other tick: `CRON_SECRET`, nothing read from the request. Every job claims each
 * row once (`FOR UPDATE SKIP LOCKED` / a guarded update), so an overlapping run, a retry or a manual
 * curl never does a row twice. Never a 5xx for one job's failure — a retry would re-run the tick.
 */
async function handler(request: NextRequest) {
  const auth = authoriseCronRequest(request.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const db = getWebDb();
    const send = templateSendDepsFromEnv();
    const notice = noticeMailFromEnv();
    const jobs = minuteJobs(db, {
      // "AI decides" (ADR 0067): packages/ai's model; without a key every decision is "Not sure".
      decider: workflowDeciderFromEnv(db),
      scheduled: {
        sync: syncDepsFromEnv(),
        templateSend: send.ok ? send.deps : null,
        mail: mailDepsFromEnv(),
        teamMessages: teamMessageDepsFromEnv(),
        teamMeetings: teamMeetingDepsFromEnv(),
        // A workflow's email draft (ADR 0041 D1) is written by packages/ai — never sent by the workflow.
        draftWriter: workflowDraftWriterFromEnv(db),
      },
      reminders: { notice, mail: mailDepsFromEnv() },
      zoomAlerts: { notice },
      platformMail: notice ? notice.mailer : null,
      phone: phoneDepsFromEnv(),
      voice: voiceFromEnv().voice,
    });
    const report = await runTick(jobs, { budgetMs: BUDGET_MS });
    // Counts and timings only — this is read from a cron log.
    return NextResponse.json({ ok: true, ...report }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'tick failed' }, { status: 503 });
  }
}

export { handler as GET, handler as POST };
