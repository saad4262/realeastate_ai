import { and, asc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import { assistantTask, emailBatch, proposedAction, user, type Db, type DbOrTx } from '@repo/db';
import { notifyMyself } from '../notifications';
import { activeMemberActor } from '../team/member-actor';
import { can, type Actor } from '../permissions';
import { recordActivity } from '../contacts/write-contacts';
import { ContactError } from '../contacts/list-contacts';
import { createNote } from '../contacts/notes';
import {
  assignContact,
  editContactDetails,
  recordMarketingConsent,
  setContactArchived,
  setNextAction,
  withdrawMarketingConsent,
  type ContactDetails,
  type ContactDetailsPatch,
} from '../contacts/write-contacts';
import { AppointmentError, cancelAppointment, rescheduleAppointment, scheduleAppointment, scheduleTeamMeeting } from '../appointments/appointments';
import { syncAppointment, type SyncDeps, type SyncOutcome } from '../appointments/sync';
import { sendInvitation } from '../appointments/invitation';
import { tellIfUntold, type TeamMeetingDeps } from '../appointments/team-meetings';
import { getAppointment } from '../appointments/appointments';
import { deliverOutbound, type MailDeps } from '../mail/send';
import { recordContactEmail } from '../mail/compose';
import { MailError } from '../mail/threads';
import { deliverTeamMessage, startTeamThread, TeamMessageError, type TeamMessageDeps } from '../team-messages/messages';
import { requireIntegrations } from '../integrations/accounts';
import { approveBatch, cancelBatch, classifyRecipients, storePreparedBatch } from '../template-email/batches';
import { sendBatch, type TemplateSendDeps } from '../template-email/send';
import { TemplateEmailError } from '../template-email/templates';
import { checkEmailLimits, emailLimitsFromEnv, type TemplateLimits } from '../email/limits';
import { createDashboard, DashboardError } from '../dashboards';
import { PROVIDERS, type IntegrationProvider } from '../integrations/providers';
import type { ActivityKind } from '../contacts/contact-schema';
import { AssistantError } from './conversations';
import { editTeamMember, TeamEditError, withdrawInvite, type TeamMemberDetails, type TeamTarget } from '../team/edit-member';
import { offboardingPreview, OffboardError, removeMember, type OffboardChoice, type OffboardDeps } from '../team/offboarding';
import { emailAgentInvite, type InviteEmailDeps } from '../team/invite-email';
import { ASSISTANT_LIMITS, type AssistantWriteTool, type ProposalCard, type ProposalStatus } from './schema';
import { activateTask, advanceTask, endTask, taskAllowsRun, verifyExecuted } from './task-state';
import { assignLead, LeadTriageError, updateLeadStatus } from '../leads/triage-lead';
import { createManualLead } from '../leads/create-manual-lead';
import { createContact } from '../contacts/write-contacts';
import { buildReminderEmail } from '../email/team-notices';
import type { ToolContext, ToolOutcome } from './tools';
import { runListingAction, type FrozenPin } from './listing-tools';
import { runSkillAction } from './skill-tools';
import type { SkillScheduleInput } from '../skills/skill-schema';
import { ListingError } from '../listings/listing-schema';
import { inviteAgent } from '../team/invite-agent';
import { isInviteAgentError, type InviteAgentDraft } from '../team/invite-schema';

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
      /**
       * Email the ADR 0019 invitation once it is booked and synced (ADR 0032 §1).
       * Absent on cards made before it existed: no invitation.
       */
      sendInvitation?: boolean;
    }
  | { tool: 'reschedule_appointment'; appointmentId: string; contactId: string; startsAt: string; endsAt: string; timezone: string; requires: IntegrationProvider[] }
  | { tool: 'cancel_appointment'; appointmentId: string; contactId: string; reason: string | null; requires: IntegrationProvider[] }
  /**
   * Phase D: the ADR 0022 batch prepared (and frozen) when the card was made.
   * `contactIds` = every recipient, for the audit on each of their timelines.
   */
  | { tool: 'send_template_email'; batchId: string; templateId: string; contactIds: string[] }
  /**
   * ADR 0040 part 2 §2: one part of a saved list, a task step. Prepared and approved WHEN IT RUNS,
   * as the person then (every recipient classified again); `gapHours` after the part before.
   */
  | { tool: 'send_template_email'; part: { n: number; of: number; list: string }; templateId: string; contactIds: string[]; gapHours: number }
  /** ADR 0027: the dashboard as it will be saved — registry ids and parsed params only. */
  | { tool: 'create_dashboard'; title: string; widgets: { widget: string; params: Record<string, unknown> }[]; audience: 'private' | 'admins' | 'agency' }
  /** Owners/admins: give these contacts to `to`. `from` = who held each when the card was made. */
  | { tool: 'assign_contacts'; to: string; contactIds: string[]; from: Record<string, string | null> }
  /** Consent for these contacts, with the person's words for how they agreed. */
  | { tool: 'record_marketing_consent'; contactIds: string[]; how: string }
  | { tool: 'withdraw_marketing_consent'; contactIds: string[]; reason: string }
  /** Only the fields the card showed; `before` = what it showed them as (refused if they changed since). */
  | { tool: 'update_contact'; contactId: string; patch: ContactDetailsPatch; before: Partial<ContactDetails> }
  | { tool: 'set_contact_archived'; contactId: string; archived: boolean }
  /** ADR 0033: only the fields the card showed; `before` = what it showed (refused if they changed since). */
  | { tool: 'update_agent'; target: TeamTarget; patch: Partial<TeamMemberDetails>; before: Partial<TeamMemberDetails> }
  /** ADR 0033: an invite is withdrawn (`choice` null); a member is removed as ADR 0030, with this choice. */
  | { tool: 'remove_agent'; target: TeamTarget; choice: OffboardChoice | null }
  /** ADR 0035: the exact words the card showed — what was approved is what is sent. */
  | { tool: 'send_email'; contactId: string; subject: string; body: string }
  /** ADR 0035: colleagues' user ids (from `M` references), and the exact words. */
  | { tool: 'message_colleagues'; to: string[]; subject: string; body: string }
  /** ADR 0038: colleagues' user ids (from `M` references); the host is the person who approves. */
  | {
      tool: 'schedule_team_meeting';
      participantIds: string[];
      title: string;
      type: 'zoom' | 'phone_call' | 'meeting';
      startsAt: string;
      endsAt: string;
      timezone: string;
      location: string | null;
      agenda: string | null;
      requires: IntegrationProvider[];
    }
  /** ADR 0040: a lead's status, as the card showed it before (`before`). "Delete" a lead = closed. */
  | { tool: 'set_lead_status'; leadId: string; status: 'new' | 'contacted' | 'qualified' | 'closed'; before: string }
  /** ADR 0040, owners/admins: give a lead to a member. */
  | { tool: 'assign_lead'; leadId: string; to: string; from: string | null }
  /** ADR 0040: a lead recorded by hand — the person's own, source `manual`. */
  | { tool: 'create_lead'; contactId: string; listingId: string; kind: 'enquiry' | 'inspection' | 'appraisal'; message: string | null }
  | { tool: 'create_contact'; name: string; email: string | null; phone: string | null; roles: string[] }
  /** ADR 0040: a reminder to the person themselves — the bell, and their own email only when asked. */
  | { tool: 'remind'; text: string; email: boolean }
  /** ADR 0040: approving the plan starts its task. */
  | { tool: 'plan_task'; taskId: string }
  | { tool: 'cancel_task'; taskId: string }
  /** ADR 0040 part 2 §4: always a draft; the pin worked out when the card was made (no network in the claim). */
  | { tool: 'create_listing_draft'; draft: { property: Record<string, unknown>; listing: Record<string, unknown> }; pin: FrozenPin | null }
  /** Only the fields the card showed; `before` = what it showed them as (refused if they changed since). */
  | { tool: 'update_listing'; listingId: string; patch: Partial<Record<string, string | number | null>>; before: Partial<Record<string, string | number | null>> }
  | { tool: 'withdraw_listing'; listingId: string; before: string }
  | { tool: 'submit_listing'; listingId: string; before: string }
  /** ADR 0040 part 2 §3: the wizard's draft, parsed when the card was made and again when it runs. */
  | { tool: 'invite_agent'; draft: InviteAgentDraft }
  /** ADR 0041 Part A: a library skill added to the person's own, scheduled, and switched on. */
  | { tool: 'set_up_skill'; skillId: string; schedule: SkillScheduleInput | null; emailMe: boolean; timezone: string }
  /** ADR 0041 Part A: only what the card showed; `before` = the copy as the card showed it (refused if it changed since). */
  | {
      tool: 'change_skill';
      agentSkillId: string;
      enabled?: boolean;
      schedule?: SkillScheduleInput;
      emailMe?: boolean;
      bodyMd?: string;
      before: { enabled: boolean; emailMe: boolean; when: string; bodyMd: string };
    };

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
  // Planning a task (ADR 0040): the step is checked and resolved exactly as a card would be, then
  // handed to the plan instead of being stored on its own.
  if (ctx.plan) {
    ctx.plan.collect({ tool: p.tool, args: p.args, card: p.card, contactId: p.contactId });
    return { label, result: { planned: true } };
  }
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
  if (
    err instanceof ContactError ||
    err instanceof AppointmentError ||
    err instanceof AssistantError ||
    err instanceof TemplateEmailError ||
    err instanceof DashboardError ||
    err instanceof TeamEditError ||
    err instanceof OffboardError ||
    err instanceof MailError ||
    err instanceof TeamMessageError ||
    err instanceof LeadTriageError ||
    err instanceof ListingError ||
    isInviteAgentError(err)
  ) {
    return (err as Error).message;
  }
  return null;
}

/**
 * A task step that cannot run YET (ADR 0040 part 2 §2: a list part over today's email limit):
 * it goes back to `scheduled` at `retryAt` and the task carries on. Never ends the task.
 */
export class RetryLaterError extends AssistantError {
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super('limit', message);
  }
}

/** A run refused because an account it needs is no longer connected — the card keeps which, for its Connect button. */
export class NeedsConnectionError extends AssistantError {
  constructor(
    message: string,
    readonly accounts: { provider: IntegrationProvider; label: string; mayConnect: boolean }[],
  ) {
    super('conflict', message);
  }
}

async function assertStillConnected(db: DbOrTx, actor: Actor, providers: IntegrationProvider[], now: Date): Promise<void> {
  if (!providers.length) return;
  const check = await requireIntegrations(db, actor, providers, now);
  if (!check.ok) {
    const names = check.missing.map((m) => PROVIDERS[m].label).join(' and ');
    throw new NeedsConnectionError(
      `${names} is no longer connected. Connect ${names} first, then ask again.`,
      check.results.filter((r) => r.state !== 'connected').map((r) => ({ provider: r.provider, label: PROVIDERS[r.provider].label, mayConnect: r.mayConnect })),
    );
  }
}

/** Run one approved action AS the person, through the same core function a screen uses — which re-checks can(). */
type RunDeps = {
  sync?: SyncDeps | null;
  templateSend?: TemplateSendDeps | null;
  /** For an appointment card's invitation (ADR 0032 §1). Falls back to templateSend's. */
  mail?: MailDeps | null;
  env?: NodeJS.ProcessEnv;
  /** Removing a member (ADR 0030): calendar/Zoom keys and the token revoke. */
  offboard?: OffboardDeps | null;
  /** Emailing a changed invite's new link (ADR 0033). Without it, the link is on the card and the team screen. */
  inviteMail?: InviteEmailDeps | null;
  /** A team message's emails (ADR 0035). Without it, the bell only. */
  teamMessages?: TeamMessageDeps | null;
  /** A team meeting's emails (ADR 0038). Without it, the bell only. */
  teamMeetings?: TeamMeetingDeps | null;
};

type Executed = {
  result: Record<string, unknown>;
  appointmentId?: string;
  batchId?: string;
  /** A member removal, run after the commit: it deletes calendar events and Zoom meetings over the network. */
  offboard?: { userId: string; choice: OffboardChoice };
  /** An invite whose email changed: its new link, emailed after the commit. */
  inviteClaim?: { inviteId: string; claimPath: string; expiresAt: Date };
  /** A new email to a contact, recorded queued: sent after the commit (ADR 0035). */
  mailMessageId?: string;
  /** A team message, recorded: its emails and bell after the commit. */
  teamMessageId?: string;
  /** A reminder the person asked to have emailed to themselves (ADR 0040): sent after the commit. */
  reminderEmail?: { text: string };
  /** An approved plan (ADR 0040): run its steps that are due now, after the commit. */
  taskId?: string;
};

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
  rowId: string,
): Promise<Executed> {
  switch (args.tool) {
    case 'create_listing_draft':
    case 'update_listing':
    case 'withdraw_listing':
    case 'submit_listing':
      return runListingAction(tx, actor, args);
    case 'set_up_skill':
    case 'change_skill':
      return runSkillAction(tx, actor, args, now);
    case 'invite_agent': {
      // team:manage again, and the wizard's refusals again (already a member, an invite still open).
      // Database only: the link is emailed after the commit (`inviteClaim`).
      const r = await inviteAgent(tx, actor, args.draft);
      return { result: { inviteId: r.inviteId, claimPath: r.claimPath }, inviteClaim: { inviteId: r.inviteId, claimPath: r.claimPath, expiresAt: r.expiresAt } };
    }
    case 'set_lead_status': {
      // lead:update again — an agent the lead was taken from is told it is now another agent's (ADR 0039 C3).
      await updateLeadStatus(tx, actor, args.leadId, args.status);
      return { result: { leadId: args.leadId, status: args.status } };
    }
    case 'assign_lead': {
      await assignLead(tx, actor, args.leadId, args.to);
      return { result: { leadId: args.leadId, assigned: 1 } };
    }
    case 'create_lead': {
      const { leadId } = await createManualLead(tx, actor, { contactId: args.contactId, listingId: args.listingId, kind: args.kind, message: args.message });
      return { result: { leadId } };
    }
    case 'create_contact': {
      const { id } = await createContact(tx, actor, {
        name: args.name,
        ...(args.email ? { email: args.email } : {}),
        ...(args.phone ? { phone: args.phone } : {}),
        roles: args.roles as never,
      });
      return { result: { contactId: id } };
    }
    case 'remind': {
      if (!actor.agencyId) throw new AssistantError('forbidden', 'You are not in an agency.');
      const n = await notifyMyself(tx, actor, args.text, `reminder:${rowId}`);
      if (!n) throw new AssistantError('conflict', 'This reminder was already given.');
      return { result: { notificationId: n.id }, ...(args.email ? { reminderEmail: { text: args.text } } : {}) };
    }
    case 'plan_task': {
      const { steps } = await activateTask(tx, args.taskId, actor.userId, now);
      return { result: { taskId: args.taskId, steps }, taskId: args.taskId };
    }
    case 'cancel_task': {
      const [t] = await tx
        .select({ userId: assistantTask.userId, agencyId: assistantTask.agencyId, status: assistantTask.status })
        .from(assistantTask)
        .where(eq(assistantTask.id, args.taskId))
        .limit(1);
      if (!t || t.agencyId !== actor.agencyId) throw new AssistantError('not_found', 'That task was not found.');
      if (t.userId !== actor.userId && !can(actor, 'proposed_action:cancel', { type: 'proposed_action', agencyId: t.agencyId, ownerId: t.userId })) {
        throw new AssistantError('forbidden', 'Only the person who planned it, or an admin, can cancel this task.');
      }
      if (t.status !== 'active' && t.status !== 'proposed') throw new AssistantError('conflict', `This task is already ${t.status}.`);
      const cancelled = await endTask(tx, args.taskId, 'cancelled', now);
      return { result: { cancelled } };
    }
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
      const limits = deps.templateSend.limits ?? emailLimitsFromEnv();
      if ('part' in args) return runListPart(tx, actor, args, limits, now);
      // ADR 0022's own Approve: guarded (once), expiry and today's limits re-checked, as this person.
      await approveBatch(tx, actor, args.batchId, limits, now);
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
    case 'update_contact': {
      // editContactDetails asks contact:update again, refuses if a field changed since the card,
      // re-checks the email is nobody else's — and has no way to touch assignment or consent.
      const { changed } = await editContactDetails(tx, actor, args.contactId, args.patch, { via: 'assistant', expected: args.before });
      return { result: { changed } };
    }
    case 'set_contact_archived': {
      await setContactArchived(tx, actor, args.contactId, args.archived, { via: 'assistant' });
      return { result: {} };
    }
    case 'update_agent': {
      // editTeamMember asks team:manage again, refuses a field changed since the card, and
      // repeats every rule (an active member's email, your own role, an owner's role).
      const r = await editTeamMember(tx, actor, args.target, args.patch, { expected: args.before });
      return {
        result: { changed: r.changed, ...(r.claim ? { claimPath: r.claim.claimPath } : {}) },
        ...(r.claim ? { inviteClaim: { inviteId: r.claim.inviteId, claimPath: r.claim.claimPath, expiresAt: r.claim.expiresAt } } : {}),
      };
    }
    case 'send_email': {
      const mail = deps.mail ?? deps.templateSend?.mail ?? null;
      if (!mail) throw new AssistantError('conflict', 'Email is not set up on this server, so nothing can be sent.');
      // Every check again, as this person now: mail:compose, archived, unsubscribed, the dev
      // allowlist, today's limits, the unsubscribe link. Recorded queued; sent after the commit.
      const r = await recordContactEmail(tx, mail, actor, args.contactId, { subject: args.subject, body: args.body }, { via: 'assistant', ...(deps.env ? { env: deps.env } : {}) });
      return { result: { threadId: r.threadId }, mailMessageId: r.messageId };
    }
    case 'schedule_team_meeting': {
      if (new Date(args.startsAt).getTime() <= now.getTime()) throw new AssistantError('conflict', 'That time has already passed. Ask again with a new time.');
      await assertStillConnected(tx, actor, args.requires, now);
      // appointment:create again, every colleague still an active member, nobody busy then.
      const { id } = await scheduleTeamMeeting(tx, actor, {
        title: args.title,
        type: args.type,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        timezone: args.timezone,
        participantIds: args.participantIds,
        ...(args.location ? { location: args.location } : {}),
        ...(args.agenda ? { notes: args.agenda } : {}),
      });
      return { result: { appointmentId: id }, appointmentId: id };
    }
    case 'message_colleagues': {
      // team_message:send again, and every recipient still an active member.
      const r = await startTeamThread(tx, actor, { to: args.to, subject: args.subject, body: args.body });
      return { result: { teamThreadId: r.threadId }, teamMessageId: r.messageId };
    }
    case 'remove_agent': {
      if (args.target.kind === 'invite') {
        await withdrawInvite(tx, actor, args.target.inviteId);
        return { result: { withdrawn: 1 } };
      }
      if (!args.choice) throw new AssistantError('conflict', 'Who receives their work was not chosen. Ask the assistant again.');
      // Every check removeMember makes, made now (team:manage, still active, not you, an owner
      // only by an owner, never the last owner); the removal itself runs after the commit.
      await offboardingPreview(tx, actor, args.target.userId, now);
      return { result: {}, offboard: { userId: args.target.userId, choice: args.choice } };
    }
  }
}

/**
 * One part of a saved list (ADR 0040 part 2 §2), inside the step's savepoint. The people are
 * classified AGAIN now, as this person — consent, unsubscribes, archive and the 7-day rule as
 * they are today — and the batch prepared and approved through ADR 0022's own functions; it is
 * sent after the commit. Nobody left: done, 0 sent. Over today's limit: it waits an hour.
 */
async function runListPart(
  tx: Db,
  actor: Actor,
  args: Extract<FrozenArgs, { part: unknown }>,
  limits: TemplateLimits,
  now: Date,
): Promise<Executed> {
  const c = await classifyRecipients(tx, actor, { templateId: args.templateId, contactIds: args.contactIds }, limits);
  const toSend = c.recipients.filter((r) => r.status === 'queued').length;
  if (!toSend) return { result: { part: args.part.n, sent: 0, skipped: args.contactIds.length, nobodyLeft: true } };
  const check = await checkEmailLimits(tx, { agencyId: c.agencyId, userId: actor.userId }, limits, toSend);
  if (!check.ok) throw new RetryLaterError(`Waiting for today’s email limit — it tries again in an hour. ${check.reason}`, new Date(now.getTime() + 3_600_000));
  const { id } = await storePreparedBatch(tx, actor, c, now);
  await approveBatch(tx, actor, id, limits, now);
  return { result: { part: args.part.n, batchId: id }, batchId: id };
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
type Ran = ({ ok: true } & Executed) | { ok: false; error: string; waiting?: true };

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
    // A task step (ADR 0040) runs only while its task is active and within its 30 days.
    const stop = row.taskId ? await taskAllowsRun(tx, row.taskId, now) : null;
    if (stop) throw new AssistantError('conflict', stop);
    const done = await tx.transaction(async (sp) => {
      const out = await execute(sp as unknown as Db, actor, args, now, deps, row.id);
      // The read-back (ADR 0040 §4): what the step says it made is really there, or it is undone.
      await verifyExecuted(sp as unknown as Db, args as never, out.result);
      return out;
    });
    await tx
      .update(proposedAction)
      .set({ status: 'done', result: done.result, finishedAt: now, updatedAt: sql`now()` })
      .where(eq(proposedAction.id, row.id));
    if (row.taskId) await advanceTask(tx, row.taskId, { ok: true }, now);
    return { ok: true, ...done };
  } catch (err) {
    // A task step that cannot run yet goes back to wait; its task carries on (ADR 0040 part 2 §2).
    if (err instanceof RetryLaterError && row.taskId) {
      await tx
        .update(proposedAction)
        .set({ status: 'scheduled', runAt: err.retryAt, result: { waiting: err.message }, updatedAt: sql`now()` })
        .where(eq(proposedAction.id, row.id));
      return { ok: false, error: err.message, waiting: true };
    }
    const reason = runRefusal(err);
    if (!reason) throw err;
    // A lost account keeps which one, so the failed card shows its Connect button (ADR 0040 part 2 §1).
    await failRow(tx, actor, row, reason, now, err instanceof NeedsConnectionError ? { needsConnection: err.accounts } : null);
    return { ok: false, error: reason };
  }
}

/** Mark it failed with the reason; an email card takes its prepared batch with it. */
async function failRow(tx: Db, actor: Actor | null, row: RowT, reason: string, now: Date, result: Record<string, unknown> | null = null): Promise<void> {
  const args = row.args as FrozenArgs;
  await tx
    .update(proposedAction)
    .set({ status: 'failed', error: reason, finishedAt: now, updatedAt: sql`now()`, ...(result ? { result } : {}) })
    .where(eq(proposedAction.id, row.id));
  // A failed step stops its task (ADR 0040): nothing after it runs.
  if (row.taskId) await advanceTask(tx, row.taskId, { ok: false, error: `Step ${row.taskSeq ?? '?'}: ${reason}` }, now);
  // A failed email card takes its prepared batch with it, so the Bulk email screen
  // never shows a batch still waiting for an Approve that the card refused.
  if (args.tool === 'send_template_email' && 'batchId' in args && actor) {
    await tx.transaction((sp) => cancelBatch(sp as unknown as Db, actor, args.batchId)).catch(() => undefined);
  }
  if (actor) {
    for (const contactId of auditContacts(row)) {
      await recordActivity(tx, actor, row.agencyId, contactId, 'assistant_failed', auditPayload(row.id, row.tool, args));
    }
  }
}

/**
 * A member removal, after the claim committed. removeMember opens its own
 * transactions and makes network calls, so it cannot run inside the claim's.
 * A refusal now (they were removed meanwhile, the receiver left) turns the
 * card failed with the reason.
 */
async function runOffboard(db: Db, actor: Actor, row: RowT, ran: Extract<Ran, { ok: true }>, deps: RunDeps): Promise<ApproveResult> {
  const { userId, choice } = ran.offboard!;
  try {
    const report = await removeMember(db, actor, userId, choice, deps.offboard ?? {});
    const result = { removed: true, moved: report.moved, flagged: report.flagged };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync: null };
  } catch (err) {
    const reason = err instanceof OffboardError ? err.message : 'The removal stopped because of an error on our side. Check Agents & Team before trying again.';
    if (!(err instanceof OffboardError)) console.error('[assistant] removal failed', err instanceof Error ? err.message : err);
    await db
      .update(proposedAction)
      .set({ status: 'failed', error: reason, updatedAt: sql`now()` })
      .where(eq(proposedAction.id, row.id));
    return { outcome: 'failed', error: reason };
  }
}

/** A reminder, to the person's own sign-in address — through the team-notice mailer, so it has the console's link. */
async function emailReminder(db: Db, actor: Actor, text: string, deps: RunDeps): Promise<boolean> {
  const n = deps.teamMessages;
  if (!n) return false;
  const [me] = await db.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, actor.userId)).limit(1);
  if (!me?.email) return false;
  const admin = can(actor, 'console:agency', { type: 'console', agencyId: actor.agencyId ?? '' });
  const email = buildReminderEmail({
    to: { email: me.email, ...(me.name ? { name: me.name } : {}) },
    from: n.mailer.sender.from,
    postalAddress: n.mailer.sender.postalAddress,
    text,
    consoleUrl: admin ? n.urls.agencyUrl : n.urls.agentUrl,
  });
  const sent = await n.mailer.transport.send(email);
  return sent.ok;
}

/** After the commit: Google/Zoom sync, the email send, a removal (network never runs inside a transaction). */
async function afterCommit(db: Db, actor: Actor, row: RowT, ran: Extract<Ran, { ok: true }>, deps: RunDeps): Promise<ApproveResult> {
  if (ran.offboard) return runOffboard(db, actor, row, ran, deps);
  if (ran.reminderEmail) {
    // To the person themselves, only because they asked (ADR 0040 Q3). The bell already has it.
    const emailed = await emailReminder(db, actor, ran.reminderEmail.text, deps).catch((err: unknown) => {
      console.error('[assistant] reminder email failed', err instanceof Error ? err.message : err);
      return false;
    });
    const result = { ...ran.result, emailed };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync: null };
  }
  if (ran.taskId) {
    // The plan is approved: run its steps that are due now (the rest wait for the minute tick).
    const report = await runScheduledActions(db, deps, new Date(), 10, { taskId: ran.taskId }).catch((err: unknown) => {
      console.error('[assistant] task start failed', err instanceof Error ? err.message : err);
      return null;
    });
    const result = { ...ran.result, ...(report ? { ranNow: report.done, failedNow: report.failed } : {}) };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync: null };
  }
  if (ran.inviteClaim) {
    let emailed = false;
    if (deps.inviteMail) {
      emailed = await emailAgentInvite(db, deps.inviteMail, actor, ran.inviteClaim)
        .then((o) => o.emailed)
        .catch((err: unknown) => {
          console.error('[assistant] invite email failed', err instanceof Error ? err.message : err);
          return false;
        });
    }
    const result = { ...ran.result, emailed };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync: null };
  }
  if (ran.mailMessageId) {
    const mail = deps.mail ?? deps.templateSend?.mail ?? null;
    const sent = mail
      ? await deliverOutbound(db, mail, ran.mailMessageId).catch((err: unknown) => ({ status: 'failed' as const, error: err instanceof Error ? err.message : 'Could not send' }))
      : { status: 'failed' as const, error: 'Email is not set up on this server.' };
    const result = { ...ran.result, emailStatus: sent.status, ...(sent.status === 'failed' ? { emailError: `${sent.error ?? 'It was not delivered'}. It has a Retry in the conversation.` } : {}) };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync: null };
  }
  if (ran.teamMessageId) {
    const told = await deliverTeamMessage(db, deps.teamMessages ?? null, ran.teamMessageId).catch((err: unknown) => {
      console.error('[assistant] team message delivery failed', err instanceof Error ? err.message : err);
      return null;
    });
    const result = { ...ran.result, ...(told ? { emailed: told.emailed > 0 } : {}) };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync: null };
  }
  let sync: SyncOutcome | null = null;
  if (ran.appointmentId && deps.sync) {
    sync = await syncAppointment(db, deps.sync, ran.appointmentId).catch(() => null);
  }
  const args = row.args as FrozenArgs;
  if (ran.appointmentId && args.tool === 'schedule_team_meeting') {
    // Everyone on it is told now that it has its link — or, if Zoom failed, once Retry works.
    const told = await tellIfUntold(db, deps.teamMeetings ?? null, ran.appointmentId, row.userId).catch((err: unknown) => {
      console.error('[assistant] team meeting notice failed', err instanceof Error ? err.message : err);
      return null;
    });
    const result = {
      ...ran.result,
      told: Boolean(told?.told),
      ...(told && !told.told && told.zoomError ? { zoomError: `${told.zoomError} Nobody was emailed yet — press Retry on the Calendar page.` } : {}),
    };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync };
  }
  if (ran.appointmentId && args.tool === 'schedule_appointment' && args.sendInvitation) {
    const invitation = await inviteAfterBooking(db, row, ran.appointmentId, deps);
    const result = { ...ran.result, ...invitation };
    await db.update(proposedAction).set({ result, updatedAt: sql`now()` }).where(eq(proposedAction.id, row.id));
    return { outcome: 'done', result, sync };
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
 * The invitation a booking card asked for (ADR 0032 §1), after the booking and
 * its sync: sent as the person who approved it, as they are now, through
 * ADR 0019's own `sendInvitation` (which repeats every check). A Zoom meeting
 * whose link was not created is not invited — the email would have no link.
 * Never throws: the booking stands either way, and the card says what happened.
 */
async function inviteAfterBooking(
  db: Db,
  row: RowT,
  appointmentId: string,
  deps: RunDeps,
): Promise<{ invited: true; threadId: string } | { invitationError: string }> {
  const mail = deps.mail ?? deps.templateSend?.mail ?? null;
  if (!mail) return { invitationError: 'Email is not set up on this server, so the invitation was not sent. Send it from the contact’s Calendar tab later.' };
  try {
    const actor = await activeMemberActor(db, row.userId, row.agencyId);
    if (!actor) return { invitationError: 'You are no longer an active member, so the invitation was not sent.' };
    const a = await getAppointment(db, actor, appointmentId);
    if (a.type === 'zoom' && !a.meetingUrl) {
      return { invitationError: 'The Zoom meeting was not created, so the invitation was not sent. Press Retry on the appointment, then Send invitation from the contact’s Calendar tab.' };
    }
    const sent = await sendInvitation(db, mail, actor, appointmentId);
    return sent.status === 'sent'
      ? { invited: true, threadId: sent.threadId }
      : { invitationError: `The invitation could not be delivered${sent.error ? `: ${sent.error}` : ''}. It has a Retry in the conversation.` };
  } catch (err) {
    return { invitationError: err instanceof Error ? err.message : 'The invitation was not sent.' };
  }
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
  return afterCommit(db, actor, row, ran, deps);
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
  // A team change (ADR 0033) runs when approved: the cron has no calendar keys for a removal,
  // and a role or invite change waiting for hours is a change nobody is watching.
  if (args.tool === 'update_agent' || args.tool === 'remove_agent' || args.tool === 'invite_agent') {
    throw new AssistantError('conflict', 'A team change runs when you approve it — it cannot be set for later.');
  }
  if (args.tool === 'send_template_email' && 'batchId' in args) {
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

export type ScheduledRunReport = { ran: number; done: number; failed: number; waiting: number };

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
export async function runScheduledActions(
  db: Db,
  deps: RunDeps = {},
  now = new Date(),
  limit = 10,
  /** Only this task's steps (ADR 0040: right after its plan is approved). */
  opts: { taskId?: string } = {},
): Promise<ScheduledRunReport> {
  const report: ScheduledRunReport = { ran: 0, done: 0, failed: 0, waiting: 0 };
  for (let i = 0; i < limit; i++) {
    let row: RowT | null = null;
    let outcome: { kind: 'done'; ran: Extract<Ran, { ok: true }>; actor: Actor } | { kind: 'failed' } | { kind: 'waiting' } | null;
    try {
      outcome = await db.transaction(async (tx) => {
        // Lock one due row (another tick skips it), then move it on — both in this transaction.
        const [due] = await tx
          .select({ id: proposedAction.id })
          .from(proposedAction)
          .where(and(eq(proposedAction.status, 'scheduled'), lte(proposedAction.runAt, now), ...(opts.taskId ? [eq(proposedAction.taskId, opts.taskId)] : [])))
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
        return ran.ok ? { kind: 'done' as const, ran, actor } : ran.waiting ? { kind: 'waiting' as const } : { kind: 'failed' as const };
      });
    } catch (err) {
      // Not a refusal: the transaction rolled back, nothing happened. Fail it (guarded) so it is
      // not retried forever, with a reason the person can read.
      console.error('[assistant] scheduled action failed', err instanceof Error ? err.message : err);
      const failedId = (row as RowT | null)?.id;
      if (failedId) {
        const reason = 'It could not run because of an error on our side. Nothing was changed.';
        await db.transaction(async (tx) => {
          const [f] = await tx
            .update(proposedAction)
            .set({ status: 'failed', error: reason, finishedAt: now, updatedAt: sql`now()` })
            .where(and(eq(proposedAction.id, failedId), eq(proposedAction.status, 'scheduled')))
            .returning({ taskId: proposedAction.taskId, taskSeq: proposedAction.taskSeq });
          // A task stops at a step that could not run (ADR 0040).
          if (f?.taskId) await advanceTask(tx, f.taskId, { ok: false, error: `Step ${f.taskSeq ?? '?'}: ${reason}` }, now);
        });
        report.ran += 1;
        report.failed += 1;
        continue;
      }
      break;
    }
    if (!outcome) break;
    report.ran += 1;
    if (outcome.kind === 'waiting') {
      report.waiting += 1;
      continue;
    }
    if (outcome.kind === 'failed') {
      report.failed += 1;
      continue;
    }
    report.done += 1;
    await afterCommit(db, outcome.actor, row!, outcome.ran, deps).catch((err: unknown) => console.error('[assistant] after-run step failed', err instanceof Error ? err.message : err));
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
    // A rejected or cancelled plan takes its task with it (ADR 0040): none of its steps will run.
    if (args.tool === 'plan_task') await endTask(tx, args.taskId, 'cancelled', new Date());
    // A rejected or cancelled email card takes its prepared batch with it.
    if (args.tool === 'send_template_email' && 'batchId' in args) {
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
  return db.transaction(async (tx) => {
    const gone = await tx
      .update(proposedAction)
      .set({ status: 'expired', updatedAt: sql`now()` })
      .where(and(eq(proposedAction.status, 'proposed'), lt(proposedAction.expiresAt, now)))
      .returning({ id: proposedAction.id, args: proposedAction.args });
    // An unapproved plan that expired takes its task with it (ADR 0040).
    for (const g of gone) {
      const a = g.args as FrozenArgs;
      if (a.tool === 'plan_task') await endTask(tx, a.taskId, 'expired', now);
    }
    return gone.length;
  });
}

export type ProposalView = {
  id: string;
  tool: AssistantWriteTool;
  status: ProposalStatus;
  card: ProposalCard;
  error: string | null;
  /** Ids of what it made or changed — for links. Never model text. */
  result: { noteId?: string; appointmentId?: string; batchId?: string; dashboardId?: string; assigned?: number; recorded?: number; withdrawn?: number; changed?: string[]; claimPath?: string; emailed?: boolean; removed?: boolean; sent?: number; skipped?: number; failed?: number; sendError?: string; invited?: boolean; invitationError?: string; threadId?: string; teamThreadId?: string; told?: boolean; zoomError?: string; emailStatus?: 'sent' | 'failed' | 'sending'; emailError?: string; agentSkillId?: string; listingId?: string; inviteId?: string; status?: string; part?: number; nobodyLeft?: boolean; waiting?: string; needsConnection?: { provider: IntegrationProvider; label: string; mayConnect: boolean }[] } | null;
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
    // A team change runs when approved, never later (schedule() refuses it), so the card offers no time.
    scheduling: schedulingEnabled() && row.tool !== 'update_agent' && row.tool !== 'remove_agent' && row.tool !== 'invite_agent',
    mayDecide: waiting && can(actor, 'proposed_action:decide', actionResource(row)),
    mayCancel: (status === 'proposed' || status === 'scheduled') && can(actor, 'proposed_action:cancel', actionResource(row)),
  };
}
