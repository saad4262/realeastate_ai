import { and, asc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import { emailBatch, proposedAction, type Db, type DbOrTx } from '@repo/db';
import { activeMemberActor } from '../team/member-actor';
import { can, type Actor } from '../permissions';
import { recordActivity } from '../contacts/write-contacts';
import { ContactError } from '../contacts/list-contacts';
import { createNote } from '../contacts/notes';
import { assignContact, recordMarketingConsent, setNextAction, withdrawMarketingConsent } from '../contacts/write-contacts';
import { AppointmentError, cancelAppointment, rescheduleAppointment, scheduleAppointment } from '../appointments/appointments';
import { syncAppointment, type SyncDeps, type SyncOutcome } from '../appointments/sync';
import { requireIntegrations } from '../integrations/accounts';
import { approveBatch, cancelBatch } from '../template-email/batches';
import { sendBatch, type TemplateSendDeps } from '../template-email/send';
import { TemplateEmailError } from '../template-email/templates';
import { emailLimitsFromEnv } from '../email/limits';
import { createDashboard, DashboardError } from '../dashboards';
import { PROVIDERS, type IntegrationProvider } from '../integrations/providers';
import type { ActivityKind } from '../contacts/contact-schema';
import { AssistantError } from './conversations';
import { ASSISTANT_LIMITS, type AssistantWriteTool, type ProposalCard, type ProposalStatus } from './schema';
import type { ToolContext, ToolOutcome } from './tools';

/**
 * Proposed actions (ADR 0025 §1, §6, §7): the model proposes; a person
 * disposes. Nothing in this file is reachable from the model — `propose` is
 * called by a write tool and only STORES; approve, reject and cancel are called
 * by console buttons with the person's own session.
 */

/** What a write tool needs to store a proposal: where it came from, and this turn's count. */
export type ProposalContext = {
  conversationId: string;
  turnId: string;
  toolUseId: string;
  /** Shared by every tool call in the turn. */
  made: { count: number };
};

/** The resolved, frozen arguments each tool runs with. Ids and instants — never references. */
export type FrozenArgs =
  | { tool: 'add_note'; contactId: string; body: string; private: boolean }
  | { tool: 'set_next_action'; contactId: string; nextAction: string | null; nextActionAt: string | null }
  | {
      tool: 'schedule_appointment';
      contactId: string;
      title: string;
      type: 'appraisal' | 'phone_call' | 'zoom' | 'inspection' | 'meeting';
      startsAt: string;
      endsAt: string;
      timezone: string;
      location: string | null;
      /** Providers that must still be connected when it runs. */
      requires: IntegrationProvider[];
    }
  | { tool: 'reschedule_appointment'; appointmentId: string; contactId: string; startsAt: string; endsAt: string; timezone: string; requires: IntegrationProvider[] }
  | { tool: 'cancel_appointment'; appointmentId: string; contactId: string; reason: string | null; requires: IntegrationProvider[] }
  /**
   * Phase D: the ADR 0022 batch prepared (and frozen) when the card was made.
   * `contactIds` = every recipient, for the audit on each of their timelines.
   */
  | { tool: 'send_template_email'; batchId: string; templateId: string; contactIds: string[] }
  /** ADR 0027: the dashboard as it will be saved — registry ids and parsed params only. */
  | { tool: 'create_dashboard'; title: string; widgets: { widget: string; params: Record<string, unknown> }[]; audience: 'private' | 'admins' | 'agency' }
  /** Owners/admins: give these contacts to `to`. `from` = who held each when the card was made. */
  | { tool: 'assign_contacts'; to: string; contactIds: string[]; from: Record<string, string | null> }
  /** Consent for these contacts, with the person's words for how they agreed. */
  | { tool: 'record_marketing_consent'; contactIds: string[]; how: string }
  | { tool: 'withdraw_marketing_consent'; contactIds: string[]; reason: string };

/** The contacts whose timelines carry this action's audit lines. */
function auditContacts(row: { contactId: string | null; args: unknown }): string[] {
  const args = row.args as FrozenArgs;
  if ('contactIds' in args) return args.contactIds;
  return row.contactId ? [row.contactId] : [];
}

function actionResource(a: { id: string; agencyId: string; userId: string }) {
  return { type: 'proposed_action', id: a.id, agencyId: a.agencyId, ownerId: a.userId };
}

function auditPayload(id: string, tool: string, args: FrozenArgs, extra: Record<string, unknown> = {}) {
  // Never the text: a timeline line is read by everyone who may see the
  // contact, and a private note's words are not theirs to read.
  return { actionId: id, tool, ...(args.tool === 'add_note' && args.private ? { private: true } : {}), ...extra };
}

/**
 * Store a proposal and put it on the contact's timeline. Idempotent on
 * `conversation:tool_use_id`: a retried model request finds the card it
 * already made instead of making a second.
 */
export async function propose(
  ctx: ToolContext,
  label: string,
  p: { tool: AssistantWriteTool; args: FrozenArgs; card: ProposalCard; contactId: string | null },
): Promise<ToolOutcome> {
  const { db, actor, proposal } = ctx;
  if (!proposal || !actor.agencyId) {
    return { label, isError: true, result: { error: 'Changes can only be proposed inside a conversation.' } };
  }
  if (proposal.made.count >= ASSISTANT_LIMITS.proposalsPerTurn) {
    return {
      label,
      isError: true,
      result: { error: `You have already proposed ${ASSISTANT_LIMITS.proposalsPerTurn} changes in this answer. Ask the person to deal with those cards first.` },
    };
  }
  const agencyId = actor.agencyId;
  const key = `${proposal.conversationId}:${proposal.toolUseId}`;
  const expiresAt = new Date(ctx.now.getTime() + ASSISTANT_LIMITS.proposalHours * 3_600_000);

  const id = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(proposedAction)
      .values({
        agencyId,
        userId: actor.userId,
        conversationId: proposal.conversationId,
        turnId: proposal.turnId,
        contactId: p.contactId,
        tool: p.tool,
        args: p.args,
        card: p.card,
        idempotencyKey: key,
        expiresAt,
      })
      .onConflictDoNothing({ target: proposedAction.idempotencyKey })
      .returning({ id: proposedAction.id });
    if (!created) {
      const [existing] = await tx.select({ id: proposedAction.id }).from(proposedAction).where(eq(proposedAction.idempotencyKey, key)).limit(1);
      return existing!.id;
    }
    for (const contactId of auditContacts({ contactId: p.contactId, args: p.args })) {
      await recordActivity(tx, actor, agencyId, contactId, 'assistant_proposed', auditPayload(created.id, p.tool, p.args));
    }
    return created.id;
  });
  proposal.made.count += 1;

  return {
    label,
    frame: { kind: 'proposal', id, tool: p.tool },
    result: {
      proposed: true,
      status: 'waiting for the person',
      note: 'A card is on screen. Nothing has happened yet: only the person can press Approve or Reject, and you cannot. Tell them in one sentence what the card will do.',
    },
  };
}

/** A domain refusal at run time — shown on the card as the reason; never a crash. */
function runRefusal(err: unknown): string | null {
  if (err instanceof ContactError || err instanceof AppointmentError || err instanceof AssistantError || err instanceof TemplateEmailError || err instanceof DashboardError) {
    return err.message;
  }
  return null;
}

async function assertStillConnected(db: DbOrTx, actor: Actor, providers: IntegrationProvider[], now: Date): Promise<void> {
  if (!providers.length) return;
  const check = await requireIntegrations(db, actor, providers, now);
  if (!check.ok) {
    const names = check.missing.map((m) => PROVIDERS[m].label).join(' and ');
    throw new AssistantError('conflict', `${names} is no longer connected. Connect ${names} first (Integrations), then ask again.`);
  }
}

/** Run one approved action AS the person, through the same core function a screen uses — which re-checks can(). */
type RunDeps = { sync?: SyncDeps | null; templateSend?: TemplateSendDeps | null; env?: NodeJS.ProcessEnv };

/**
 * Delayed execution (ADR 0025 §6, Phase E) is offered only with
 * ASSISTANT_SCHEDULING=1 — set once the 5-minute cron is real. Already
 * scheduled actions still run if it is turned off later: they were approved.
 */
export function schedulingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ASSISTANT_SCHEDULING === '1';
}
/** At most this far after approval (ADR 0025 §6, decided Q4). */
export const SCHEDULE_MAX_HOURS = 48;
/** A run time within this of now is "now". */
const NOW_SLACK_MS = 60_000;
/** An email card must run this long before its prepared batch expires (the tick can be ~5 min late). */
const BATCH_MARGIN_MS = 10 * 60_000;

async function execute(
  tx: Db,
  actor: Actor,
  args: FrozenArgs,
  now: Date,
  deps: RunDeps,
): Promise<{ result: Record<string, unknown>; appointmentId?: string; batchId?: string }> {
  switch (args.tool) {
    case 'add_note': {
      const { id } = await createNote(tx, actor, args.contactId, args.body, { isPrivate: args.private });
      return { result: { noteId: id } };
    }
    case 'set_next_action': {
      await setNextAction(tx, actor, args.contactId, {
        ...(args.nextAction ? { nextAction: args.nextAction } : {}),
        ...(args.nextActionAt ? { nextActionAt: args.nextActionAt } : {}),
      });
      return { result: {} };
    }
    case 'schedule_appointment': {
      if (new Date(args.startsAt).getTime() <= now.getTime()) throw new AssistantError('conflict', 'That time has already passed. Ask again with a new time.');
      await assertStillConnected(tx, actor, args.requires, now);
      const { id } = await scheduleAppointment(tx, actor, args.contactId, {
        title: args.title,
        type: args.type,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        timezone: args.timezone,
        ...(args.location ? { location: args.location } : {}),
      });
      return { result: { appointmentId: id }, appointmentId: id };
    }
    case 'reschedule_appointment': {
      if (new Date(args.startsAt).getTime() <= now.getTime()) throw new AssistantError('conflict', 'That time has already passed. Ask again with a new time.');
      await assertStillConnected(tx, actor, args.requires, now);
      await rescheduleAppointment(tx, actor, args.appointmentId, {
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        timezone: args.timezone,
      });
      return { result: { appointmentId: args.appointmentId }, appointmentId: args.appointmentId };
    }
    case 'cancel_appointment': {
      await assertStillConnected(tx, actor, args.requires, now);
      await cancelAppointment(tx, actor, args.appointmentId, { ...(args.reason ? { outcome: args.reason } : {}) });
      return { result: { appointmentId: args.appointmentId }, appointmentId: args.appointmentId };
    }
    case 'send_template_email': {
      // Refuse before claiming the batch: approving one that cannot be sent would strand it.
      if (!deps.templateSend) throw new AssistantError('conflict', 'Email is not set up on this server, so nothing can be sent.');
      // ADR 0022's own Approve: guarded (once), expiry and today's limits re-checked, as this person.
      await approveBatch(tx, actor, args.batchId, deps.templateSend.limits ?? emailLimitsFromEnv(), now);
      return { result: { batchId: args.batchId }, batchId: args.batchId };
    }
    case 'create_dashboard': {
      // createDashboard asks dashboard:create (owner/admin) again and re-parses every widget.
      const { id } = await createDashboard(tx, actor, { title: args.title, widgets: args.widgets as never, audience: args.audience });
      return { result: { dashboardId: id } };
    }
    case 'assign_contacts': {
      // All or none (one savepoint). assignContact asks contact:assign again, checks the receiver
      // is still an active member who may hold contacts, and refuses a contact someone else was
      // given since the card showed who had it.
      for (const contactId of args.contactIds) {
        await assignContact(tx, actor, contactId, args.to, { via: 'assistant', expectedFrom: args.from[contactId] ?? null });
      }
      return { result: { assigned: args.contactIds.length } };
    }
    case 'record_marketing_consent': {
      // All or none. Each asks contact:update again, and refuses anyone who unsubscribed since the card.
      let recorded = 0;
      for (const contactId of args.contactIds) {
        if ((await recordMarketingConsent(tx, actor, contactId, args.how, { via: 'assistant' })) === 'recorded') recorded += 1;
      }
      return { result: { recorded } };
    }
    case 'withdraw_marketing_consent': {
      let withdrawn = 0;
      for (const contactId of args.contactIds) {
        if ((await withdrawMarketingConsent(tx, actor, contactId, args.reason, { via: 'assistant' })) === 'withdrawn') withdrawn += 1;
      }
      return { result: { withdrawn } };
    }
  }
}

const NOT_FOUND = () => new AssistantError('not_found', 'That card was not found');

async function loadRow(db: DbOrTx, actor: Actor, id: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw NOT_FOUND();
  const [row] = await db
    .select()
    .from(proposedAction)
    .where(and(eq(proposedAction.id, id), eq(proposedAction.agencyId, actor.agencyId)))
    .limit(1);
  if (!row || !can(actor, 'proposed_action:read', actionResource(row))) throw NOT_FOUND();
  return row;
}

export type ApproveResult =
  | { outcome: 'done'; result: Record<string, unknown>; sync: SyncOutcome | null }
  | { outcome: 'failed'; error: string }
  | { outcome: 'scheduled'; runAt: Date }
  | { outcome: 'already'; status: ProposalStatus };

type RowT = typeof proposedAction.$inferSelect;
type Ran = { ok: true; result: Record<string, unknown>; appointmentId?: string; batchId?: string } | { ok: false; error: string };

/**
 * Run a CLAIMED action inside the caller's transaction: audit, execute in a
 * savepoint (a refusal undoes only the action, never the record of it), and
 * settle the row `done` or `failed`. Shared by Approve-now and the scheduler,
 * so a delayed action runs exactly the way an immediate one does.
 */
async function runClaimed(tx: Db, actor: Actor, row: RowT, deps: RunDeps, now: Date): Promise<Ran> {
  const args = row.args as FrozenArgs;
  const audit = async (kind: ActivityKind, extra: Record<string, unknown> = {}) => {
    for (const contactId of auditContacts(row)) {
      await recordActivity(tx, actor, row.agencyId, contactId, kind, auditPayload(row.id, row.tool, args, extra));
    }
  };
  if (!row.runAt) await audit('assistant_approved');
  try {
    const done = await tx.transaction((sp) => execute(sp as unknown as Db, actor, args, now, deps));
    await tx
      .update(proposedAction)
      .set({ status: 'done', result: done.result, finishedAt: now, updatedAt: sql`now()` })
      .where(eq(proposedAction.id, row.id));
    return { ok: true, ...done };
  } catch (err) {
    const reason = runRefusal(err);
    if (!reason) throw err;
    await failRow(tx, actor, row, reason, now);
    return { ok: false, error: reason };
  }
}

/** Mark it failed with the reason; an email card takes its prepared batch with it. */
async function failRow(tx: Db, actor: Actor | null, row: RowT, reason: string, now: Date): Promise<void> {
  const args = row.args as FrozenArgs;
  await tx
    .update(proposedAction)
    .set({ status: 'failed', error: reason, finishedAt: now, updatedAt: sql`now()` })
    .where(eq(proposedAction.id, row.id));
  // A failed email card takes its prepared batch with it, so the Bulk email screen
  // never shows a batch still waiting for an Approve that the card refused.
  if (args.tool === 'send_template_email' && actor) {
    await tx.transaction((sp) => cancelBatch(sp as unknown as Db, actor, args.batchId)).catch(() => undefined);
  }
  if (actor) {
    for (const contactId of auditContacts(row)) {
      await recordActivity(tx, actor, row.agencyId, contactId, 'assistant_failed', auditPayload(row.id, row.tool, args));
    }
  }
}

/** After the commit: Google/Zoom sync and the email send (network never runs inside a transaction). */
async function afterCommit(db: Db, row: RowT, ran: Extract<Ran, { ok: true }>, deps: RunDeps): Promise<ApproveResult> {
  let sync: SyncOutcome | null = null;
  if (ran.appointmentId && deps.sync) {
    sync = await syncAppointment(db, deps.sync, ran.appointmentId).catch(() => null);
  }
  if (ran.batchId && deps.templateSend) {
    // sendBatch re-checks each recipient — consent, opt-out, archive, email changed, the 7-day
    // rule, the dev allowlist, today's limits — and skips with the reason; it never adds anyone.
    const report = await sendBatch(db, deps.templateSend, ran.batchId).catch((err: unknown) => {
      console.error('[assistant] template send failed', err instanceof Error ? err.message : err);
      return null;
    });
    const result = { ...ran.result, ...(report ?? { sendError: 'Sending stopped part-way; the bulk email page shows who was sent and lets you retry.' }) };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync };
  }
  return { outcome: 'done', result: ran.result, sync };
}

/**
 * Approve: CLAIM and RUN in one transaction. The claim is a guarded update
 * (`proposed`, unexpired, this person's) — a second click, a second tab or a
 * replayed request finds nothing to claim and runs nothing. The run goes
 * through the screen's own core function as this person, which asks can()
 * again; a refusal (access lost, contact gone, appointment changed) marks the
 * card failed with the reason. Google Calendar / Zoom are synced AFTER the
 * transaction (a network call never runs inside one).
 *
 * With `runAt` (Phase E, only when ASSISTANT_SCHEDULING=1): the claim moves
 * it to `scheduled` instead, and the cron tick runs it then — as the person
 * as they are THEN, with every check repeated (`runScheduledActions`).
 */
export async function approveProposedAction(
  db: Db,
  actor: Actor,
  id: string,
  deps: RunDeps = {},
  now = new Date(),
  opts: { runAt?: Date | null } = {},
): Promise<ApproveResult> {
  const row = await loadRow(db, actor, id);
  if (!can(actor, 'proposed_action:decide', actionResource(row))) {
    throw new AssistantError('forbidden', 'Only the person the assistant was working for can approve this.');
  }
  const runAt = opts.runAt && opts.runAt.getTime() > now.getTime() + NOW_SLACK_MS ? opts.runAt : null;
  if (runAt) return schedule(db, actor, row, runAt, deps, now);

  const ran = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(proposedAction)
      .set({ status: 'running', decidedAt: now, decidedBy: actor.userId, updatedAt: sql`now()` })
      .where(
        and(
          eq(proposedAction.id, row.id),
          eq(proposedAction.userId, actor.userId),
          eq(proposedAction.status, 'proposed'),
          gt(proposedAction.expiresAt, now),
        ),
      )
      .returning({ id: proposedAction.id });
    if (!claimed) return null;
    return runClaimed(tx as unknown as Db, actor, { ...row, runAt: null }, deps, now);
  });

  if (!ran) return notClaimed(db, row.id);
  if (!ran.ok) return { outcome: 'failed', error: ran.error };
  return afterCommit(db, row, ran, deps);
}

async function notClaimed(db: Db, id: string): Promise<ApproveResult> {
  const [cur] = await db.select({ status: proposedAction.status }).from(proposedAction).where(eq(proposedAction.id, id)).limit(1);
  const status = (cur?.status ?? 'expired') as ProposalStatus;
  if (status === 'proposed') throw new AssistantError('expired', 'This card has expired. Ask the assistant again.');
  if (status === 'running' || status === 'done' || status === 'approved' || status === 'scheduled') return { outcome: 'already', status };
  throw new AssistantError('conflict', status === 'expired' ? 'This card has expired. Ask the assistant again.' : `This card was already ${status}.`);
}

/** Approve for later: checks the time, then a guarded `proposed` → `scheduled`. Nothing runs now. */
async function schedule(db: Db, actor: Actor, row: RowT, runAt: Date, deps: RunDeps, now: Date): Promise<ApproveResult> {
  if (!schedulingEnabled(deps.env ?? process.env)) {
    throw new AssistantError('conflict', 'Running a change later is not switched on here yet — approve it to run now.');
  }
  if (Number.isNaN(runAt.getTime()) || runAt.getTime() > now.getTime() + SCHEDULE_MAX_HOURS * 3_600_000) {
    throw new AssistantError('conflict', `A change can run at most ${SCHEDULE_MAX_HOURS} hours from now.`);
  }
  const args = row.args as FrozenArgs;
  if (args.tool === 'send_template_email') {
    // The prepared email (ADR 0022) has its own 48-hour life; the run must fall inside it.
    const [b] = await db.select({ expiresAt: emailBatch.expiresAt }).from(emailBatch).where(eq(emailBatch.id, args.batchId)).limit(1);
    const last = b ? new Date(b.expiresAt).getTime() - BATCH_MARGIN_MS : 0;
    if (runAt.getTime() > last) {
      throw new AssistantError('conflict', b ? `This email was prepared to be sent by ${new Date(last).toISOString()} — choose an earlier time.` : 'This email is no longer prepared. Ask the assistant again.');
    }
  }
  const done = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(proposedAction)
      .set({ status: 'scheduled', runAt, decidedAt: now, decidedBy: actor.userId, updatedAt: sql`now()` })
      .where(
        and(
          eq(proposedAction.id, row.id),
          eq(proposedAction.userId, actor.userId),
          eq(proposedAction.status, 'proposed'),
          gt(proposedAction.expiresAt, now),
        ),
      )
      .returning({ id: proposedAction.id });
    if (!claimed) return false;
    for (const contactId of auditContacts(row)) {
      await recordActivity(tx, actor, row.agencyId, contactId, 'assistant_approved', auditPayload(row.id, row.tool, args, { runAt: runAt.toISOString() }));
    }
    return true;
  });
  if (!done) return notClaimed(db, row.id);
  return { outcome: 'scheduled', runAt };
}

export type ScheduledRunReport = { ran: number; done: number; failed: number };

/**
 * The cron tick (Phase E): run every scheduled action that is due, one per
 * transaction. The claim is `FOR UPDATE SKIP LOCKED` on a due `scheduled` row,
 * inside the same transaction as the run and its `done`/`failed` — so two
 * ticks never run one action, and a crash part-way leaves it `scheduled`, as
 * if never started. It runs AS the person who approved it, as they are NOW:
 * still an active member, still allowed to decide it, and through the same
 * core function as Approve-now, which repeats every check (can(), contact
 * visible and not archived, the appointment still ahead, integrations still
 * connected; for email: consent, opt-out, the 7-day rule, today's limits and
 * the dev allowlist, per recipient, at send).
 */
export async function runScheduledActions(db: Db, deps: RunDeps = {}, now = new Date(), limit = 10): Promise<ScheduledRunReport> {
  const report: ScheduledRunReport = { ran: 0, done: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    let row: RowT | null = null;
    let outcome: { kind: 'done'; ran: Extract<Ran, { ok: true }> } | { kind: 'failed' } | null;
    try {
      outcome = await db.transaction(async (tx) => {
        // Lock one due row (another tick skips it), then move it on — both in this transaction.
        const [due] = await tx
          .select({ id: proposedAction.id })
          .from(proposedAction)
          .where(and(eq(proposedAction.status, 'scheduled'), lte(proposedAction.runAt, now)))
          .orderBy(asc(proposedAction.runAt))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!due) return null;
        const [moved] = await tx
          .update(proposedAction)
          .set({ status: 'running', updatedAt: sql`now()` })
          .where(and(eq(proposedAction.id, due.id), eq(proposedAction.status, 'scheduled')))
          .returning({ id: proposedAction.id });
        const claimedId = moved?.id;
        if (!claimedId) return null;
        const [r] = await tx.select().from(proposedAction).where(eq(proposedAction.id, claimedId)).limit(1);
        row = r!;
        const actor = await activeMemberActor(tx, row.userId, row.agencyId);
        if (!actor || !can(actor, 'proposed_action:decide', actionResource(row))) {
          await failRow(tx as unknown as Db, actor, row, 'The person who approved this is no longer an active member who may make this change, so it did not run.', now);
          return { kind: 'failed' as const };
        }
        const ran = await runClaimed(tx as unknown as Db, actor, row, deps, now);
        return ran.ok ? { kind: 'done' as const, ran } : { kind: 'failed' as const };
      });
    } catch (err) {
      // Not a refusal: the transaction rolled back, nothing happened. Fail it (guarded) so it is
      // not retried forever, with a reason the person can read.
      console.error('[assistant] scheduled action failed', err instanceof Error ? err.message : err);
      const failedId = (row as RowT | null)?.id;
      if (failedId) {
        await db
          .update(proposedAction)
          .set({ status: 'failed', error: 'It could not run because of an error on our side. Nothing was changed.', finishedAt: now, updatedAt: sql`now()` })
          .where(and(eq(proposedAction.id, failedId), eq(proposedAction.status, 'scheduled')));
        report.ran += 1;
        report.failed += 1;
        continue;
      }
      break;
    }
    if (!outcome) break;
    report.ran += 1;
    if (outcome.kind === 'failed') {
      report.failed += 1;
      continue;
    }
    report.done += 1;
    await afterCommit(db, row!, outcome.ran, deps).catch((err: unknown) => console.error('[assistant] after-run step failed', err instanceof Error ? err.message : err));
  }
  return report;
}

/** Reject: only its author, only while it waits. A second click is harmless. */
export async function rejectProposedAction(db: Db, actor: Actor, id: string): Promise<SettleResult> {
  const row = await loadRow(db, actor, id);
  if (!can(actor, 'proposed_action:decide', actionResource(row))) {
    throw new AssistantError('forbidden', 'Only the person the assistant was working for can reject this.');
  }
  return settle(db, actor, row, ['proposed'], 'rejected', 'assistant_rejected');
}

/** Cancel one not yet run: its author or an admin (`proposed` now; `scheduled` once delayed runs exist). */
export async function cancelProposedAction(db: Db, actor: Actor, id: string): Promise<SettleResult> {
  const row = await loadRow(db, actor, id);
  if (!can(actor, 'proposed_action:cancel', actionResource(row))) {
    throw new AssistantError('forbidden', 'You may not cancel this.');
  }
  return settle(db, actor, row, ['proposed', 'scheduled'], 'cancelled', 'assistant_cancelled');
}

export type SettleResult = { outcome: 'rejected' | 'cancelled' | 'already'; status: ProposalStatus };

async function settle(
  db: Db,
  actor: Actor,
  row: { id: string; agencyId: string; contactId: string | null; tool: string; args: unknown },
  from: ProposalStatus[],
  to: 'rejected' | 'cancelled',
  kind: ActivityKind,
): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const [done] = await tx
      .update(proposedAction)
      .set({ status: to, decidedAt: sql`now()`, decidedBy: actor.userId, updatedAt: sql`now()` })
      .where(and(eq(proposedAction.id, row.id), inArray(proposedAction.status, from)))
      .returning({ id: proposedAction.id });
    if (!done) {
      const [cur] = await tx.select({ status: proposedAction.status }).from(proposedAction).where(eq(proposedAction.id, row.id)).limit(1);
      return { outcome: 'already' as const, status: (cur?.status ?? to) as ProposalStatus };
    }
    const args = row.args as FrozenArgs;
    // A rejected or cancelled email card takes its prepared batch with it.
    if (args.tool === 'send_template_email') {
      await tx.transaction((sp) => cancelBatch(sp as unknown as Db, actor, args.batchId)).catch(() => undefined);
    }
    for (const contactId of auditContacts(row)) {
      await recordActivity(tx, actor, row.agencyId, contactId, kind, auditPayload(row.id, row.tool, args));
    }
    return { outcome: to, status: to };
  });
}

/** The cron tick: proposals nobody decided within 48 h expire. The row keeps the record. */
export async function expireProposedActions(db: Db, now = new Date()): Promise<number> {
  const gone = await db
    .update(proposedAction)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(and(eq(proposedAction.status, 'proposed'), lt(proposedAction.expiresAt, now)))
    .returning({ id: proposedAction.id });
  return gone.length;
}

export type ProposalView = {
  id: string;
  tool: AssistantWriteTool;
  status: ProposalStatus;
  card: ProposalCard;
  error: string | null;
  /** Ids of what it made or changed — for links. Never model text. */
  result: { noteId?: string; appointmentId?: string; batchId?: string; dashboardId?: string; assigned?: number; recorded?: number; withdrawn?: number; sent?: number; skipped?: number; failed?: number; sendError?: string } | null;
  expiresAt: Date;
  /** When a scheduled action will run (about; up to ~5 minutes later). */
  runAt: Date | null;
  /** Whether Approve may be given a later run time (ASSISTANT_SCHEDULING=1, Phase E). */
  scheduling: boolean;
  /** Decided by can(): the panel draws its buttons from these. */
  mayDecide: boolean;
  mayCancel: boolean;
};

/** One card, as the database holds it. Not-found for anyone `proposed_action:read` refuses. */
export async function getProposedAction(db: Db, actor: Actor, id: string, now = new Date()): Promise<ProposalView> {
  const row = await loadRow(db, actor, id);
  const waiting = row.status === 'proposed' && new Date(row.expiresAt).getTime() > now.getTime();
  const status = (row.status === 'proposed' && !waiting ? 'expired' : row.status) as ProposalStatus;
  return {
    id: row.id,
    tool: row.tool as AssistantWriteTool,
    status,
    card: row.card as ProposalCard,
    error: row.error,
    result: (row.result as ProposalView['result']) ?? null,
    expiresAt: new Date(row.expiresAt),
    runAt: row.runAt ? new Date(row.runAt) : null,
    scheduling: schedulingEnabled(),
    mayDecide: waiting && can(actor, 'proposed_action:decide', actionResource(row)),
    mayCancel: (status === 'proposed' || status === 'scheduled') && can(actor, 'proposed_action:cancel', actionResource(row)),
  };
}
