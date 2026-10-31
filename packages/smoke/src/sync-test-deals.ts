import { config } from 'dotenv';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { agency, getDb } from '@repo/db';
import { runDealSync } from '@repo/core/deals';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * The minute tick's deal sync (ADR 0063 §4), for the phone test agency only — instead of calling
 * /api/cron/minute locally, which would run every agency's jobs against the shared database.
 * Idempotent: run it after each step of the BQ walk (publish, under offer, sold, withdraw).
 *
 * Usage (from packages/smoke): `pnpm exec tsx src/sync-test-deals.ts`
 */
const AGENCY_SLUG = 'phone-test-agency-20261030-dev';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing');
  const db = getDb(url);
  const [ag] = await db.select({ id: agency.id, name: agency.name }).from(agency).where(eq(agency.slug, AGENCY_SLUG)).limit(1);
  if (!ag || !ag.name.includes('Phone Test Agency')) throw new Error(`Test agency ${AGENCY_SLUG} not found — nothing run`);
  const report = await runDealSync(db, { agencyId: ag.id });
  console.log(`${ag.name}:`, report);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
