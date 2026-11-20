/**
 * PLATFORM-PLAN 3.8: after an outage longer than the tick's 2-hour look-back, fill in the texts and calls that came
 * in to every number while we were down. Needs the env of the database it runs on (DATABASE_URL,
 * INTEGRATION_TOKEN_KEY). Safe to run twice: what is already kept is skipped by Twilio's SID.
 *
 *   pnpm --filter @repo/core phone:pull-inbound 12      (hours to look back, 1–72)
 *
 * Prints counts and number ids only.
 */
import { assertNotProduction } from '@repo/db/production-guard';
import { config } from 'dotenv';
import { getDb } from '@repo/db';
import { phoneDepsFromEnv } from './setup';
import { pullInbound } from './pull-inbound';

config({ path: '../../.env.local' });

async function main() {
  const url = process.env.DATABASE_URL;
  assertNotProduction(url);
  if (!url) throw new Error('Set DATABASE_URL first.');
  const hours = Number(process.argv[2]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw new Error('Give the hours to look back, 1–72: phone:pull-inbound 12');
  const r = await pullInbound(getDb(url), phoneDepsFromEnv(), new Date(Date.now() - hours * 3_600_000));
  console.log(`Numbers: ${r.numbers} · texts kept: ${r.texts} · missed calls kept: ${r.calls} · failed: ${r.failed.length}`);
  for (const f of r.failed) console.log(`  number ${f.numberId}: ${f.error}`);
  process.exit(r.failed.length ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
