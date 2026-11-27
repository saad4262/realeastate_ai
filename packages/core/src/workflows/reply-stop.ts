import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';

/** What a stopped step and its task say (ADR 0103). */
export const STOPPED_BY_REPLY = 'Stopped: they emailed or texted back, so nothing more of this run was sent.';

/**
 * ADR 0103: has the person this workflow step's run is about replied since the run was made — an inbound
 * email on their (or the lead's) conversation, or an inbound text from them, in the same agency? False
 * when the workflow carries on after a reply, or the run has nobody to reply. One statement.
 */
export async function repliedSinceRun(tx: DbOrTx, taskId: string): Promise<boolean> {
  const [r] = await tx.execute<{ replied: boolean }>(sql`
    select (
      exists (
        select 1 from mail_thread t join mail_message m on m.thread_id = t.id
        where t.agency_id = r.agency_id and (t.contact_id = r.contact_id or t.lead_id = r.lead_id)
          and m.direction = 'in' and m.created_at > r.created_at
      )
      or exists (
        select 1 from sms_message s
        where s.agency_id = r.agency_id and s.contact_id = r.contact_id and s.direction = 'in' and s.created_at > r.created_at
      )
    ) as replied
    from workflow_run r join workflow w on w.id = r.workflow_id
    where r.task_id = ${taskId}
      and coalesce(w.spec->>'stop_on_reply', 'true') <> 'false'
      and (r.contact_id is not null or r.lead_id is not null)
    limit 1`);
  return r?.replied === true;
}
