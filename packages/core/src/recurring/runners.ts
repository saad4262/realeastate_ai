import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { checkEmailLimits } from '../email/limits';
import { approveBatch, classifyRecipients, storePreparedBatch } from '../template-email/batches';
import { sendBatch, type TemplateSendDeps } from '../template-email/send';
import { TemplateEmailError } from '../template-email/templates';
import { inSmsHours, loadSmsRules, nextSmsTime } from '../phone/sms-rules';
import { approveSmsBatch, classifySmsRecipients, SMS_BATCH_MAX, sendSmsBatch, storePreparedSmsBatch, type SmsSendDeps } from '../template-email/sms-batches';
import { AUTOMATION_LIMITS, bulkEmailSpecSchema, bulkSmsSpecSchema, type AutomationKind } from './kinds';

/** What a tick needs from the outside. Null: that channel is not set up on this server. */
export type RunnerDeps = { templateSend: TemplateSendDeps | null; sms: SmsSendDeps | null };

/** `stop`: end the run, saying why. `retryAt`: this slice is not due yet; nothing was sent, try it again then. */
export type ChunkResult = { sent: number; failed: number; skipped: number; stop?: string; retryAt?: Date };

/** Who a run is for, and how to send them a slice. Every slice checks consent and limits again, as the person, now. */
export type AutomationRunner = {
  people(db: Db, actor: Actor, spec: unknown, deps: RunnerDeps): Promise<{ contactIds: string[]; skipped: number } | { stop: string }>;
  chunkSize(deps: RunnerDeps): number;
  send(db: Db, actor: Actor, spec: unknown, contactIds: string[], deps: RunnerDeps, now: Date): Promise<ChunkResult>;
};

const NOT_SET_UP = 'Email is not set up on this server, so nothing was sent.';

const bulkEmail: AutomationRunner = {
  async people(db, actor, raw, deps) {
    if (!deps.templateSend) return { stop: NOT_SET_UP };
    const spec = bulkEmailSpecSchema.parse(raw);
    try {
      const c = await classifyRecipients(db, actor, { templateId: spec.templateId, filterId: spec.filterId }, { ...deps.templateSend.limits, perBatch: AUTOMATION_LIMITS.peoplePerRun });
      const going = c.recipients.filter((r) => r.status === 'queued');
      return { contactIds: going.map((r) => r.contactId), skipped: c.recipients.length - going.length };
    } catch (err) {
      if (err instanceof TemplateEmailError) return { stop: err.message };
      throw err;
    }
  },
  chunkSize: (deps) => deps.templateSend?.limits.perBatch ?? 20,
  async send(db, actor, raw, contactIds, deps, now) {
    if (!deps.templateSend) return { sent: 0, failed: 0, skipped: 0, stop: NOT_SET_UP };
    const limits = deps.templateSend.limits;
    const spec = bulkEmailSpecSchema.parse(raw);
    try {
      const c = await classifyRecipients(db, actor, { templateId: spec.templateId, contactIds }, limits);
      const toSend = c.recipients.filter((r) => r.status === 'queued').length;
      if (!toSend) return { sent: 0, failed: 0, skipped: contactIds.length };
      const check = await checkEmailLimits(db, { agencyId: c.agencyId, userId: actor.userId }, limits, toSend);
      if (!check.ok) return { sent: 0, failed: 0, skipped: 0, stop: `Stopped at today’s email limit. ${check.reason ?? ''}`.trim() };
      const { id } = await storePreparedBatch(db, actor, c, now);
      await approveBatch(db, actor, id, limits, now);
      const report = await sendBatch(db, deps.templateSend, id);
      return { sent: report.sent, failed: report.failed, skipped: report.skipped + contactIds.length - toSend };
    } catch (err) {
      if (err instanceof TemplateEmailError) return { sent: 0, failed: 0, skipped: 0, stop: err.message };
      throw err;
    }
  },
};

const SMS_NOT_SET_UP = 'SMS is not set up on this server, so nothing was sent.';

const bulkSms: AutomationRunner = {
  async people(db, actor, raw, deps) {
    if (!deps.sms) return { stop: SMS_NOT_SET_UP };
    const spec = bulkSmsSpecSchema.parse(raw);
    try {
      const c = await classifySmsRecipients(db, actor, { templateId: spec.templateId, filterId: spec.filterId, maxPeople: AUTOMATION_LIMITS.peoplePerRun }, deps.sms.env);
      const going = c.recipients.filter((r) => r.status === 'queued');
      return { contactIds: going.map((r) => r.contactId), skipped: c.recipients.length - going.length };
    } catch (err) {
      if (err instanceof TemplateEmailError) return { stop: err.message };
      throw err;
    }
  },
  chunkSize: () => SMS_BATCH_MAX,
  async send(db, actor, raw, contactIds, deps, now) {
    if (!deps.sms) return { sent: 0, failed: 0, skipped: 0, stop: SMS_NOT_SET_UP };
    const spec = bulkSmsSpecSchema.parse(raw);
    try {
      // Outside the sending hours nothing is prepared: the slice comes back when they open.
      const rules = await loadSmsRules(db, actor.agencyId as string);
      if (!inSmsHours(now, rules.hours, rules.timeZone)) return { sent: 0, failed: 0, skipped: 0, retryAt: nextSmsTime(now, rules.hours, rules.timeZone) };
      const c = await classifySmsRecipients(db, actor, { templateId: spec.templateId, contactIds }, deps.sms.env);
      const toSend = c.recipients.filter((r) => r.status === 'queued').length;
      if (!toSend) return { sent: 0, failed: 0, skipped: contactIds.length };
      const { id } = await storePreparedSmsBatch(db, actor, c, now);
      await approveSmsBatch(db, actor, id, now);
      const report = await sendSmsBatch(db, deps.sms, id);
      return { sent: report.sent, failed: report.failed, skipped: report.skipped + contactIds.length - toSend };
    } catch (err) {
      if (err instanceof TemplateEmailError) return { sent: 0, failed: 0, skipped: 0, stop: err.message };
      throw err;
    }
  },
};

export const AUTOMATION_RUNNERS: Readonly<Record<AutomationKind, AutomationRunner>> = Object.freeze({ bulk_email: bulkEmail, bulk_sms: bulkSms });
