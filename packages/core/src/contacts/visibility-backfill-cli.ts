import { config } from 'dotenv';
import { resolve } from 'node:path';
import { getDb } from '@repo/db';
import { applyVisibilityBackfill, planVisibilityBackfill } from './visibility-backfill';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * The client's visibility rule (2026-10-07) for rows that already exist. A DRY RUN by
 * default: it prints which leads and contacts would go to which agent, and changes
 * nothing. Only `--apply` writes (one transaction).
 *
 *   pnpm --filter @repo/core visibility:backfill            # dry run
 *   pnpm --filter @repo/core visibility:backfill -- --apply # writes
 */
async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = getDb(url);
  const apply = process.argv.includes('--apply');

  const plan = await planVisibilityBackfill(db);
  console.log(`${apply ? 'APPLY' : 'DRY RUN — nothing is changed'}\n`);
  console.log(`Leads to assign (${plan.leads.length}):`);
  for (const l of plan.leads) console.log(`  ${l.leadId.slice(0, 8)}  ${l.person} <${l.email}>  ${l.address}  →  ${l.agentName}`);
  console.log(`\nContacts to assign (${plan.contacts.length}):`);
  for (const c of plan.contacts) console.log(`  ${c.contactId.slice(0, 8)}  ${c.name}${c.email ? ` <${c.email}>` : ''}  →  ${c.agentName}  (${c.why})`);

  if (apply) {
    const done = await applyVisibilityBackfill(db);
    console.log(`\nDone: ${done.leads} lead(s), ${done.contacts} contact(s) assigned.`);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
