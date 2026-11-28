import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { assistantTask, emailTemplate, listing, property, proposedAction, user, workflow, workflowRun, type Db, type DbOrTx } from '@repo/db';
import { activeMemberActor } from '../team/member-actor';
import type { RunDecision } from './decide';
import { usableTemplateSql } from '../template-email/templates';
import { formatAddress } from '../listings/listing-schema';
import { can, type Actor } from '../permissions';
import { allActions, isNear, specInWords, specProblem, WORKFLOW_LIMITS, workflowSpecSchema, type SpecWords, type TriggerKind, type WorkflowScope, type WorkflowSpec } from './catalog';

/**
 * Making and managing workflows (ADR 0041 Part C, the core under the card and the screen). Every write
 * asks can(): an agent's own workflow (`workflow:create`), an agency-wide one (`workflow:create_agency`),
 * changing one (`workflow:manage`: its owner or an admin). "Delete" archives.
 */

export class WorkflowError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

const NOT_FOUND = () => new WorkflowError('not_found', 'That workflow was not found');
const UUID = /^[0-9a-f-]{36}$/i;
const resource = (w: { id?: string; agencyId: string; ownerId: string }) => ({ type: 'workflow', ...(w.id ? { id: w.id } : {}), agencyId: w.agencyId, ownerId: w.ownerId });

/**
 * Everything a spec names, checked against the database as this person: members active in the agency,
 * templates approved in the agency. Plus the catalog's own rules. Null when usable.
 */
export async function checkWorkflow(db: DbOrTx, actor: Actor, scope: WorkflowScope, raw: unknown): Promise<{ spec: WorkflowSpec } | { problem: string }> {
  if (!actor.agencyId) return { problem: 'You are not in an agency' };
  const may = scope === 'agency' ? can(actor, 'workflow:create_agency', { type: 'workflow', agencyId: actor.agencyId }) : can(actor, 'workflow:create', { type: 'workflow', agencyId: actor.agencyId });
  if (!may) return { problem: scope === 'agency' ? 'Only an owner or admin can make an agency-wide workflow' : 'You may not make workflows' };
  const parsed = workflowSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { problem: `${i?.path.join('.') || 'workflow'}: ${i?.message ?? 'not valid'}` };
  }
  const spec = parsed.data;
  const problem = specProblem(spec, scope);
  if (problem) return { problem };
  const members = new Set<string>();
  const templates = new Set<string>();
  const smsTemplates = new Set<string>();
  for (const a of allActions(spec)) {
    if (a.type === 'send_template_sms') smsTemplates.add(a.template_id);
    if (a.type === 'assign_lead' || a.type === 'assign_contact') members.add(a.to);
    if (a.type === 'message_colleagues') a.to.forEach((m) => members.add(m));
    if (a.type === 'send_template_email') templates.add(a.template_id);
  }
  const listings = new Set<string>();
  for (const c of spec.conditions) {
    if (isNear(c)) continue;
    if (c.field === 'assignee') c.values.forEach((m) => members.add(m));
    if (c.field === 'listing') c.values.forEach((l) => listings.add(l));
  }
  if (listings.size) {
    const rows = await db.select({ id: listing.id }).from(listing).where(and(eq(listing.agencyId, actor.agencyId), inArray(listing.id, [...listings])));
    if (rows.length !== listings.size) return { problem: 'A listing the workflow names is not one of the agency’s' };
  }
  if (members.size) {
    const rows = await db.execute<{ id: string }>(sql`
      select m.user_id as id from membership m
      where m.agency_id = ${actor.agencyId} and m.status = 'active' and m.user_id in (${sql.join([...members].map((m) => sql`${m}::uuid`), sql`, `)})`);
    if (rows.length !== members.size) return { problem: 'Someone the workflow names is not an active member of the agency' };
  }
  if (templates.size) {
    const rows = await db
      .select({ id: emailTemplate.id })
      .from(emailTemplate)
      .where(and(usableTemplateSql(actor), inArray(emailTemplate.id, [...templates])));
    // ADR 0043: a template the OWNER may send — the agency's, or their own.
    if (rows.length !== templates.size) return { problem: 'A template the workflow sends is not one its owner may send (the agency’s, or their own)' };
  }
  if (smsTemplates.size) {
    const rows = await db
      .select({ id: emailTemplate.id })
      .from(emailTemplate)
      .where(and(usableTemplateSql(actor, 'sms'), inArray(emailTemplate.id, [...smsTemplates])));
    if (rows.length !== smsTemplates.size) return { problem: 'An SMS template the workflow sends is not one its owner may send (the agency’s, or their own)' };
  }
  return { spec };
}

/** Names for the words: members and templates the spec names, from the database. */
export async function namesFor(db: DbOrTx, agencyId: string, spec: WorkflowSpec): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const a of allActions(spec)) {
    if (a.type === 'assign_lead' || a.type === 'assign_contact') ids.add(a.to);
    if (a.type === 'message_colleagues') a.to.forEach((m) => ids.add(m));
  }
  const listings = new Set<string>();
  for (const c of spec.conditions) {
    if (isNear(c)) continue;
    if (c.field === 'assignee') c.values.forEach((m) => ids.add(m));
    if (c.field === 'listing') c.values.forEach((l) => listings.add(l));
  }
  const tpl = allActions(spec).flatMap((a) => (a.type === 'send_template_email' || a.type === 'send_template_sms' ? [a.template_id] : []));
  const out: Record<string, string> = {};
  if (ids.size) for (const r of await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, [...ids]))) out[r.id] = r.name || r.email;
  if (listings.size) {
    const rows = await db
      .select({ id: listing.id, unit: property.unit, streetNumber: property.streetNumber, street: property.street, suburb: property.suburb, state: property.state, postcode: property.postcode })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(and(eq(listing.agencyId, agencyId), inArray(listing.id, [...listings])));
    for (const r of rows) out[r.id] = formatAddress(r);
  }
  if (tpl.length) for (const r of await db.select({ id: emailTemplate.id, name: emailTemplate.name }).from(emailTemplate).where(and(eq(emailTemplate.agencyId, agencyId), inArray(emailTemplate.id, tpl)))) out[r.id] = r.name;
  return out;
}

/** Make a workflow (on an approved card, or from the screen) — or replace one, as a new version. */
export async function saveWorkflow(
  db: DbOrTx,
  actor: Actor,
  input: { name: string; scope: WorkflowScope; spec: unknown; replaces?: string | null },
): Promise<{ id: string }> {
  const checked = await checkWorkflow(db, actor, input.scope, input.spec);
  if ('problem' in checked) throw new WorkflowError('invalid', checked.problem);
  const agencyId = actor.agencyId!;
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new WorkflowError('invalid', 'Give the workflow a name');
  if (input.replaces) {
    const old = await loadWorkflow(db, actor, input.replaces);
    if (!can(actor, 'workflow:manage', resource(old))) throw new WorkflowError('forbidden', 'Only its owner or an admin can change this workflow');
    if (old.scope !== input.scope) throw new WorkflowError('invalid', 'A workflow keeps its scope; make a new one instead');
    await db.update(workflow).set({ name, spec: checked.spec, version: sql`${workflow.version} + 1`, status: 'active', pausedReason: null, updatedAt: sql`now()` }).where(eq(workflow.id, old.id));
    return { id: old.id };
  }
  // The limits: per agent their own, per agency all of them.
  const [{ mine } = { mine: 0 }] = await db.select({ mine: count() }).from(workflow).where(and(eq(workflow.ownerId, actor.userId), eq(workflow.agencyId, agencyId), ne(workflow.status, 'archived')));
  if (input.scope === 'mine' && mine >= WORKFLOW_LIMITS.perAgent) throw new WorkflowError('limit', `You already have ${WORKFLOW_LIMITS.perAgent} workflows — archive one first`);
  const [{ all } = { all: 0 }] = await db.select({ all: count() }).from(workflow).where(and(eq(workflow.agencyId, agencyId), ne(workflow.status, 'archived')));
  if (all >= WORKFLOW_LIMITS.perAgency) throw new WorkflowError('limit', `The agency already has ${WORKFLOW_LIMITS.perAgency} workflows — archive one first`);
  const [row] = await db.insert(workflow).values({ agencyId, ownerId: actor.userId, scope: input.scope, name, spec: checked.spec }).returning({ id: workflow.id });
  return { id: row!.id };
}

async function loadWorkflow(db: DbOrTx, actor: Actor, id: string) {
  if (!actor.agencyId || !UUID.test(id)) throw NOT_FOUND();
  const [w] = await db.select().from(workflow).where(and(eq(workflow.id, id), eq(workflow.agencyId, actor.agencyId))).limit(1);
  if (!w || !can(actor, 'workflow:read', resource(w))) throw NOT_FOUND();
  return w;
}

/** Pause, resume or archive one: its owner or an admin. Resuming checks the workflow again as it stands. */
export async function setWorkflowStatus(db: DbOrTx, actor: Actor, id: string, status: 'active' | 'paused' | 'archived'): Promise<void> {
  const w = await loadWorkflow(db, actor, id);
  if (!can(actor, 'workflow:manage', resource(w))) throw new WorkflowError('forbidden', 'Only its owner or an admin can change this workflow');
  if (w.status === 'archived') throw new WorkflowError('invalid', 'This workflow is archived');
  if (status === 'active') {
    // Checked as its OWNER may run it now — an admin resuming someone's workflow does not widen it.
    const owner = w.ownerId === actor.userId ? actor : await activeMemberActor(db, w.ownerId, w.agencyId);
    if (!owner) throw new WorkflowError('invalid', 'Its owner is no longer an active member — make it again as yourself');
    const checked = await checkWorkflow(db, owner, w.scope as WorkflowScope, w.spec);
    if ('problem' in checked) throw new WorkflowError('invalid', `It cannot run as it stands: ${checked.problem}`);
  }
  await db.update(workflow).set({ status, pausedReason: null, updatedAt: sql`now()` }).where(eq(workflow.id, w.id));
}

/** What a run stopped from the chat or the Automations panel says (ADR 0106). */
export const STOPPED_BY_HAND = 'Stopped by hand, so nothing more of this run was sent.';

/** The tasks of this workflow's runs that are still going. A subquery: no ids pass through the app. */
const tasksInFlight = (db: DbOrTx, workflowId: string) =>
  db
    .select({ id: workflowRun.taskId })
    .from(workflowRun)
    .innerJoin(assistantTask, eq(assistantTask.id, workflowRun.taskId))
    .where(and(eq(workflowRun.workflowId, workflowId), inArray(assistantTask.status, ['proposed', 'active'])));

/**
 * Every step still to come of these tasks cancelled, then the tasks ended, saying why. Two statements; the caller's
 * transaction. Steps first, then the task — the order the minute tick locks them in — so a step running at that moment
 * is waited for, never deadlocked with; it finishes, and the step it would release is cancelled.
 */
async function stopTasks(db: DbOrTx, taskIds: string[], now: Date): Promise<number> {
  if (!taskIds.length) return 0;
  await db
    .update(proposedAction)
    .set({ status: 'cancelled', error: STOPPED_BY_HAND, updatedAt: sql`now()` })
    .where(and(inArray(proposedAction.taskId, taskIds), inArray(proposedAction.status, ['blocked', 'scheduled'])));
  const ended = await db
    .update(assistantTask)
    .set({ status: 'cancelled', error: STOPPED_BY_HAND, finishedAt: now, updatedAt: sql`now()` })
    .where(and(inArray(assistantTask.id, taskIds), inArray(assistantTask.status, ['proposed', 'active'])))
    .returning({ id: assistantTask.id });
  return ended.length;
}

/** How many of this workflow's runs are still going, for the card that would stop them. */
export async function countRunsInFlight(db: DbOrTx, workflowId: string): Promise<number> {
  return (await tasksInFlight(db, workflowId)).length;
}

/**
 * ADR 0106: every run of this workflow still going is stopped — what has gone stays gone, nothing more is
 * sent. Its owner or an owner/admin (`workflow:manage`, the rule for pausing it). Takes the caller's
 * transaction; the workflow itself is not paused here (the chat's "stop" pauses it as well).
 */
export async function stopWorkflowRuns(db: DbOrTx, actor: Actor, workflowId: string, now = new Date()): Promise<{ stopped: number }> {
  const w = await loadWorkflow(db, actor, workflowId);
  if (!can(actor, 'workflow:manage', resource(w))) throw new WorkflowError('forbidden', 'Only its owner or an admin can stop this workflow’s runs');
  const ids = (await tasksInFlight(db, w.id)).map((r) => r.id).filter((id): id is string => Boolean(id));
  return { stopped: await stopTasks(db, ids, now) };
}

/** ADR 0106: one run still going, stopped — the Automations panel's Stop. Same rule as stopping them all. */
export async function stopWorkflowRun(db: Db, actor: Actor, runId: string, now = new Date()): Promise<{ stopped: number }> {
  if (!actor.agencyId || !UUID.test(runId)) throw NOT_FOUND();
  const [run] = await db.select({ workflowId: workflowRun.workflowId, taskId: workflowRun.taskId }).from(workflowRun).where(and(eq(workflowRun.id, runId), eq(workflowRun.agencyId, actor.agencyId))).limit(1);
  if (!run) throw NOT_FOUND();
  const w = await loadWorkflow(db, actor, run.workflowId);
  if (!can(actor, 'workflow:manage', resource(w))) throw new WorkflowError('forbidden', 'Only its owner or an admin can stop this workflow’s runs');
  const stopped = await db.transaction((tx) => stopTasks(tx, run.taskId ? [run.taskId] : [], now));
  if (!stopped) throw new WorkflowError('invalid', 'This run has already finished');
  return { stopped };
}

/** The admin's stop button: every active workflow of the agency paused at once. */
export async function pauseAllWorkflows(db: DbOrTx, actor: Actor): Promise<number> {
  if (!actor.agencyId || !can(actor, 'workflow:create_agency', { type: 'workflow', agencyId: actor.agencyId })) {
    throw new WorkflowError('forbidden', 'Only an owner or admin can pause every workflow');
  }
  const done = await db
    .update(workflow)
    .set({ status: 'paused', pausedReason: 'Paused by an admin (pause all).', updatedAt: sql`now()` })
    .where(and(eq(workflow.agencyId, actor.agencyId), eq(workflow.status, 'active')))
    .returning({ id: workflow.id });
  return done.length;
}

/** A removed member's workflows stop (ADR 0030, ADR 0041): paused, with the reason. */
export async function pauseWorkflowsOf(db: DbOrTx, agencyId: string, userId: string): Promise<number> {
  const done = await db
    .update(workflow)
    .set({ status: 'paused', pausedReason: 'Its owner left the agency — an admin may take it over by making it again.', updatedAt: sql`now()` })
    .where(and(eq(workflow.agencyId, agencyId), eq(workflow.ownerId, userId), eq(workflow.status, 'active')))
    .returning({ id: workflow.id });
  return done.length;
}

export type WorkflowSummary = {
  /** Every step's type, in every branch (ADR 0088: which channels it sends by). */
  stepTypes: string[];
  id: string;
  name: string;
  scope: WorkflowScope;
  status: 'active' | 'paused' | 'archived';
  pausedReason: string | null;
  ownerName: string;
  mine: boolean;
  words: SpecWords;
  /** For the library's "N like this on" (ADR 0068); null when the stored spec no longer parses. */
  triggerKind: TriggerKind | null;
  decides: boolean;
  runsToday: number;
  /** ADR 0105: how its latest run went, for the AI Assistant to report; null when it never ran. */
  lastRun: { at: Date; words: string } | null;
  mayManage: boolean;
};

type LastRunRow = { at: string; run: string; error: string | null; task: string | null; why: string | null };

/** ADR 0105: a run's state in words, from the run and its task — never a count the model could get wrong. */
export function lastRunWords(r: Omit<LastRunRow, 'at'>): string {
  if (r.run === 'skipped' || r.run === 'failed') return `${r.run === 'skipped' ? 'did not run' : 'failed'}${r.error ? `: ${r.error}` : ''}`;
  switch (r.task) {
    case 'active':
      return 'running now';
    case 'done':
      return 'finished every step';
    case 'cancelled':
      return `stopped${r.why ? `: ${r.why}` : ''}`;
    case 'failed':
      return `failed${r.why ? `: ${r.why}` : ''}`;
    default:
      return r.task ? `ended (${r.task})` : 'started';
  }
}

/** This person's workflows — every one of the agency for an admin. Archived left out. */
export async function listWorkflows(db: Db, actor: Actor, now = new Date()): Promise<WorkflowSummary[]> {
  if (!actor.agencyId || !can(actor, 'workflow:read', { type: 'workflow', agencyId: actor.agencyId, ownerId: actor.userId })) return [];
  const rows = await db
    .select({
      w: workflow,
      ownerName: sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})`,
      runsToday: sql<number>`(select count(*)::int from workflow_run r where r.workflow_id = ${workflow.id} and r.created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz)`,
      // The latest run, by workflow_run_recent_idx: in this same statement, never one more per workflow.
      lastRun: sql<LastRunRow | null>`(select json_build_object('at', r.created_at, 'run', r.status, 'error', r.error, 'task', t.status, 'why', t.error)
        from workflow_run r left join assistant_task t on t.id = r.task_id where r.workflow_id = ${workflow.id} order by r.created_at desc limit 1)`,
    })
    .from(workflow)
    .innerJoin(user, eq(user.id, workflow.ownerId))
    .where(and(eq(workflow.agencyId, actor.agencyId), ne(workflow.status, 'archived')))
    .orderBy(desc(workflow.updatedAt));
  const visible = rows.filter((r) => can(actor, 'workflow:read', resource(r.w)));
  const out: WorkflowSummary[] = [];
  for (const r of visible) {
    const parsed = workflowSpecSchema.safeParse(r.w.spec);
    const words = parsed.success ? specInWords(parsed.data, await namesFor(db, r.w.agencyId, parsed.data)) : { when: '(not valid)', if: [], then: [] };
    out.push({
      id: r.w.id,
      name: r.w.name,
      scope: r.w.scope as WorkflowScope,
      status: r.w.status as WorkflowSummary['status'],
      pausedReason: r.w.pausedReason,
      ownerName: r.ownerName,
      mine: r.w.ownerId === actor.userId,
      words,
      triggerKind: parsed.success ? parsed.data.trigger.kind : null,
      decides: parsed.success && Boolean(parsed.data.decide),
      stepTypes: parsed.success ? allActions(parsed.data).map((a) => a.type) : [],
      runsToday: Number(r.runsToday),
      lastRun: r.lastRun ? { at: new Date(r.lastRun.at), words: lastRunWords(r.lastRun) } : null,
      mayManage: can(actor, 'workflow:manage', resource(r.w)),
    });
  }
  return out;
}

export type WorkflowRunView = {
  id: string;
  at: Date;
  status: string;
  error: string | null;
  /** ADR 0067: what the AI chose at the start, and why; null on a workflow with no decision. */
  decision: RunDecision | null;
  /** Who the run is for: the name its steps were made with (ADR 0106 part 3); null when it made none, or named no one. */
  who: string | null;
  /**
   * Each step in order. `at`: when it finished (done, failed, stopped), or when it is due (the next one); null for a step not yet
   * released, whose time depends on the one before — `waitHours` after it, then `window` (a wait-until's hours).
   */
  steps: { title: string; status: string; error: string | null; at: Date | null; waitHours: number; window: boolean }[];
};

type StepRow = { card: unknown; args: unknown; status: string; error: string | null; runAt: Date | null; finishedAt: Date | null };

/** A run's steps as the panel shows them, and who it is for. Pure. */
export function runSteps(rows: readonly StepRow[]): Pick<WorkflowRunView, 'who' | 'steps'> {
  const who = rows.map((s) => (s.card as { contact?: { name?: string } }).contact?.name?.trim()).find(Boolean) ?? null;
  return {
    who,
    steps: rows.map((s) => {
      const args = (s.args ?? {}) as { gapHours?: unknown; window?: unknown };
      const time = s.finishedAt ?? (s.status === 'scheduled' || s.status === 'running' ? s.runAt : null);
      return {
        title: (s.card as { title?: string }).title ?? '',
        status: s.status,
        error: s.error,
        at: time ? new Date(time) : null,
        waitHours: typeof args.gapHours === 'number' && args.gapHours > 0 ? args.gapHours : 0,
        window: Boolean(args.window),
      };
    }),
  };
}

/** One workflow's recent runs, each with its steps' outcomes — from the runs' tasks. */
export async function workflowRuns(db: Db, actor: Actor, id: string, limit = 30): Promise<WorkflowRunView[]> {
  const w = await loadWorkflow(db, actor, id);
  const runs = await db.select().from(workflowRun).where(eq(workflowRun.workflowId, w.id)).orderBy(desc(workflowRun.createdAt)).limit(limit);
  const taskIds = runs.map((r) => r.taskId).filter((t): t is string => Boolean(t));
  const steps = taskIds.length
    ? await db
        .select({ taskId: proposedAction.taskId, seq: proposedAction.taskSeq, card: proposedAction.card, args: proposedAction.args, status: proposedAction.status, error: proposedAction.error, runAt: proposedAction.runAt, finishedAt: proposedAction.finishedAt })
        .from(proposedAction)
        .where(inArray(proposedAction.taskId, taskIds))
        .orderBy(proposedAction.taskSeq)
    : [];
  return runs.map((r) => ({
    id: r.id,
    at: new Date(r.createdAt),
    status: r.status,
    error: r.error,
    decision: r.decision ?? null,
    ...runSteps(steps.filter((s) => s.taskId === r.taskId)),
  }));
}

export type WaitingDraft = { id: string; title: string; contactName: string; expiresAt: Date };

/** "Waiting for you": the drafts the person's workflows wrote, not yet approved, rejected or expired (D1). */
export async function listWaitingDrafts(db: Db, actor: Actor, now = new Date()): Promise<WaitingDraft[]> {
  if (!actor.agencyId) return [];
  const rows = await db
    .select({ id: proposedAction.id, card: proposedAction.card, expiresAt: proposedAction.expiresAt })
    .from(proposedAction)
    .where(
      and(
        eq(proposedAction.agencyId, actor.agencyId),
        eq(proposedAction.userId, actor.userId),
        eq(proposedAction.origin, 'workflow'),
        eq(proposedAction.status, 'proposed'),
        isNull(proposedAction.taskId),
        gt(proposedAction.expiresAt, now),
      ),
    )
    .orderBy(desc(proposedAction.createdAt))
    .limit(50);
  return rows.map((r) => {
    const card = r.card as { title?: string; contact?: { name?: string } };
    return { id: r.id, title: card.title ?? 'A draft email', contactName: card.contact?.name ?? '', expiresAt: new Date(r.expiresAt) };
  });
}

/** Whether a task belongs to a workflow run — the screens show such a task under its workflow, not as a plan. */
export async function isWorkflowTask(db: DbOrTx, taskId: string): Promise<boolean> {
  const [r] = await db.select({ id: workflowRun.id }).from(workflowRun).where(eq(workflowRun.taskId, taskId)).limit(1);
  return Boolean(r);
}
