import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { contact, document, documentChunk, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { checkAssistantBudget, ASSISTANT_FEATURE } from '../assistant/budget';
import type { Embedder } from '../assistant-search/embedder';
import { documentScopeFilters } from './visibility';
import type { DocumentKind, DocumentScope } from './document-schema';

/**
 * The assistant's search over documents (ADR 0053 §6): chunks of documents this actor may see —
 * the visibility rule is in the WHERE of both statements, never applied afterwards. Full-text
 * always; nearest chunks by meaning too when an embedder is configured and the person's
 * assistant budget allows the question's embedding. Fused by reciprocal rank, one hit per
 * document (its best chunk), at most MAX_DOCUMENT_RESULTS.
 */

export const MAX_DOCUMENT_RESULTS = 6;
const SNIPPET_CHARS = 280;
const RRF_K = 60;

export type DocumentHit = {
  documentId: string;
  title: string;
  kind: DocumentKind;
  scope: DocumentScope;
  contactId: string | null;
  contactName: string | null;
  pageFrom: number;
  pageTo: number;
  snippet: string;
  at: Date;
};

export type DocumentSearchInput = {
  query: string;
  /** Only this contact's documents (already resolved from a reference). */
  contactId?: string | null;
  /** Only the knowledge base. */
  knowledgeOnly?: boolean;
};

export type DocumentSearchDeps = { embedder?: Embedder | null; env?: NodeJS.ProcessEnv };

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : flat;
}

const HEADLINE = 'MaxWords=40, MinWords=12, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … ", StartSel="", StopSel=""';

function where(actor: Actor, input: DocumentSearchInput, extra: SQL[]): SQL | undefined {
  const filters = [...documentScopeFilters(actor), eq(document.status, 'ready'), ...extra];
  if (input.knowledgeOnly) filters.push(eq(document.scope, 'knowledge'));
  if (input.contactId) filters.push(eq(document.contactId, input.contactId));
  return and(...filters);
}

const columns = {
  documentId: document.id,
  title: document.title,
  kind: document.kind,
  scope: document.scope,
  contactId: document.contactId,
  contactName: contact.name,
  pageFrom: documentChunk.pageFrom,
  pageTo: documentChunk.pageTo,
  at: document.createdAt,
};

type Row = { documentId: string; title: string; kind: string; scope: string; contactId: string | null; contactName: string | null; pageFrom: number; pageTo: number; at: Date; text: string };

function toHit(r: Row): DocumentHit {
  return {
    documentId: r.documentId,
    title: r.title,
    kind: r.kind as DocumentKind,
    scope: r.scope as DocumentScope,
    contactId: r.contactId,
    contactName: r.contactName,
    pageFrom: r.pageFrom,
    pageTo: r.pageTo,
    snippet: snippetOf(r.text),
    at: new Date(r.at),
  };
}

/** Best chunk per document, in rank order. */
function collapse(rows: Row[]): DocumentHit[] {
  const seen = new Set<string>();
  const out: DocumentHit[] = [];
  for (const r of rows) {
    if (seen.has(r.documentId)) continue;
    seen.add(r.documentId);
    out.push(toHit(r));
    if (out.length >= MAX_DOCUMENT_RESULTS) break;
  }
  return out;
}

export function fuseDocumentHits(lists: DocumentHit[][]): DocumentHit[] {
  const score = new Map<string, { hit: DocumentHit; s: number }>();
  for (const list of lists) {
    list.forEach((h, rank) => {
      const prev = score.get(h.documentId);
      const add = 1 / (RRF_K + rank + 1);
      if (prev) prev.s += add;
      else score.set(h.documentId, { hit: h, s: add });
    });
  }
  return [...score.values()]
    .sort((a, b) => b.s - a.s || b.hit.at.getTime() - a.hit.at.getTime())
    .slice(0, MAX_DOCUMENT_RESULTS)
    .map((x) => x.hit);
}

export async function searchDocuments(
  db: Db,
  actor: Actor,
  input: DocumentSearchInput,
  deps: DocumentSearchDeps = {},
): Promise<{ hits: DocumentHit[]; mode: 'fulltext' | 'hybrid' }> {
  if (!actor.agencyId) return { hits: [], mode: 'fulltext' };
  const tsq = sql`websearch_to_tsquery('english', ${input.query})`;
  const text = db
    .select({ ...columns, text: sql<string>`ts_headline('english', ${documentChunk.text}, ${tsq}, ${HEADLINE})` })
    .from(documentChunk)
    .innerJoin(document, eq(document.id, documentChunk.documentId))
    .leftJoin(contact, eq(contact.id, document.contactId))
    .where(where(actor, input, [sql`${documentChunk.searchTsv} @@ ${tsq}`]))
    .orderBy(desc(sql`ts_rank_cd(${documentChunk.searchTsv}, ${tsq})`), desc(document.createdAt), asc(documentChunk.chunkIndex))
    .limit(48);

  let vectorHits: DocumentHit[] = [];
  let mode: 'fulltext' | 'hybrid' = 'fulltext';
  if (deps.embedder) {
    const budget = await checkAssistantBudget(db, actor, { env: deps.env ?? process.env });
    if (budget.allowed) {
      try {
        const [vector] = await deps.embedder.embed([input.query], 'query', { feature: ASSISTANT_FEATURE, agencyId: actor.agencyId, userId: actor.userId });
        if (vector) {
          const distance = sql<number>`${documentChunk.embedding} <=> ${JSON.stringify(vector)}::vector`;
          const rows = await db
            .select({ ...columns, text: documentChunk.text })
            .from(documentChunk)
            .innerJoin(document, eq(document.id, documentChunk.documentId))
            .leftJoin(contact, eq(contact.id, document.contactId))
            .where(where(actor, input, [sql`${documentChunk.embedding} is not null`, eq(documentChunk.agencyId, actor.agencyId)]))
            .orderBy(asc(distance))
            .limit(48);
          vectorHits = collapse(rows);
          mode = 'hybrid';
        }
      } catch (err) {
        console.error('[documents] query embedding failed — full-text only', err instanceof Error ? err.message : err);
      }
    }
  }
  const textHits = collapse(await text);
  return { hits: fuseDocumentHits([textHits, vectorHits]), mode };
}
