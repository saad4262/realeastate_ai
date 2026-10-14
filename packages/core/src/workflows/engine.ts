import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { assistantTask, notification, proposedAction, workflow, workflowEvent, workflowRun, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { activeMemberActor } from '../team/member-actor';
import { activateTask } from '../assistant/task-state';
import type { FrozenArgs } from '../assistant/actions';
import type { ProposalCard } from '../assistant/schema';
import { formatAddress } from '../listings/listing-schema';
import { actionInWords, renderMerge, specProblem, WORKFLOW_LIMITS, workflowSpecSchema, type Condition, type MergeValues, type Trigger, type WorkflowSpec } from './catalog';

/**
 * The workflow engine (ADR 0041 Part B), run by the minute tick:
 *
 * 1. `lead.no_reply` is found by a scan (one statement per agency and wait) and written as events.
 * 2. Events are claimed (`FOR UPDATE SKIP LOCKED`, a short lease), matched to the agency's active
 *    workflows for that trigger, and checked: the trigger's own facts, the owner still an active
 *    member, the record within the workflow's scope (D2), every condition — against the record as it
 *    is NOW, not as the event said.
 * 3. A match makes ONE run (unique per workflow and event) whose actions are an ADR 0040 task:
 *    proposed_action steps, decided by the owner when they approved the workflow, run by
 *    `runScheduledActions` with every check that a card has — as the owner, as they are then.
 *
 * An event a workflow's own step caused (origin `workflow`) is marked done and matched to nothing.
 * Nothing here sends, writes a note or changes a lead: the steps do, later, through the screens' code.
 */

export type WorkflowTickReport = { events: number; runs: number; skipped: number; paused: number; noReplyEvents: number };

const LEASE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

type EventRow = typeof workflowEvent.$inferSelect;
type WorkflowRow = typeof workflow.$inferSelect;

/** What a run may act on and its conditions read — the record as it is now, in this agency. */
export type Facts = {
  agencyId: string;
  leadId: string | null;
  leadStatus: string | null;
  leadKind: string | null;
  leadSource: string | null;
  leadAssignee: string | null;
  leadListingId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactAssignee: string | null;
  contactRoles: string[];
  listingId: string | null;
  listingSuburb: string | null;
  listingChannel: string | null;
  listingAddress: string | null;
  appointmentId: string | null;
  appointmentType: string | null;
  appointmentAgent: string | null;
};

async function loadFacts(db: Db, ev: EventRow): Promise<Facts> {
  const id = (v: string | null) => sql`${v}::uuid`;
  const [r] = await db.execute<Record<string, unknown>>(sql`
    select l.id as lead_id, l.status::text as lead_status, l.kind::text as lead_kind, l.source as lead_source,
           l.assigned_to as lead_assignee, l.listing_id as lead_listing_id,
           c.id as contact_id, c.name as contact_name, c.assigned_to as contact_assignee,
           (select coalesce(array_agg(r.role::text), '{}') from contact_role r where r.contact_id = c.id) as contact_roles,
           li.id as listing_id, li.channel::text as listing_channel,
           p.unit, p.street_number, p.street, p.suburb, p.state, p.postcode,
           a.id as appointment_id, a.type::text as appointment_type, a.assigned_agent_id as appointment_agent
    from (select 1) one
    left join lead l on l.id = ${id(ev.leadId)} and l.agency_id = ${ev.agencyId}
    left join appointment a on a.id = ${id(ev.appointmentId)} and a.agency_id = ${ev.agencyId}
    left join contact c on c.id = coalesce(${id(ev.contactId)}, l.contact_id, a.contact_id)
      and c.agency_id = ${ev.agencyId} and c.merged_into_id is null and c.archived_at is null
    left join listing li on li.id = coalesce(${id(ev.listingId)}, l.listing_id) and li.agency_id = ${ev.agencyId}
    left join property p on p.id = li.property_id`);
  const s = (k: string) => (r?.[k] === null || r?.[k] === undefined ? null : String(r[k]));
  const roles = r?.contact_roles;
  return {
    agencyId: ev.agencyId,
    leadId: s('lead_id'),
    leadStatus: s('lead_status'),
    leadKind: s('lead_kind'),
    leadSource: s('lead_source'),
    leadAssignee: s('lead_assignee'),
    leadListingId: s('lead_listing_id'),
    contactId: s('contact_id'),
    contactName: s('contact_name'),
    contactAssignee: s('contact_assignee'),
    contactRoles: Array.isArray(roles) ? roles.map(String) : typeof roles === 'string' ? roles.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [],
    listingId: s('listing_id'),
    listingSuburb: s('suburb'),
    listingChannel: s('listing_channel'),
    listingAddress: s('suburb') ? formatAddress({ unit: s('unit'), streetNumber: s('street_number'), street: s('street'), suburb: s('suburb')!, state: s('state') ?? '', postcode: s('postcode') ?? '' }) : null,
    appointmentId: s('appointment_id'),
    appointmentType: s('appointment_type'),
    appointmentAgent: s('appointment_agent'),
  };
}

/** The trigger's own facts (`to`, `source`, `type`, `days`) agree with the event. */
export function triggerMatches(t: Trigger, data: Record<string, unknown>): boolean {
  switch (t.kind) {
    case 'lead.created':
    case 'contact.created':
      return !t.source || data.source === t.source;
    case 'lead.status_changed':
    case 'listing.status_changed':
      return data.to === t.to;
    case 'lead.no_reply':
      return Number(data.days) === t.days;
    case 'appointment.booked':
      return !t.type || data.type === t.type;
  }
}

function fieldValues(c: Condition, f: Facts): string[] {
  switch (c.field) {
    case 'listing.suburb':
      return f.listingSuburb ? [f.listingSuburb] : [];
    case 'listing.channel':
      return f.listingChannel ? [f.listingChannel] : [];
    case 'lead.kind':
      return f.leadKind ? [f.leadKind] : [];
    case 'lead.source':
      return f.leadSource ? [f.leadSource] : [];
    case 'assignee': {
      const who = f.leadId ? f.leadAssignee : f.appointmentId ? f.appointmentAgent : f.contactAssignee;
      return who ? [who] : [];
    }
    case 'contact.role':
      return f.contactRoles;
    case 'appointment.type':
      return f.appointmentType ? [f.appointmentType] : [];
  }
}

/** Every condition holds, against the record as it is now. Case does not matter (suburbs are typed by people). */
export function conditionsHold(conditions: Condition[], f: Facts): boolean {
  return conditions.every((c) => {
    const have = fieldValues(c, f).map((v) => v.trim().toLowerCase());
    const hit = c.values.some((v) => have.includes(v.trim().toLowerCase()));
    return c.op === 'not_in' ? !hit : hit;
  });
}

/**
 * Within the workflow's scope (D2): an agency-wide workflow, while its owner may still make one; a
 * personal one only for the owner's own record — a lead they may work (assigned to them, or on their
 * listing while unassigned), an appointment of theirs, a contact assigned to them, a listing they are on.
 */
export function inScope(owner: Actor, wf: { scope: string; agencyId: string }, f: Facts): boolean {
  if (wf.scope === 'agency') return can(owner, 'workflow:create_agency', { type: 'workflow', agencyId: wf.agencyId });
  if (!can(owner, 'workflow:create', { type: 'workflow', agencyId: wf.agencyId })) return false;
  if (f.leadId) return can(owner, 'lead:update', { type: 'lead', id: f.leadId, agencyId: f.agencyId, ...(f.leadAssignee ? { ownerId: f.leadAssignee } : {}), listingId: f.leadListingId });
  if (f.appointmentId) return f.appointmentAgent === owner.userId;
  if (f.contactId) return f.contactAssignee === owner.userId;
  if (f.listingId) return can(owner, 'listing:edit', { type: 'listing', id: f.listingId, agencyId: f.agencyId });
  return false;
}

type Step = { tool: FrozenArgs['tool']; args: FrozenArgs & { gapHours?: number }; card: ProposalCard; contactId: string | null };

/** The run's steps, in order — record ids from the facts, texts with their merge fields filled. A `wait` is the next step's gap. */
export function stepsFor(wf: { name: string }, spec: WorkflowSpec, f: Facts, merge: MergeValues, now: Date): Step[] | { problem: string } {
  const steps: Step[] = [];
  let gap = 0;
  for (const a of spec.actions) {
    if (a.type === 'wait') {
      gap += a.hours;
      continue;
    }
    const contactId = f.contactId;
    const needContact = () => (contactId ? null : 'the contact is archived, merged or gone');
    let args: FrozenArgs;
    switch (a.type) {
      case 'add_note':
        if (needContact()) return { problem: needContact()! };
        args = { tool: 'add_note', contactId: contactId!, body: renderMerge(a.text, merge), private: false };
        break;
      case 'set_next_action':
        if (needContact()) return { problem: needContact()! };
        args = { tool: 'set_next_action', contactId: contactId!, nextAction: renderMerge(a.text, merge), nextActionAt: new Date(now.getTime() + (gap / 24 + a.in_days) * DAY_MS).toISOString() };
        break;
      case 'remind_owner':
        args = { tool: 'remind', text: renderMerge(a.text, merge), email: a.mail_me };
        break;
      case 'set_lead_status':
        if (!f.leadId) return { problem: 'the lead is gone' };
        args = { tool: 'set_lead_status', leadId: f.leadId, status: a.to, before: f.leadStatus ?? '' };
        break;
      case 'assign_lead':
        if (!f.leadId) return { problem: 'the lead is gone' };
        args = { tool: 'assign_lead', leadId: f.leadId, to: a.to, from: f.leadAssignee };
        break;
      case 'assign_contact':
        if (needContact()) return { problem: needContact()! };
        args = { tool: 'assign_contacts', to: a.to, contactIds: [contactId!], from: { [contactId!]: f.contactAssignee } };
        break;
      case 'message_colleagues':
        args = { tool: 'message_colleagues', to: a.to, subject: renderMerge(a.subject, merge), body: renderMerge(a.body, merge) };
        break;
      case 'send_template_email':
        if (needContact()) return { problem: needContact()! };
        // An approved template (D1), prepared and checked when the step runs — consent, opt-out, limits.
        args = { tool: 'send_template_email', part: { n: 1, of: 1, list: `Workflow “${wf.name}”` }, templateId: a.template_id, contactIds: [contactId!], gapHours: 0 };
        break;
      case 'draft_email':
        if (needContact()) return { problem: needContact()! };
        args = { tool: 'draft_email', contactId: contactId!, instructions: a.instructions, workflowName: wf.name };
        break;
    }
    steps.push({
      tool: args.tool,
      args: gap > 0 ? { ...args, gapHours: gap } : args,
      card: { title: actionInWords(a), contact: { id: contactId ?? '', name: f.contactName ?? '' }, lines: [{ label: 'Workflow', value: wf.name }], notes: [] },
      contactId: ACTION_TOUCHES_CONTACT.has(a.type) ? contactId : null,
    });
    gap = 0;
  }
  return steps;
}
const ACTION_TOUCHES_CONTACT = new Set(['add_note', 'set_next_action', 'assign_contact', 'send_template_email', 'draft_email']);

/** Claim a batch of unprocessed events (a short lease, so two ticks never take the same one). */
async function claimEvents(db: Db, now: Date, limit: number): Promise<EventRow[]> {
  const stale = new Date(now.getTime() - LEASE_MS);
  return db.transaction(async (tx) => {
    const ids = await tx
      .select({ id: workflowEvent.id })
      .from(workflowEvent)
      .where(and(isNull(workflowEvent.processedAt), or(isNull(workflowEvent.claimedAt), lt(workflowEvent.claimedAt, stale))))
      .orderBy(asc(workflowEvent.occurredAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (!ids.length) return [];
    return tx.update(workflowEvent).set({ claimedAt: now }).where(inArray(workflowEvent.id, ids.map((i) => i.id))).returning();
  });
}

/** `lead.no_reply`: a buyer's message last on a lead's conversation, unanswered for N days — once per message and wait. */
export async function scanNoReply(db: Db, now: Date): Promise<number> {
  const wanted = await db.execute<{ agency_id: string; days: number }>(sql`
    select distinct agency_id, (spec->'trigger'->>'days')::int as days from workflow
    where status = 'active' and spec->'trigger'->>'kind' = 'lead.no_reply'`);
  let made = 0;
  for (const w of wanted) {
    const days = Number(w.days);
    if (!Number.isInteger(days) || days < 1 || days > 14) continue;
    // Only messages that reached the wait in the last two days: switching a workflow on never
    // floods it with every old unanswered thread.
    const rows = await db.execute<{ lead_id: string; contact_id: string | null; listing_id: string | null; message_id: string }>(sql`
      select t.lead_id, l.contact_id, l.listing_id, m.id as message_id
      from mail_thread t
      join lead l on l.id = t.lead_id and l.status <> 'closed' and l.kind <> 'offer'
      join lateral (select mm.id, mm.direction, mm.created_at from mail_message mm where mm.thread_id = t.id order by mm.created_at desc limit 1) m on true
      where t.agency_id = ${w.agency_id} and m.direction = 'in'
        and m.created_at <= ${now.toISOString()}::timestamptz - make_interval(days => ${days})
        and m.created_at > ${now.toISOString()}::timestamptz - make_interval(days => ${days + 2})
      limit 200`);
    for (const r of rows) {
      const ins = await db
        .insert(workflowEvent)
        .values({ agencyId: w.agency_id, kind: 'lead.no_reply', leadId: r.lead_id, contactId: r.contact_id, listingId: r.listing_id, origin: 'system', data: { days }, dedupeKey: `noreply:${r.lead_id}:${r.message_id}:${days}` })
        .onConflictDoNothing()
        .returning({ id: workflowEvent.id });
      made += ins.length;
    }
  }
  return made;
}

/** Pause a workflow the system can no longer run, saying why; its owner sees it on the Workflows page. */
async function pause(db: Db, wf: WorkflowRow, reason: string): Promise<void> {
  await db.update(workflow).set({ status: 'paused', pausedReason: reason, updatedAt: sql`now()` }).where(and(eq(workflow.id, wf.id), eq(workflow.status, 'active')));
}

export async function runWorkflowTick(db: Db, now = new Date(), limit = 50): Promise<WorkflowTickReport> {
  const report: WorkflowTickReport = { events: 0, runs: 0, skipped: 0, paused: 0, noReplyEvents: 0 };
  report.noReplyEvents = await scanNoReply(db, now);
  const events = await claimEvents(db, now, limit);
  const workflows = new Map<string, WorkflowRow[]>();
  const owners = new Map<string, Actor | null>();
  for (const ev of events) {
    report.events += 1;
    try {
      if (ev.origin !== 'workflow') {
        const key = `${ev.agencyId}|${ev.kind}`;
        if (!workflows.has(key)) {
          workflows.set(
            key,
            await db
              .select()
              .from(workflow)
              .where(and(eq(workflow.agencyId, ev.agencyId), eq(workflow.status, 'active'), sql`${workflow.spec}->'trigger'->>'kind' = ${ev.kind}`)),
          );
        }
        const candidates = workflows.get(key)!;
        const facts = candidates.length ? await loadFacts(db, ev) : null;
        for (const wf of candidates) {
          const r = await runOne(db, wf, ev, facts!, owners, now);
          if (r === 'run') report.runs += 1;
          else if (r === 'paused') report.paused += 1;
          else if (r === 'skipped') report.skipped += 1;
        }
      }
    } catch (err) {
      console.error('[workflow] event failed', ev.id, err instanceof Error ? err.message : err);
    }
    await db.update(workflowEvent).set({ processedAt: now }).where(eq(workflowEvent.id, ev.id));
  }
  return report;
}

async function runOne(db: Db, wf: WorkflowRow, ev: EventRow, facts: Facts, owners: Map<string, Actor | null>, now: Date): Promise<'run' | 'no' | 'skipped' | 'paused'> {
  const parsed = workflowSpecSchema.safeParse(wf.spec);
  if (!parsed.success || specProblem(parsed.data, wf.scope as 'mine' | 'agency')) {
    await pause(db, wf, 'Its steps are no longer valid — open it and save it again.');
    return 'paused';
  }
  const spec = parsed.data;
  if (!triggerMatches(spec.trigger, ev.data as Record<string, unknown>)) return 'no';
  const key = `${wf.ownerId}|${wf.agencyId}`;
  if (!owners.has(key)) owners.set(key, await activeMemberActor(db, wf.ownerId, wf.agencyId));
  const owner = owners.get(key) ?? null;
  if (!owner) {
    await pause(db, wf, 'Its owner is no longer an active member of the agency.');
    return 'paused';
  }
  if (wf.scope === 'agency' && !can(owner, 'workflow:create_agency', { type: 'workflow', agencyId: wf.agencyId })) {
    await pause(db, wf, 'Its owner is no longer an owner or admin, so it cannot act across the agency.');
    return 'paused';
  }
  if (!inScope(owner, wf, facts)) return 'no';
  if (!conditionsHold(spec.conditions, facts)) return 'no';

  // The daily cap: a runaway workflow stops for the day, and its owner is told once.
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workflowRun)
    .where(and(eq(workflowRun.workflowId, wf.id), gt(workflowRun.createdAt, new Date(now.getTime() - DAY_MS))));
  if (n >= WORKFLOW_LIMITS.runsPerDay) {
    await db
      .insert(notification)
      .values({ userId: wf.ownerId, agencyId: wf.agencyId, kind: 'workflow_limit', title: `Your workflow “${wf.name}” reached ${WORKFLOW_LIMITS.runsPerDay} runs today and is skipping the rest until tomorrow`, dedupeKey: `wfcap:${wf.id}:${now.toISOString().slice(0, 10)}` })
      .onConflictDoNothing();
    return 'skipped';
  }

  const merge: MergeValues = {
    ...(facts.contactName ? { contact_name: facts.contactName, contact_first_name: facts.contactName.trim().split(/\s+/)[0] } : {}),
    ...(facts.listingAddress ? { listing_address: facts.listingAddress } : {}),
  };
  const [ownerRow] = await db.execute<{ name: string | null; email: string }>(sql`select name, email from "user" where id = ${wf.ownerId}`);
  if (ownerRow) merge.agent_name = ownerRow.name || ownerRow.email;
  const steps = stepsFor(wf, spec, facts, merge, now);

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(workflowRun)
      .values({ workflowId: wf.id, agencyId: wf.agencyId, eventId: ev.id, status: 'problem' in steps ? 'skipped' : 'started', contactId: facts.contactId, leadId: facts.leadId, error: 'problem' in steps ? `Not run: ${steps.problem}.` : null })
      .onConflictDoNothing({ target: [workflowRun.workflowId, workflowRun.eventId] })
      .returning({ id: workflowRun.id });
    if (!run) return 'no' as const; // this event already ran for this workflow
    if ('problem' in steps) return 'skipped' as const;
    const endsAt = new Date(now.getTime() + 30 * DAY_MS);
    const [task] = await tx
      .insert(assistantTask)
      .values({ agencyId: wf.agencyId, userId: wf.ownerId, conversationId: null, title: `Workflow: ${wf.name}`.slice(0, 200), status: 'proposed', endsAt })
      .returning({ id: assistantTask.id });
    for (const [i, s] of steps.entries()) {
      await tx.insert(proposedAction).values({
        agencyId: wf.agencyId,
        userId: wf.ownerId,
        conversationId: null,
        contactId: s.contactId,
        tool: s.tool,
        args: s.args,
        card: s.card,
        status: 'blocked',
        origin: 'workflow',
        idempotencyKey: `wf:${run.id}:${i + 1}`,
        expiresAt: endsAt,
        taskId: task!.id,
        taskSeq: i + 1,
      });
    }
    // The owner decided every step when they approved the workflow; the first is due now (or after its wait).
    await activateTask(tx, task!.id, wf.ownerId, now);
    await tx.update(workflowRun).set({ taskId: task!.id }).where(eq(workflowRun.id, run.id));
    return 'run' as const;
  });
}

/** History: processed events after 30 days, runs after 90 (ADR 0041 defaults). The runs' tasks keep their own record. */
export async function purgeWorkflowHistory(db: Db, now = new Date()): Promise<{ events: number; runs: number }> {
  const events = await db.delete(workflowEvent).where(and(lt(workflowEvent.occurredAt, new Date(now.getTime() - 30 * DAY_MS)), sql`${workflowEvent.processedAt} is not null`)).returning({ id: workflowEvent.id });
  const runs = await db.delete(workflowRun).where(lt(workflowRun.createdAt, new Date(now.getTime() - 90 * DAY_MS))).returning({ id: workflowRun.id });
  return { events: events.length, runs: runs.length };
}
