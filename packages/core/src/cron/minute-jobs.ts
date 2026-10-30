import type { Db } from '@repo/db';
import { REMINDER_BATCH, runReminderTick, runZoomFailureAlerts, type ReminderDeps } from '../appointments';
import { runScheduledActions } from '../assistant/actions';
import { runDealSync } from '../deals';
import { refreshDueKyc, runDueAiCallbacks, type PhoneDeps, type VoiceAi } from '../phone';
import { deliverPlatformEmails, type PlatformMailDeps } from '../platform';
import { runWorkflowTick, type WorkflowTickDeps } from '../workflows';
import type { TickJob } from './tick';

/**
 * The every-minute tick's jobs (ADR 0035, batched by ADR 0073), in the order time matters most. Each
 * is one batch of a function that claims its rows itself; the runner repeats the "drain" ones while
 * their batch comes back full. The route only builds the dependencies from env and calls `runTick`.
 */

export const MINUTE_BATCH = {
  workflowEvents: 50,
  scheduledActions: 10,
  platformEmails: 100,
  aiCalls: 10,
  kycAccounts: 5,
} as const;

export type MinuteDeps = {
  /** A workflow's "AI decides" (packages/ai); null: every decision is "Not sure". */
  decider: WorkflowTickDeps['decider'];
  scheduled: Parameters<typeof runScheduledActions>[1];
  reminders: ReminderDeps;
  zoomAlerts: Pick<ReminderDeps, 'notice'>;
  platformMail: PlatformMailDeps | null;
  phone: PhoneDeps;
  voice: VoiceAi | null;
};

export function minuteJobs(db: Db, deps: MinuteDeps, now: () => Date = () => new Date()): TickJob[] {
  return [
    {
      // First: a run's first step is then due in this same tick, below.
      name: 'workflows',
      mode: 'drain',
      run: async (round) => {
        // The no-reply and trigger scans read every agency: once a tick, not once a round.
        const r = await runWorkflowTick(db, now(), MINUTE_BATCH.workflowEvents, { decider: deps.decider, scans: round === 0 });
        return { result: r, more: r.events >= MINUTE_BATCH.workflowEvents };
      },
    },
    {
      // Approved actions due at their minute (sends, invitations, workflow steps).
      name: 'scheduled',
      mode: 'drain',
      concurrency: 2,
      run: async () => {
        const r = await runScheduledActions(db, deps.scheduled, now(), MINUTE_BATCH.scheduledActions);
        return { result: r, more: r.ran >= MINUTE_BATCH.scheduledActions };
      },
    },
    {
      name: 'reminders',
      mode: 'drain',
      run: async () => {
        const r = await runReminderTick(db, deps.reminders);
        return { result: r, more: r.claimed >= REMINDER_BATCH };
      },
    },
    {
      // ADR 0072: AI call-backs that are due, each checked again before it is placed.
      name: 'aiCalls',
      mode: 'drain',
      run: async () => {
        const r = await runDueAiCallbacks(db, deps.voice, now(), MINUTE_BATCH.aiCalls);
        return { result: r, more: r.placed + r.skipped + r.failed >= MINUTE_BATCH.aiCalls };
      },
    },
    {
      name: 'platformEmails',
      mode: 'drain',
      run: async () => {
        const r = await deliverPlatformEmails(db, deps.platformMail, { limit: MINUTE_BATCH.platformEmails });
        return { result: r, more: r.sent + r.failed >= MINUTE_BATCH.platformEmails };
      },
    },
    {
      name: 'zoomAlerts',
      mode: 'once',
      run: async () => ({ result: await runZoomFailureAlerts(db, deps.zoomAlerts), more: false }),
    },
    {
      // Set-based across every agency in a few statements: once a tick is enough.
      name: 'deals',
      mode: 'once',
      run: async () => ({ result: await runDealSync(db), more: false }),
    },
    {
      // Each account is asked at most hourly anyway; every five minutes keeps the tick light.
      name: 'phoneKyc',
      mode: 'once',
      everyMinutes: 5,
      run: async () => ({ result: await refreshDueKyc(db, deps.phone, now(), MINUTE_BATCH.kycAccounts), more: false }),
    },
  ];
}
