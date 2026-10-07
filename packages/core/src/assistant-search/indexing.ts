import { inArray, sql } from 'drizzle-orm';
import { agency, searchEmbedding, type Db } from '@repo/db';
import { stripQuotedReply } from '../mail/body';
import { chunkText } from './chunk';
import { EMBEDDING_DIMENSIONS, type Embedder } from './embedder';

/**
 * Keeping `search_embedding` in step with notes, emails and enquiries
 * (ADR 0031 §4–8). Run by the cron tick and by the backfill command — never on
 * a write path, so a network call never sits inside a request or transaction.
 *
 * What may be sent to the embedding provider is decided HERE, once, in SQL
 * (`ELIGIBLE`), and the same rule prunes: a private or deleted note, anything
 * of an archived, merged or opted-out contact, a private offer and its
 * conversation, and any text that changed since it was embedded.
 */

export const SEARCH_EMBEDDING_FEATURE = 'search_embedding';
const SOURCES_PER_TICK = 24;

/** Contact `c` may have its words sent to the provider. */
const CONTACT_OK = `c.archived_at is null and c.merged_into_id is null and c.email_opt_out_at is null`;

/** Per kind: FROM … WHERE … selecting (agency_id, id, contact_id, text) of qualifying sources, as `s`. */
const ELIGIBLE = {
  note: sql.raw(`select n.agency_id, n.id, n.contact_id, n.body as text, false as inbound, n.created_at
    from note n join contact c on c.id = n.contact_id
    where n.deleted_at is null and n.is_private = false and length(trim(n.body)) > 0 and ${CONTACT_OK}`),
  email: sql.raw(`select m.agency_id, m.id, t.contact_id, m.text as text, (m.direction = 'in') as inbound, m.created_at
    from mail_message m join mail_thread t on t.id = m.thread_id join contact c on c.id = t.contact_id
    left join lead l on l.id = t.lead_id
    where l.kind is distinct from 'offer' and length(trim(coalesce(m.text, ''))) > 0 and ${CONTACT_OK}`),
  enquiry: sql.raw(`select l.agency_id, l.id, l.contact_id, l.message as text, true as inbound, l.created_at
    from lead l join contact c on c.id = l.contact_id
    where l.kind <> 'offer' and length(trim(coalesce(l.message, ''))) > 0 and ${CONTACT_OK}`),
} as const;

type Kind = keyof typeof ELIGIBLE;
const KINDS = Object.keys(ELIGIBLE) as Kind[];

/**
 * Delete every embedding whose source no longer qualifies or whose text
 * changed. Runs on every tick — even with embeddings switched off.
 */
export async function pruneSearchEmbeddings(db: Db): Promise<number> {
  let pruned = 0;
  for (const kind of KINDS) {
    const gone = await db.execute<{ id: string }>(sql`
      delete from search_embedding e
      where e.source_kind = ${kind}
        and not exists (select 1 from (${ELIGIBLE[kind]}) s where s.id = e.source_id and md5(s.text) = e.content_hash)
      returning e.id`);
    pruned += gone.length;
  }
  return pruned;
}

type Source = { kind: Kind; agency_id: string; id: string; contact_id: string; text: string; inbound: boolean };

/** Qualifying sources with no embedding of their current text, newest first. One statement. */
async function pendingSources(db: Db, limit: number): Promise<Source[]> {
  const parts = KINDS.map(
    (kind) => sql`(select ${kind}::text as kind, s.agency_id, s.id, s.contact_id, s.text, s.inbound, s.created_at
      from (${ELIGIBLE[kind]}) s
      where not exists (select 1 from search_embedding e where e.source_kind = ${kind} and e.source_id = s.id and e.content_hash = md5(s.text))
      order by s.created_at desc limit ${limit})`,
  );
  const rows = await db.execute<Source & { created_at: string }>(sql`
    select * from (${sql.join(parts, sql` union all `)}) x order by x.created_at desc limit ${limit}`);
  return rows.map((r) => ({ kind: r.kind, agency_id: r.agency_id, id: r.id, contact_id: r.contact_id, text: r.text, inbound: r.inbound === true || (r.inbound as unknown) === 't' }));
}

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Agencies whose indexing spend in the last 24 h is under
 * EMBEDDINGS_DAILY_BUDGET_USD_PER_AGENCY (default 0.25) — and none at all once
 * the platform's AI_DAILY_BUDGET_USD (default 5) is spent. One statement.
 */
async function agenciesWithinBudget(db: Db, agencyIds: string[], env: NodeJS.ProcessEnv, now: Date): Promise<Set<string>> {
  if (!agencyIds.length) return new Set();
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const perAgency = capFrom(env.EMBEDDINGS_DAILY_BUDGET_USD_PER_AGENCY, 0.25);
  const global = capFrom(env.AI_DAILY_BUDGET_USD, 5);
  // "agency"."id" spelled out: in a one-table select Drizzle renders ${agency.id} as a bare
  // "id", which inside the sub-select would mean ai_run.id — and the cap would never bite.
  const rows = await db
    .select({
      agency_id: agency.id,
      spent: sql<string>`coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = "agency"."id" and r.feature = ${SEARCH_EMBEDDING_FEATURE} and r.created_at >= ${since}), 0)`,
      total: sql<string>`coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0)`,
    })
    .from(agency)
    .where(inArray(agency.id, agencyIds));
  const ok = new Set<string>();
  for (const r of rows) if (Number(r.total) < global && Number(r.spent) < perAgency && r.agency_id) ok.add(r.agency_id);
  return ok;
}

export type EmbeddingTickReport = { enabled: boolean; pruned: number; sources: number; chunks: number; overBudget: number; failed: number };

/**
 * One batch: prune, then embed up to `limit` new or changed sources, agency by
 * agency (each call metered to its agency). The provider is called first; the
 * old chunks are replaced in one short transaction after. A failed agency is
 * counted and left for the next tick.
 */
export async function runEmbeddingTick(
  db: Db,
  embedder: Embedder | null,
  opts: { env?: NodeJS.ProcessEnv; now?: Date; limit?: number } = {},
): Promise<EmbeddingTickReport> {
  const pruned = await pruneSearchEmbeddings(db);
  const report: EmbeddingTickReport = { enabled: Boolean(embedder), pruned, sources: 0, chunks: 0, overBudget: 0, failed: 0 };
  if (!embedder) return report;

  const sources = await pendingSources(db, opts.limit ?? SOURCES_PER_TICK);
  const byAgency = new Map<string, Source[]>();
  for (const s of sources) byAgency.set(s.agency_id, [...(byAgency.get(s.agency_id) ?? []), s]);
  const allowed = await agenciesWithinBudget(db, [...byAgency.keys()], opts.env ?? process.env, opts.now ?? new Date());

  for (const [agencyId, list] of byAgency) {
    if (!allowed.has(agencyId)) {
      report.overBudget += 1;
      continue;
    }
    const planned = list.map((s) => ({ s, chunks: chunkText(s.kind === 'email' && s.inbound ? stripQuotedReply(s.text) || s.text : s.text) })).filter((p) => p.chunks.length);
    const texts = planned.flatMap((p) => p.chunks);
    if (!texts.length) continue;
    let vectors: number[][];
    try {
      vectors = await embedder.embed(texts, 'document', { feature: SEARCH_EMBEDDING_FEATURE, agencyId });
      if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) throw new Error('the provider returned the wrong number or size of vectors');
    } catch (err) {
      console.error('[search] embedding batch failed', err instanceof Error ? err.message : err);
      report.failed += 1;
      continue;
    }
    let i = 0;
    const rows = planned.flatMap((p) =>
      p.chunks.map((_, chunkIndex) => ({
        agencyId,
        sourceKind: p.s.kind,
        sourceId: p.s.id,
        contactId: p.s.contact_id,
        chunkIndex,
        contentHash: sql<string>`md5(${p.s.text})` as unknown as string,
        model: embedder.model,
        embedding: vectors[i++]!,
      })),
    );
    await db.transaction(async (tx) => {
      await tx.delete(searchEmbedding).where(inArray(searchEmbedding.sourceId, planned.map((p) => p.s.id)));
      await tx.insert(searchEmbedding).values(rows);
    });
    report.sources += planned.length;
    report.chunks += rows.length;
  }
  return report;
}
