import { config } from 'dotenv';
import { resolve } from 'node:path';
import { getDb } from '@repo/db';
import { runEmbeddingTick } from '@repo/core/assistant-search';
import { embedderFromEnv } from './voyage';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Embed every existing note, email and enquiry that qualifies (ADR 0031), in
 * the same metered batches as the cron tick, until nothing is left or a
 * budget cap stops it. Needs EMBEDDINGS_PROVIDER=voyage and VOYAGE_API_KEY;
 * without them it only prunes, and says so.
 *
 *   pnpm --filter @repo/ai search:backfill
 */
async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = getDb(url);
  const embedder = embedderFromEnv(db);
  if (!embedder) console.log('Embeddings are off (EMBEDDINGS_PROVIDER / VOYAGE_API_KEY not set): pruning only.');
  let sources = 0;
  let chunks = 0;
  for (let round = 1; round <= 500; round++) {
    const r = await runEmbeddingTick(db, embedder, { limit: 50 });
    sources += r.sources;
    chunks += r.chunks;
    console.log(`round ${round}: pruned ${r.pruned}, embedded ${r.sources} sources (${r.chunks} chunks), over budget ${r.overBudget}, failed ${r.failed}`);
    if (!embedder || r.sources === 0) break;
  }
  console.log(`Done: ${sources} sources, ${chunks} chunks.`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
