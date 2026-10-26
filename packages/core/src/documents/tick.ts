import { and, eq, sql } from 'drizzle-orm';
import { document, documentChunk, mailMessage, type Db } from '@repo/db';
import { agenciesWithinBudget, EMBEDDING_DIMENSIONS, SEARCH_EMBEDDING_FEATURE, type Embedder } from '../assistant-search';
import { chunkPages } from './chunk-pages';
import { DOCUMENT_READ_FEATURE, MAX_DOCUMENT_BYTES, documentMimeType, newDocumentKey, titleFromFilename } from './document-schema';
import { cleanPageText, extractTextLayer, visionRefusal, type DocumentReader, type ExtractVia } from './extract';
import { downloadDocumentObject, putDocumentObject } from './storage';

/**
 * The document tick (ADR 0053 §4, §5, §7), run by /api/cron/documents. Three passes, each
 * bounded, each leaving what it could not finish for the next tick:
 *
 *   1. attachments — inbound emails' files fetched from Resend and stored as documents;
 *   2. reading     — pending documents claimed (FOR UPDATE SKIP LOCKED), their words taken
 *                    (text layer, Word, plain, or the vision reader for scans and photos),
 *                    stored per page and cut into chunks;
 *   3. embedding   — chunks with no vector embedded, within the agency's indexing cap.
 *
 * Network calls (storage, Resend, the model, the embedder) happen outside every transaction.
 * A run never throws for one document: it is counted and retried, three times at most.
 */


const DOCUMENTS_PER_TICK = 4;
const MAX_ATTEMPTS = 3;
/** A claim older than this was a run that died (a timeout): it goes back in the queue. */
const STALE_MINUTES = 15;
const CHUNKS_TO_EMBED_PER_TICK = 256;
const MAIL_PER_TICK = 5;
const ATTACHMENTS_PER_MAIL = 10;
/** Older mail's attachments are not fetched (Resend's download links do not last for ever). */
const ATTACHMENT_LOOKBACK_DAYS = 7;

export type DocumentTickDeps = {
  reader: DocumentReader | null;
  embedder: Embedder | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Stop starting new documents after this long (the route's own limit is longer). */
  budgetMs?: number;
  /** Test seams. */
  download?: (key: string) => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
  put?: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
};

export type DocumentTickReport = {
  attachments: { messages: number; stored: number; skipped: number; failed: number } | { skipped: 'not_configured' };
  recovered: number;
  claimed: number;
  ready: number;
  failed: number;
  retrying: number;
  vision: number;
  chunks: number;
  embedded: number;
};

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Is this agency still under its daily cap for reading scans (and the platform under AI_DAILY_BUDGET_USD)? */
async function visionAllowed(db: Db, agencyId: string, env: NodeJS.ProcessEnv, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const [row] = await db.execute<{ agency: string; total: string }>(sql`
    select
      coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = ${agencyId} and r.feature = ${DOCUMENT_READ_FEATURE} and r.created_at >= ${since}), 0) as agency,
      coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0) as total`);
  const perAgency = capFrom(env.DOCUMENTS_VISION_DAILY_BUDGET_USD_PER_AGENCY, 1);
  const global = capFrom(env.AI_DAILY_BUDGET_USD, 5);
  return Number(row?.total ?? 0) < global && Number(row?.agency ?? 0) < perAgency;
}

type Claimed = { id: string; agency_id: string; storage_key: string; mime_type: string; size_bytes: number; uploaded_by: string | null; attempts: number };

/** Read one claimed document. Returns what happened; writes the outcome itself. */
async function readOne(db: Db, deps: DocumentTickDeps, d: Claimed, env: NodeJS.ProcessEnv, now: Date): Promise<{ outcome: 'ready' | 'failed' | 'retrying' | 'waiting'; vision: boolean; chunks: number }> {
  const fail = async (message: string, permanent: boolean) => {
    const final = permanent || d.attempts >= MAX_ATTEMPTS;
    await db
      .update(document)
      .set({ status: final ? 'failed' : 'pending', error: message, updatedAt: sql`now()` })
      .where(eq(document.id, d.id));
    return { outcome: final ? ('failed' as const) : ('retrying' as const), vision: false, chunks: 0 };
  };

  let bytes: Uint8Array;
  try {
    bytes = await (deps.download ?? downloadDocumentObject)(d.storage_key);
  } catch {
    return fail('The file could not be fetched from storage. It will be tried again.', false);
  }

  let pages: string[];
  let via: ExtractVia;
  try {
    const layer = await extractTextLayer(bytes, d.mime_type);
    if (layer.kind === 'text') {
      pages = layer.pages;
      via = layer.via;
    } else {
      const refusal = visionRefusal(d.mime_type, bytes.byteLength, layer.pageCount);
      if (refusal) return fail(refusal, true);
      if (!deps.reader) return fail('This looks like a scan or a photo, and reading those is not switched on for this platform.', true);
      if (!(await visionAllowed(db, d.agency_id, env, now))) {
        // Not a failure: today's budget is spent. Back in the queue without using an attempt.
        await db
          .update(document)
          .set({
            status: 'pending',
            attempts: sql`greatest(${document.attempts} - 1, 0)`,
            error: 'Waiting: today’s reading budget is spent. It will be read once it frees up.',
            waitingUntil: sql`now() + interval '1 hour'`,
            updatedAt: sql`now()`,
          })
          .where(eq(document.id, d.id));
        return { outcome: 'waiting', vision: false, chunks: 0 };
      }
      const read = await deps.reader.read({ bytes, mimeType: d.mime_type, documentId: d.id, agencyId: d.agency_id, userId: d.uploaded_by });
      pages = read.pages.map(cleanPageText);
      via = 'vision';
    }
  } catch (err) {
    console.error('[documents] reading failed', d.id, err instanceof Error ? err.message : err);
    return fail('The words in this file could not be read. It will be tried again.', false);
  }

  const chunks = chunkPages(pages);
  const words = pages.join('').replace(/\s+/g, '').length;
  await db.transaction(async (tx) => {
    await tx.delete(documentChunk).where(eq(documentChunk.documentId, d.id));
    if (chunks.length) {
      await tx.insert(documentChunk).values(
        chunks.map((c, chunkIndex) => ({ documentId: d.id, agencyId: d.agency_id, chunkIndex, pageFrom: c.pageFrom, pageTo: c.pageTo, text: c.text })),
      );
    }
    await tx
      .update(document)
      .set({
        status: 'ready',
        waitingUntil: null,
        error: words ? null : 'No words were found in this file. It is kept, but the assistant cannot search it.',
        extractedVia: via,
        extractedText: pages.join('\f'),
        pageCount: pages.length,
        extractedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(document.id, d.id), eq(document.status, 'extracting')));
  });
  return { outcome: 'ready', vision: via === 'vision', chunks: chunks.length };
}

/** Pass 3: vectors for chunks that have none — never for a private document or an opted-out, archived or merged contact (ADR 0031's rule). */
async function embedPendingChunks(db: Db, embedder: Embedder, env: NodeJS.ProcessEnv, now: Date): Promise<number> {
  const rows = await db.execute<{ id: string; agency_id: string; text: string }>(sql`
    select dc.id, dc.agency_id, dc.text
    from document_chunk dc
    join document d on d.id = dc.document_id
    left join contact c on c.id = d.contact_id
    where dc.embedding is null and d.status = 'ready' and d.deleted_at is null and d.is_private = false
      and (d.contact_id is null or (c.archived_at is null and c.merged_into_id is null and c.email_opt_out_at is null))
    order by dc.created_at, dc.chunk_index
    limit ${CHUNKS_TO_EMBED_PER_TICK}`);
  if (!rows.length) return 0;
  const byAgency = new Map<string, { id: string; text: string }[]>();
  for (const r of rows) byAgency.set(r.agency_id, [...(byAgency.get(r.agency_id) ?? []), { id: r.id, text: r.text }]);
  const allowed = await agenciesWithinBudget(db, [...byAgency.keys()], env, now);
  let embedded = 0;
  for (const [agencyId, list] of byAgency) {
    if (!allowed.has(agencyId)) continue;
    let vectors: number[][];
    try {
      vectors = await embedder.embed(list.map((c) => c.text), 'document', { feature: SEARCH_EMBEDDING_FEATURE, agencyId });
      if (vectors.length !== list.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) throw new Error('wrong number or size of vectors');
    } catch (err) {
      console.error('[documents] embedding failed', err instanceof Error ? err.message : err);
      continue;
    }
    await db.execute(sql`
      update document_chunk set embedding = v.e::vector, model = ${embedder.model}
      from (select unnest(${list.map((c) => c.id)}::uuid[]) as id, unnest(${vectors.map((v) => JSON.stringify(v))}::text[]) as e) v
      where document_chunk.id = v.id and document_chunk.embedding is null`);
    embedded += list.length;
  }
  return embedded;
}

type ResendAttachment = { id?: string; filename?: string | null; size?: number | null; content_type?: string | null; content_disposition?: string | null; download_url?: string | null };

/** Pass 1: an inbound email's attachments become documents on the thread's contact (ADR 0053 §7). */
export async function importMailAttachments(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; put?: DocumentTickDeps['put'] } = {},
): Promise<DocumentTickReport['attachments']> {
  const env = opts.env ?? process.env;
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return { skipped: 'not_configured' };
  const doFetch = opts.fetchImpl ?? fetch;
  const put = opts.put ?? putDocumentObject;

  const messages = await db.execute<{
    id: string;
    provider_id: string;
    agency_id: string;
    contact_id: string | null;
    lead_id: string | null;
    lead_kind: string | null;
    listing_id: string | null;
    property_id: string | null;
  }>(sql`
    select m.id, m.provider_id, m.agency_id, t.contact_id, t.lead_id, l.kind::text as lead_kind, l.listing_id, l.property_id
    from mail_message m
    join mail_thread t on t.id = m.thread_id
    left join lead l on l.id = t.lead_id
    where m.direction = 'in' and m.attachments_stored_at is null and m.provider_id is not null
      and jsonb_array_length(m.attachments) > 0
      and m.created_at > now() - make_interval(days => ${ATTACHMENT_LOOKBACK_DAYS})
    order by m.created_at
    limit ${MAIL_PER_TICK}`);

  const report = { messages: 0, stored: 0, skipped: 0, failed: 0 };
  for (const m of messages) {
    let list: ResendAttachment[];
    try {
      const res = await doFetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(m.provider_id)}/attachments`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}`);
      list = ((await res.json()) as { data?: ResendAttachment[] }).data ?? [];
    } catch (err) {
      // Left for the next tick (and dropped after the lookback): the message is not marked.
      console.error('[documents] listing attachments failed', err instanceof Error ? err.message : err);
      report.failed += 1;
      continue;
    }

    // Offers are admins' business, and so is mail to the agency's own address (no contact).
    const isPrivate = m.lead_kind === 'offer' || !m.contact_id;
    const rows: (typeof document.$inferInsert)[] = [];
    for (const a of list.slice(0, ATTACHMENTS_PER_MAIL)) {
      const name = (a.filename || 'attachment').slice(0, 255);
      const type = documentMimeType({ type: a.content_type ?? '', name });
      // Inline parts are signatures and logos, not documents.
      if (a.content_disposition === 'inline' || !type || !a.download_url || (a.size ?? 0) > MAX_DOCUMENT_BYTES) {
        report.skipped += 1;
        continue;
      }
      try {
        const res = await doFetch(a.download_url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`download ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.byteLength || bytes.byteLength > MAX_DOCUMENT_BYTES) {
          report.skipped += 1;
          continue;
        }
        const key = newDocumentKey(m.agency_id, type);
        await put(key, bytes, type);
        rows.push({
          agencyId: m.agency_id,
          scope: 'record',
          contactId: m.contact_id,
          leadId: m.lead_id,
          listingId: m.listing_id,
          propertyId: m.property_id,
          mailMessageId: m.id,
          uploadedBy: null,
          title: titleFromFilename(name),
          kind: type.startsWith('image/') ? 'photo' : 'other',
          storageKey: key,
          mimeType: type,
          sizeBytes: bytes.byteLength,
          isPrivate,
        });
      } catch (err) {
        console.error('[documents] attachment download failed', err instanceof Error ? err.message : err);
        report.failed += 1;
      }
    }
    await db.transaction(async (tx) => {
      if (rows.length) await tx.insert(document).values(rows);
      await tx.update(mailMessage).set({ attachmentsStoredAt: sql`now()` }).where(eq(mailMessage.id, m.id));
    });
    report.messages += 1;
    report.stored += rows.length;
  }
  return report;
}

export async function runDocumentTick(db: Db, deps: DocumentTickDeps): Promise<DocumentTickReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const started = Date.now();
  const budgetMs = deps.budgetMs ?? 200_000;

  const attachments = await importMailAttachments(db, { env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.put ? { put: deps.put } : {}) }).catch((err: unknown) => {
    console.error('[documents] attachment pass failed', err instanceof Error ? err.message : err);
    return { messages: 0, stored: 0, skipped: 0, failed: 1 };
  });

  const recovered = await db.execute<{ id: string }>(sql`
    update document set status = 'pending', updated_at = now()
    where status = 'extracting' and deleted_at is null and updated_at < now() - make_interval(mins => ${STALE_MINUTES})
    returning id`);

  const report: DocumentTickReport = { attachments, recovered: recovered.length, claimed: 0, ready: 0, failed: 0, retrying: 0, vision: 0, chunks: 0, embedded: 0 };

  // One at a time, so a slow scan cannot hold claims on documents another run could read.
  for (let i = 0; i < DOCUMENTS_PER_TICK && Date.now() - started < budgetMs; i += 1) {
    const [claimed] = await db.execute<Claimed>(sql`
      update document set status = 'extracting', attempts = attempts + 1, updated_at = now()
      where id = (
        select id from document
        where status = 'pending' and deleted_at is null
          -- Waiting on a spent reading budget: not again for an hour, so it cannot hold up other agencies.
          and (waiting_until is null or waiting_until <= now())
        order by created_at, id
        limit 1
        for update skip locked
      )
      returning id, agency_id, storage_key, mime_type, size_bytes, uploaded_by, attempts`);
    if (!claimed) break;
    report.claimed += 1;
    const r = await readOne(db, deps, claimed, env, now);
    if (r.outcome === 'ready') report.ready += 1;
    else if (r.outcome === 'failed') report.failed += 1;
    else report.retrying += 1;
    if (r.vision) report.vision += 1;
    report.chunks += r.chunks;
  }

  if (deps.embedder && Date.now() - started < budgetMs) {
    report.embedded = await embedPendingChunks(db, deps.embedder, env, now).catch((err: unknown) => {
      console.error('[documents] embedding pass failed', err instanceof Error ? err.message : err);
      return 0;
    });
  }
  return report;
}
