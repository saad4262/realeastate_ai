import { sql } from 'drizzle-orm';
import type { Db } from '@repo/db';

/**
 * PLATFORM-PLAN section 8 (decision 4) retention, once a day: trash (deleted notes and documents) after 60 days,
 * site activity after 13 months, the model-written SQL and the dashboard requests (AI prompts) after 90 days.
 * The chat, assistant, workflow and import purges already run in the same tick. Batches of 5,000 a day each.
 * shortcut: note/document trash has no deleted_at index (a daily scan); add one if either passes ~1M rows.
 */
export const RETENTION_DAYS = { trash: 60, siteActivity: 395, aiPrompts: 90 } as const;
const BATCH = 5000;

export type RetentionReport = { notes: number; documents: number; siteActivity: number; aiQueryLog: number; dashboardRequests: number };

/** 03:00–03:04 Sydney-ish (17:00 UTC): the 5-minute tick runs it once a day. */
export function retentionDue(now: Date): boolean {
  return now.getUTCHours() === 17 && now.getUTCMinutes() < 5;
}

export async function purgeRetention(db: Db, now = new Date()): Promise<RetentionReport> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const purge = async (table: 'note' | 'document' | 'site_activity' | 'ai_query_log' | 'dashboard_gap_log', column: 'deleted_at' | 'created_at', days: number) =>
    (await db.execute(sql`
      delete from ${sql.raw(table)} where id in (
        select id from ${sql.raw(table)} where ${sql.raw(column)} < ${before(days)}::timestamptz limit ${BATCH})
      returning id`)).length;
  return {
    notes: await purge('note', 'deleted_at', RETENTION_DAYS.trash),
    // A deleted document's file went when it was deleted; this removes the hidden row.
    documents: await purge('document', 'deleted_at', RETENTION_DAYS.trash),
    siteActivity: await purge('site_activity', 'created_at', RETENTION_DAYS.siteActivity),
    aiQueryLog: await purge('ai_query_log', 'created_at', RETENTION_DAYS.aiPrompts),
    dashboardRequests: await purge('dashboard_gap_log', 'created_at', RETENTION_DAYS.aiPrompts),
  };
}
