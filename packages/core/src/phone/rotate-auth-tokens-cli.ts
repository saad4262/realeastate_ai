/**
 * PLATFORM-PLAN 3.10, ADR 0096: a new Auth Token for every managed Twilio subaccount (yearly, at once if
 * one may have leaked, and after an INTEGRATION_TOKEN_KEY rotation to re-save the tokens under the new key).
 * Needs the env of the database it runs on (DATABASE_URL, INTEGRATION_TOKEN_KEY, TWILIO_MASTER_*).
 *
 *   pnpm --filter @repo/core phone:rotate-auth-tokens
 *
 * Prints counts and account ids only, never a token. Safe to run again after a failure.
 */
import { assertNotProduction } from '@repo/db/production-guard';
import { config } from 'dotenv';
import { getDb } from '@repo/db';
import { phoneDepsFromEnv, rotateManagedAuthTokens } from './setup';

config({ path: '../../.env.local' });

async function main() {
  const url = process.env.DATABASE_URL;
  assertNotProduction(url);
  if (!url) throw new Error('Set DATABASE_URL first.');
  const r = await rotateManagedAuthTokens(getDb(url), phoneDepsFromEnv());
  console.log(`Managed accounts: ${r.accounts} · rotated: ${r.rotated} · failed: ${r.failed.length}`);
  for (const f of r.failed) console.log(`  account ${f.accountId}: ${f.error}`);
  process.exit(r.failed.length ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
