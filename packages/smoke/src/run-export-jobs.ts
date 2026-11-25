/**
 * ADR 0101: run the full-export jobs on DEV now, through the real queue (bulk lane), real Storage and, with
 * `--mail`, the real email — without the whole minute tick, which would also run every other due job on dev.
 * `--expire-in-hours=N` instead sweeps as if N hours had passed. Prints one JSON line: what ran and what was sent.
 * Used by the e2e data-export spec; never against production (the guard refuses).
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { assertNotProduction } from '@repo/db/production-guard';
import { getDb } from '@repo/db';
import { runJobs } from '@repo/core/jobs';
import { EXPORT_JOB_KIND, expireExports, exportJobHandler, realExportDeps } from '@repo/core/exports';
import { noticeMailFromEnv } from '@repo/core/email';

config({ path: resolve(process.cwd(), '../../.env.local') });
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
assertNotProduction(url);

async function main() {
  const db = getDb(url!);
  const expire = process.argv.find((a) => a.startsWith('--expire-in-hours='));
  if (expire) {
    const hours = Number(expire.split('=')[1]);
    const r = await expireExports(db, { ...realExportDeps(), now: () => new Date(Date.now() + hours * 3_600_000) });
    console.log(JSON.stringify(r));
    return;
  }
  const sent: { id: string; to: string }[] = [];
  const notice = process.argv.includes('--mail') ? noticeMailFromEnv() : null;
  if (process.argv.includes('--mail') && !notice) throw new Error('Resend is not configured');
  const wrapped = notice && {
    ...notice,
    mailer: {
      ...notice.mailer,
      transport: {
        send: async (m: Parameters<typeof notice.mailer.transport.send>[0]) => {
          const r = await notice.mailer.transport.send(m);
          if (!r.ok) throw new Error(`Resend refused: ${JSON.stringify(r)}`);
          sent.push({ id: r.id, to: m.to.email });
          return r;
        },
      },
    },
  };
  const handler = exportJobHandler(realExportDeps(wrapped ?? undefined));
  let rounds = 0;
  for (; rounds < 80; rounds += 1) {
    const r = await runJobs(db, { [EXPORT_JOB_KIND]: handler }, { lane: 'bulk', limit: 5, perAgency: 5 });
    if (r.dead) throw new Error('an export job died');
    if (!r.claimed) break;
  }
  console.log(JSON.stringify({ rounds, sent }));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
