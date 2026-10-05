import { config } from 'dotenv';
import { resolve } from 'node:path';
import { getDb } from '@repo/db';
import { backfillContacts } from './backfill';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Link every existing lead and conversation to a contact (ADR 0018).
 *
 *   pnpm --filter @repo/core contacts:backfill            # dry run: report, change nothing
 *   pnpm --filter @repo/core contacts:backfill --apply    # do it
 *
 * The dry run performs the real writes in a transaction and rolls it back, so
 * its numbers are exactly what --apply will do. Re-running is harmless.
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = getDb(url);
  const report = await backfillContacts(db, { apply });

  console.log(apply ? '\nApplied.\n' : '\nDRY RUN — nothing was changed. Run with --apply to do it.\n');
  for (const a of report.agencies) {
    console.log(
      `${a.agencyName}: contacts ${a.contactsBefore} → ${a.contactsAfter}, ` +
        `leads linked ${a.leadsLinked}, conversations linked ${a.threadsLinked}, roles tagged ${a.rolesAdded}`,
    );
  }
  if (report.possibleDuplicates.length) {
    console.log('\nPossible duplicates (same phone, different contact — NOT merged):');
    for (const d of report.possibleDuplicates) console.log(`  ${d.agencyName}: ${d.names.join(' / ')} (${d.phoneKey})`);
  } else {
    console.log('\nNo possible duplicates.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
