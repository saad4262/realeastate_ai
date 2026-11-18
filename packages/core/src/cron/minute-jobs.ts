import type { Db } from '@repo/db';
import { REMINDER_BATCH, runReminderTick, runZoomFailureAlerts, type ReminderDeps } from '../appointments';
import { runScheduledActions } from '../assistant/actions';
import { runDealSync } from '../deals';
import { refreshDueKyc, runDueAiCallbacks, type PhoneDeps, type VoiceAi } from '../phone';
import { resumeSmsBatches } from '../template-email/sms-batches';
import { deliverPlatformEmails, type PlatformMailDeps } from '../platform';
import { runWorkflowTick, type WorkflowTickDeps } from '../workflows';
import { runAutomationTick, type RunnerDeps } from '../recurring';
import { runLeadUnderstanding, type LeadUnderstander } from '../leads/understand';
import type { TickJob } from './tick';
import { runJobs } from '../jobs';
import { enqueueStuckSms, smsReconcileHandler } from '../phone/reconcile';
import { detectSendSpikes } from '../safety/spikes';
import { settleCredits } from '../billing/credits';
import { stripeEventHandler } from '../billing/service';
import type { StripeApi } from '../billing/stripe';

/**
 * The every-minute tick's jobs (ADR 0035, batched by ADR 0073), in the order time matters most. Each
 * is one batch of a function that claims its rows itself; the runner repeats the "drain" ones while
 * their batch comes back full. The route only builds the dependencies from env and calls `runTick`.
 */

export const MINUTE_BATCH = {
  understandLeads: 10,
  workflowEvents: 50,
  scheduledActions: 10,
  platformEmails: 100,
  aiCalls: 10,
  kycAccounts: 5,
  smsBatches: 5,
  automationSlices: 3,
  urgentJobs: 20,
} as const;

export type MinuteDeps = {
  /** A workflow's "AI decides" (packages/ai); null: every decision is "Not sure". */
  decider: WorkflowTickDeps['decider'];
  /** "AI understands" (ADR 0078, packages/ai); null: new leads are marked "off". */
  understander: LeadUnderstander | null;
  scheduled: Parameters<typeof runScheduledActions>[1];
  /** Repeating automations (ADR 0089). */
  automations: RunnerDeps;
  reminders: ReminderDeps;
  zoomAlerts: Pick<ReminderDeps, 'notice'>;
  platformMail: PlatformMailDeps | null;
  phone: PhoneDeps;
  voice: VoiceAi | null;
  /** ADR 0092: Stripe for the `stripe.event` jobs; null when billing is not set up. */
  stripe?: StripeApi | null;
};

export function minuteJobs(db: Db, deps: MinuteDeps, now: () => Date = () => new Date()): TickJob[] {
  return [
    {
      // ADR 0078, before the workflows: a workflow with an AI condition then finds the lead understood this tick.
      name: 'understandLeads',
      mode: 'drain',
      run: async () => {
        const r = await runLeadUnderstanding(db, deps.understander, now(), MINUTE_BATCH.understandLeads);
        return { result: r, more: r.claimed >= MINUTE_BATCH.understandLeads };
      },
    },
    {
      // A run's first step is then due in this same tick, below.
      name: 'workflows',
      mode: 'drain',
      run: async (round) => {
        // The no-reply and trigger scans read every agency: once a tick, not once a round.
        const r = await runWorkflowTick(db, now(), MINUTE_BATCH.workflowEvents, { decider: deps.decider, scans: round === 0 });
        return { result: r, more: r.events >= MINUTE_BATCH.workflowEvents };
      },
    },
    {
      // Repeating automations (ADR 0089): what is due, then what is running, a few slices a tick.
      name: 'automations',
      mode: 'once',
      run: async () => ({ result: await runAutomationTick(db, deps.automations, now(), MINUTE_BATCH.automationSlices), more: false }),
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
      // ADR 0074 part 2: approved texts held for the sending hours (9 am) or left by a crash, carried on.
      name: 'smsBatches',
      mode: 'once',
      run: async () => ({ result: await resumeSmsBatches(db, { phone: deps.phone }, MINUTE_BATCH.smsBatches, now), more: false }),
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
    {
      // PLATFORM-PLAN 3.9: a text whose answer from Twilio was lost gets a check job, once.
      name: 'stuckSms',
      mode: 'once',
      everyMinutes: 5,
      run: async () => ({ result: await enqueueStuckSms(db, now()), more: false }),
    },
    {
      // ADR 0092: take the real cost of finished AI runs from the agencies' credit grants; drop lapsed holds.
      name: 'settleCredits',
      mode: 'once',
      run: async () => ({ result: await settleCredits(db, now()), more: false }),
    },
    {
      // PLATFORM-PLAN 3.7: an agency far above its usual hour has its sends paused and its owners told.
      name: 'sendSpikes',
      mode: 'once',
      everyMinutes: 5,
      run: async () => ({ result: await detectSendSpikes(db, now(), { notice: deps.reminders.notice ?? null }), more: false }),
    },
    {
      // The job queue's urgent lane (PLATFORM-PLAN 3.1): a fair share per agency per round.
      name: 'urgentJobs',
      mode: 'drain',
      run: async () => {
        const r = await runJobs(db, { 'sms.reconcile': smsReconcileHandler(deps.phone), 'stripe.event': stripeEventHandler({ stripe: deps.stripe ?? null }) }, { lane: 'urgent', limit: MINUTE_BATCH.urgentJobs, now });
        return { result: { claimed: r.claimed, done: r.done, retried: r.retried, dead: r.dead }, more: r.more };
      },
    },
  ];
}
