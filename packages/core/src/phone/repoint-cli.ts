/**
 * After a web-domain cutover (docs/DNS-CUTOVER.md): point every agency's Twilio numbers at this
 * server's webhook URLs. Needs the PRODUCTION env (DATABASE_URL, INTEGRATION_TOKEN_KEY and
 * PHONE_WEBHOOK_BASE = the new https web URL).
 *
 *   pnpm --filter @repo/core phone:repoint
 *
 * Prints counts only. Safe to run twice: it sets the same URLs again.
 */
import { config } from 'dotenv';
import { getDb } from '@repo/db';
import { phoneDepsFromEnv, repointNumberWebhooks } from './setup';

config({ path: '../../.env.local' });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL first.');
  const deps = phoneDepsFromEnv();
  if (!deps.webhookBase?.startsWith('https://')) throw new Error('PHONE_WEBHOOK_BASE must be the new https web URL.');
  const r = await repointNumberWebhooks(getDb(url), deps);
  console.log(`Agencies: ${r.agencies} · numbers re-pointed: ${r.numbers} · failed: ${r.failed.length}`);
  for (const f of r.failed) console.log(`  ${f.agencyId}: ${f.error}`);
  process.exit(r.failed.length ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
