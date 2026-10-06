import { after, NextResponse, type NextRequest } from 'next/server';
import { runAppointmentSyncTick, syncDepsFromEnv } from '@repo/core/appointments';
import { expireProposedActions, purgeAssistantConversations } from '@repo/core/assistant';
import { pullReceivedMail } from '@repo/core/mail';
import { authoriseCronRequest, runScheduleTick } from '@repo/core/schedules';
import { runSkillTick } from '@repo/core/skills';
import {
  expirePreparedBatches,
  recoverStuckRecipients,
  resumeSendingBatches,
  templateSendDepsFromEnv,
} from '@repo/core/template-email';
import { getWebDb } from '../../../../lib/db';
import { schedulerDeps, skillDeps } from '../../../../lib/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 60, not 300.
 *
 * 300 needs a paid plan and the tick does not need it: anything not claimed
 * this minute is claimed by the next one, because `next_run_at <= now()`
 * does not expire. A timeout here costs latency, never correctness — which
 * is a better property to have than a longer budget.
 */
export const maxDuration = 60;

/**
 * Run every schedule that is due.
 *
 * ## It accepts nothing
 *
 * No body is read, no query parameter is parsed, no id selects a row. § 9 —
 * a machine caller's authorisation is what the server decides rather than
 * what it accepts. The endpoint looks up what is due itself; the batch size
 * is a constant in packages/core and dry mode is `ALERTS_DRY_RUN` on the
 * deployment, not a parameter somebody can flip from outside.
 *
 * ## Both methods
 *
 * Vercel Cron issues GET with `Authorization: Bearer $CRON_SECRET` and
 * cannot be told to send anything else. POST is for a manual curl or any
 * other pinger. The method is the platform's choice; the secret is what
 * authorises, and there is no method that reaches the work without one.
 *
 * ## It does not 5xx because a schedule failed
 *
 * A 500 makes the platform retry the whole tick, straight back into
 * whatever failed — with a metered model and a mail provider behind it.
 * Individual failures are counted in the response and recorded on the run
 * row; only an unauthorised call or an unreachable database is an error
 * status.
 */
async function handler(request: NextRequest) {
  const auth = authoriseCronRequest(request.headers);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const report = await runScheduleTick(getWebDb(), schedulerDeps());

    /**
     * The same tick pulls received mail (ADR 0016), so buyers' replies reach
     * the inbox even when nobody has it open and no webhook is configured. It
     * cannot fail the tick: `pullReceivedMail` never throws, and its sends run
     * after the response.
     */
    const mail = await pullReceivedMail({ db: getWebDb });
    if (mail.followUp) after(mail.followUp);

    /**
     * Agents' skills (docs/adr/0021), in the same tick. A skill that fails is
     * recorded on its own run; nothing here can fail the alerts above.
     */
    const skills = await runSkillTick(getWebDb(), skillDeps()).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'skills tick failed',
    }));

    /**
     * Template email housekeeping (ADR 0022): prepared batches past 48 h
     * expire; recipients stuck mid-send are settled from their message's own
     * status; an approved batch left with people queued carries on. It never
     * prepares or approves anything — that is always a person.
     */
    const templateEmail = await (async () => {
      const expired = await expirePreparedBatches(getWebDb());
      const recovered = await recoverStuckRecipients(getWebDb());
      const sendDeps = templateSendDepsFromEnv();
      const resumed = sendDeps.ok ? await resumeSendingBatches(getWebDb(), sendDeps.deps) : null;
      return { expired, recovered, resumed };
    })().catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'template email tick failed' }));

    /**
     * Google Calendar / Zoom (Phase 3b): finish syncs a crash left pending,
     * and read back the events we created — a change made inside Google is
     * flagged on the appointment, never copied over it. Polling, because a
     * Google push channel needs a public https domain we do not have yet.
     */
    const appointmentSync = await runAppointmentSyncTick(getWebDb(), syncDepsFromEnv()).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : 'appointment sync tick failed',
    }));

    /**
     * Console assistant conversations are kept 30 days after their last turn,
     * then deleted with their turns (ADR 0025, decided Q5). Cost rows stay.
     */
    // …and a card nobody approved within 48 h expires; its row stays as the record.
    const assistant = await Promise.all([purgeAssistantConversations(getWebDb()), expireProposedActions(getWebDb())])
      .then(([purged, expired]) => ({ purged, expired }))
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'assistant purge failed' }));

    // No ids, no addresses, no listing text — this is read from a cron log.
    return NextResponse.json(
      { ok: true, ...report, mail: mail.ok ? { stored: mail.stored } : { skipped: mail.reason }, skills, templateEmail, appointmentSync, assistant },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    // Configuration and connectivity, i.e. the tick could not start at all.
    const message = err instanceof Error ? err.message : 'Scheduler failed';
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}

export { handler as GET, handler as POST };
