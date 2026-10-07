import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { contact, lead, mailMessage, mailThread, note, searchEmbedding, type Db } from '@repo/db';
import type { Actor } from '../permissions';
import { visibleContactIdsSql } from '../contacts/visibility';
import { noteVisibleSql } from '../contacts/notes';
import { threadScopeFilters } from '../mail/threads';
import { leadScopeFilters } from '../leads/list-leads';
import { checkAssistantBudget, ASSISTANT_FEATURE } from '../assistant/budget';
import type { Embedder } from './embedder';

/**
 * The assistant's search over notes, emails and enquiry messages (ADR 0031).
 *
 * PERMISSION IS IN THE WHERE of every statement — the screens' own rules,
 * reused, never re-implemented and never applied after the fact:
 *   notes     → the contact is one this actor may see (`visibleContactIdsSql`)
 *               and the note one they may read (`noteVisibleSql`: a private
 *               note only for its author and owners/admins), not deleted;
 *   emails    → the inbox's rule (`threadScopeFilters`; offers: owners/admins);
 *   enquiries → the lead inbox's rule (`leadScopeFilters`; offers: owners/admins);
 * always this actor's agency. Archived contacts only when that contact is
 * named. Full-text always; embeddings when an embedder is configured and the
 * person's assistant budget allows the question's embedding.
 */

export const MAX_SEARCH_RESULTS = 8;
const SNIPPET_CHARS = 200;
const RRF_K = 60;

export type SearchKind = 'note' | 'email' | 'enquiry';
export type SearchHit = { kind: SearchKind; sourceId: string; contactId: string; contactName: string; at: Date; snippet: string };

export type SearchInput = {
  query: string;
  /** Only this contact (already resolved from a reference). Archived contacts are searchable only like this. */
  contactId?: string | null;
  from?: Date | null;
  to?: Date | null;
};

export type SearchDeps = {
  embedder?: Embedder | null;
  /** Writes the ai_run row for a full-text-only search (through packages/ai). */
  trackFullText?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : flat;
}

/** The WHERE common to every kind: the contact's archive rule, the contact filter, the dates. */
function common(at: AnyPgColumn, input: SearchInput): SQL[] {
  const out: SQL[] = [];
  if (input.contactId) out.push(eq(contact.id, input.contactId));
  else out.push(isNull(contact.archivedAt));
  if (input.from) out.push(sql`${at} >= ${input.from.toISOString()}`);
  if (input.to) out.push(sql`${at} < ${input.to.toISOString()}`);
  return out;
}

const HEADLINE = 'MaxWords=24, MinWords=8, ShortWord=3, MaxFragments=1, StartSel="", StopSel=""';

/** Rows this actor may read, by kind, matching `match` (full-text or a vector order). */
function scoped(db: Db, actor: Actor, input: SearchInput) {
  const agencyId = actor.agencyId as string;
  return {
    note: (extra: SQL[]) =>
      and(
        eq(note.agencyId, agencyId),
        isNull(note.deletedAt),
        sql`${note.contactId} in (${visibleContactIdsSql(actor)})`,
        noteVisibleSql(actor),
        ...common(note.createdAt, input),
        ...extra,
      ),
    email: (extra: SQL[]) => and(...threadScopeFilters(db, actor), ...common(mailMessage.createdAt, input), ...extra),
    enquiry: (extra: SQL[]) => and(...leadScopeFilters(db, actor), ...common(lead.createdAt, input), ...extra),
  };
}

async function fullText(db: Db, actor: Actor, input: SearchInput): Promise<SearchHit[][]> {
  const tsq = sql`websearch_to_tsquery('english', ${input.query})`;
  const where = scoped(db, actor, input);
  const [notes, emails, enquiries] = await Promise.all([
    db
      .select({ id: note.id, contactId: contact.id, name: contact.name, at: note.createdAt, snippet: sql<string>`ts_headline('english', ${note.body}, ${tsq}, ${HEADLINE})` })
      .from(note)
      .innerJoin(contact, eq(contact.id, note.contactId))
      .where(where.note([sql`${note.searchTsv} @@ ${tsq}`]))
      .orderBy(desc(sql`ts_rank_cd(${note.searchTsv}, ${tsq})`), desc(note.createdAt))
      .limit(MAX_SEARCH_RESULTS),
    db
      .select({ id: mailMessage.id, contactId: contact.id, name: contact.name, at: mailMessage.createdAt, snippet: sql<string>`ts_headline('english', coalesce(${mailMessage.text}, ''), ${tsq}, ${HEADLINE})` })
      .from(mailMessage)
      .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
      .leftJoin(lead, eq(lead.id, mailThread.leadId))
      .innerJoin(contact, eq(contact.id, mailThread.contactId))
      .where(where.email([sql`${mailMessage.searchTsv} @@ ${tsq}`]))
      .orderBy(desc(sql`ts_rank_cd(${mailMessage.searchTsv}, ${tsq})`), desc(mailMessage.createdAt))
      .limit(MAX_SEARCH_RESULTS),
    db
      .select({ id: lead.id, contactId: contact.id, name: contact.name, at: lead.createdAt, snippet: sql<string>`ts_headline('english', coalesce(${lead.message}, ''), ${tsq}, ${HEADLINE})` })
      .from(lead)
      .innerJoin(contact, eq(contact.id, lead.contactId))
      .where(where.enquiry([sql`${lead.searchTsv} @@ ${tsq}`]))
      .orderBy(desc(sql`ts_rank_cd(${lead.searchTsv}, ${tsq})`), desc(lead.createdAt))
      .limit(MAX_SEARCH_RESULTS),
  ]);
  const hit = (kind: SearchKind) => (r: { id: string; contactId: string; name: string; at: Date; snippet: string }): SearchHit => ({
    kind, sourceId: r.id, contactId: r.contactId, contactName: r.name, at: new Date(r.at), snippet: snippetOf(r.snippet ?? ''),
  });
  return [notes.map(hit('note')), emails.map(hit('email')), enquiries.map(hit('enquiry'))];
}

/** Nearest chunks by cosine distance, through the SAME scoped WHERE as full-text. */
async function byVector(db: Db, actor: Actor, input: SearchInput, vector: number[]): Promise<SearchHit[][]> {
  const v = sql`${JSON.stringify(vector)}::vector`;
  const where = scoped(db, actor, input);
  // Nearest chunks first, through the SAME scoped WHERE as full-text; chunks of one source collapse below.
  const distance = sql<number>`${searchEmbedding.embedding} <=> ${v}`;
  const ofKind = (kind: SearchKind) => eq(searchEmbedding.sourceKind, kind);
  const agencyOnly = eq(searchEmbedding.agencyId, actor.agencyId as string);
  const [notes, emails, enquiries] = await Promise.all([
    db
      .select({ id: note.id, contactId: contact.id, name: contact.name, at: note.createdAt, text: note.body, d: distance })
      .from(searchEmbedding)
      .innerJoin(note, and(ofKind('note'), eq(note.id, searchEmbedding.sourceId)))
      .innerJoin(contact, eq(contact.id, note.contactId))
      .where(where.note([agencyOnly]))
      .orderBy(asc(distance))
      .limit(64),
    db
      .select({ id: mailMessage.id, contactId: contact.id, name: contact.name, at: mailMessage.createdAt, text: sql<string>`coalesce(${mailMessage.text}, '')`, d: distance })
      .from(searchEmbedding)
      .innerJoin(mailMessage, and(ofKind('email'), eq(mailMessage.id, searchEmbedding.sourceId)))
      .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
      .leftJoin(lead, eq(lead.id, mailThread.leadId))
      .innerJoin(contact, eq(contact.id, mailThread.contactId))
      .where(where.email([agencyOnly]))
      .orderBy(asc(distance))
      .limit(64),
    db
      .select({ id: lead.id, contactId: contact.id, name: contact.name, at: lead.createdAt, text: sql<string>`coalesce(${lead.message}, '')`, d: distance })
      .from(searchEmbedding)
      .innerJoin(lead, and(ofKind('enquiry'), eq(lead.id, searchEmbedding.sourceId)))
      .innerJoin(contact, eq(contact.id, lead.contactId))
      .where(where.enquiry([agencyOnly]))
      .orderBy(asc(distance))
      .limit(64),
  ]);
  const collapse = (kind: SearchKind, rows: { id: string; contactId: string; name: string; at: Date; text: string }[]): SearchHit[] => {
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ kind, sourceId: r.id, contactId: r.contactId, contactName: r.name, at: new Date(r.at), snippet: snippetOf(r.text) });
      if (out.length >= MAX_SEARCH_RESULTS) break;
    }
    return out;
  };
  return [collapse('note', notes), collapse('email', emails), collapse('enquiry', enquiries)];
}

/** Reciprocal-rank fusion of ranked lists; one entry per source; at most MAX_SEARCH_RESULTS. */
export function fuse(lists: SearchHit[][]): SearchHit[] {
  const score = new Map<string, { hit: SearchHit; s: number }>();
  for (const list of lists) {
    list.forEach((h, rank) => {
      const key = `${h.kind}:${h.sourceId}`;
      const prev = score.get(key);
      const add = 1 / (RRF_K + rank + 1);
      if (prev) prev.s += add;
      else score.set(key, { hit: h, s: add });
    });
  }
  return [...score.values()]
    .sort((a, b) => b.s - a.s || b.hit.at.getTime() - a.hit.at.getTime())
    .slice(0, MAX_SEARCH_RESULTS)
    .map((x) => x.hit);
}

export async function searchNotesAndEmails(
  db: Db,
  actor: Actor,
  input: SearchInput,
  deps: SearchDeps = {},
): Promise<{ hits: SearchHit[]; mode: 'fulltext' | 'hybrid' }> {
  if (!actor.agencyId) return { hits: [], mode: 'fulltext' };
  const text = fullText(db, actor, input);
  let vectorLists: SearchHit[][] = [];
  let mode: 'fulltext' | 'hybrid' = 'fulltext';
  if (deps.embedder) {
    // The question's embedding counts against this person's assistant caps (ADR 0031 §6).
    const budget = await checkAssistantBudget(db, actor, { env: deps.env ?? process.env });
    if (budget.allowed) {
      try {
        const [vector] = await deps.embedder.embed([input.query], 'query', { feature: ASSISTANT_FEATURE, agencyId: actor.agencyId, userId: actor.userId });
        if (vector) {
          vectorLists = await byVector(db, actor, input, vector);
          mode = 'hybrid';
        }
      } catch (err) {
        console.error('[search] query embedding failed — full-text only', err instanceof Error ? err.message : err);
      }
    }
  }
  const textLists = await text;
  if (mode === 'fulltext') await deps.trackFullText?.().catch(() => undefined);
  return { hits: fuse([...textLists, ...vectorLists]), mode };
}
