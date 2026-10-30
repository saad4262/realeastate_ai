import { NextResponse, type NextRequest } from 'next/server';
import { runReminderTick, runZoomFailureAlerts, syncDepsFromEnv, teamMeetingDepsFromEnv } from '@repo/core/appointments';
import { noticeMailFromEnv } from '@repo/core/email';
import { runScheduledActions } from '@repo/core/assistant';
import { mailDepsFromEnv } from '@repo/core/mail';
import { deliverPlatformEmails } from '@repo/core/platform';
import { teamMessageDepsFromEnv } from '@repo/core/team-messages';
import { authoriseCronRequest } from '@repo/core/schedules';
import { templateSendDepsFromEnv } from '@repo/core/template-email';
import { runWorkflowTick } from '@repo/core/workflows';
import { runDealSync } from '@repo/core/deals';
import { phoneDepsFromEnv, refreshDueKyc, runDueAiCallbacks, voiceFromEnv } from '@repo/core/phone';
import { workflowDraftWriterFromEnv } from '@repo/ai/workflow-draft';
import { workflowDeciderFromEnv } from '@repo/ai/workflow-decide';
import { getWebDb } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The every-minute tick (ADR 0035, instant delivery): only the work whose
 * whole point is its TIME — an assistant action approved to run at 9:00, and
 * a meeting's reminder. On the 5-minute tick (/api/cron/alerts) they could be
 * up to five minutes late; here they are at most a minute late. Everything
 * else stays on the 5-minute tick.
 *
 * Same door as the other tick: `CRON_SECRET`, nothing read from the request.
 * Both jobs claim each row once (`FOR UPDATE SKIP LOCKED` / a guarded update),
 * so an overlapping run, a retry or a manual curl never sends twice. Never a
 * 5xx for one failure — a retry would re-run the whole tick.
 */
async function handler(request: NextRequest) {
  const auth = authoriseCronRequest(request.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    // Workflows first (ADR 0041): their runs' first steps are then due in the same tick, below.
    // "AI decides" (ADR 0067): its model is packages/ai's; without a key every decision is "Not sure".
    const workflows = await runWorkflowTick(getWebDb(), new Date(), 50, { decider: workflowDeciderFromEnv(getWebDb()) }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'workflow tick failed',
    }));

    const scheduled = await (async () => {
      const send = templateSendDepsFromEnv();
      return runScheduledActions(getWebDb(), {
        sync: syncDepsFromEnv(),
        templateSend: send.ok ? send.deps : null,
        mail: mailDepsFromEnv(),
        teamMessages: teamMessageDepsFromEnv(),
        teamMeetings: teamMeetingDepsFromEnv(),
        // A workflow's email draft (ADR 0041 D1) is written by packages/ai — never sent by the workflow.
        draftWriter: workflowDraftWriterFromEnv(getWebDb()),
      });
    })().catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'scheduled actions failed' }));

    const reminders = await runReminderTick(getWebDb(), { notice: noticeMailFromEnv(), mail: mailDepsFromEnv() }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'reminder tick failed',
    }));

    // A Zoom meeting that could not be created: its host and booker are told, once (a meeting without a link is time-critical too).
    const zoomAlerts = await runZoomFailureAlerts(getWebDb(), { notice: noticeMailFromEnv() }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'zoom alert tick failed',
    }));

    // The deal pipeline (ADR 0063): deals opened and moved from listings, offers and appraisals; condition reminders.
    const deals = await runDealSync(getWebDb()).catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'deal sync failed' }));

    // Email from the platform team (ADR 0052): what the console did not send straight away.
    const notice = noticeMailFromEnv();
    const platformEmails = await deliverPlatformEmails(getWebDb(), notice ? notice.mailer : null, { limit: 100 }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'platform email tick failed',
    }));

    // Phone & SMS (ADR 0070): agencies waiting on Twilio's business check, each asked at most hourly.
    const phoneKyc = await refreshDueKyc(getWebDb(), phoneDepsFromEnv()).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'phone check failed',
    }));

    // The AI call back (ADR 0072): calls that are due, inside calling hours, checked again before each.
    const aiCalls = await runDueAiCallbacks(getWebDb(), voiceFromEnv().voice).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'ai call tick failed',
    }));

    // Counts only — this is read from a cron log.
    return NextResponse.json({ ok: true, workflows, scheduled, reminders, zoomAlerts, deals, platformEmails, phoneKyc, aiCalls }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'tick failed' }, { status: 503 });
  }
}

export { handler as GET, handler as POST };
