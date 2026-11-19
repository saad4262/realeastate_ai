import { and, eq, inArray, sql } from 'drizzle-orm';
import { agency, auditLog, document, listing, listingAgent, type Db, type DbOrTx } from '@repo/db';
import { recordAudit } from '../audit';
import { deleteDocumentObject, downloadDocumentObject } from '../documents/storage';

/**
 * ADR 0093 (PLATFORM-PLAN 5.12): an agency that leaves is closed (suspended, audited), exported, and deleted by
 * script no sooner than 30 days later. Listings move to an archive agency so buyers' shortlists and notes and the
 * address's history survive; everything else cascades with the agency row.
 */
export const CLOSURE_MIN_DAYS = 30;
export const ARCHIVE_AGENCY_SLUG = 'archived-listings';

/** Tables with an agency_id that are not the agency's to take away: platform records, derived data, consumers'. */
export const EXPORT_EXCLUDED: Record<string, 'platform' | 'derived' | 'consumers'> = {
  job: 'platform',
  platform_action: 'platform',
  platform_view_log: 'platform',
  platform_email: 'platform',
  ai_query_ticket: 'platform',
  ai_credit_hold: 'platform',
  search_embedding: 'derived',
  document_chunk: 'derived',
  site_activity: 'consumers',
};

/** Secret columns dropped from the export. A column that looks secret and is not here stops the export. */
export const EXPORT_REDACTED: Record<string, string[]> = {
  agent_invite: ['token'],
  integration_account: ['access_token_enc', 'refresh_token_enc'],
  phone_account: ['api_key_secret', 'sip_password'],
};
const LOOKS_SECRET = /(^|_)(token|secret|password)$|_enc$/;

/**
 * Tables without an agency_id that hang off one that has it: exported through the parent, or (null) not the
 * agency's — another person's data, a platform record, or derived. A child table in neither list stops the export.
 */
export const CHILD_TABLES: Record<string, { parent: string; column: string } | null> = {
  assistant_turn: { parent: 'assistant_conversation', column: 'conversation_id' },
  contact_property: { parent: 'contact', column: 'contact_id' },
  contact_role: { parent: 'contact', column: 'contact_id' },
  email_batch_recipient: { parent: 'email_batch', column: 'batch_id' },
  listing_agent: { parent: 'listing', column: 'listing_id' },
  listing_import_row: { parent: 'listing_import', column: 'import_id' },
  mail_read: { parent: 'mail_thread', column: 'thread_id' },
  media: { parent: 'listing', column: 'listing_id' },
  team_member: { parent: 'team', column: 'team_id' },
  team_thread_member: { parent: 'team_thread', column: 'thread_id' },
  automation_event: null, // a member's own automation log
  guide_message: null, // the public guide's chats with consumers
  inspection: null, // a buyer's
  inspection_note: null, // a buyer's
  mail_customer_read: null, // a consumer's read receipt
  media_embedding: null, // derived
  platform_email_recipient: null, // platform
  property_watch: null, // a buyer's
  property_watch_event: null, // a buyer's
  shortlist: null, // a buyer's
};

const NAME = /^[a-z_][a-z0-9_]*$/;
const safe = (n: string) => {
  if (!NAME.test(n)) throw new Error(`Unexpected table or column name: ${n}`);
  return n;
};
const ident = (n: string) => sql.raw(`"${safe(n)}"`);
const textList = (names: string[]) => sql.join(names.map((n) => sql`${n}`), sql`, `);

export type Catalog = { direct: string[]; children: { table: string; parent: string; column: string }[]; secretColumns: { table: string; column: string }[] };

/** What the database holds today: tables with an agency_id, their child tables, and columns that look secret. */
export async function agencyCatalog(db: DbOrTx): Promise<Catalog> {
  const direct = (await db.execute<{ t: string }>(sql`
    select table_name::text as t from information_schema.columns
    where table_schema = 'public' and column_name = 'agency_id' order by 1`)).map((r) => r.t);
  const children = (await db.execute<{ child: string; parent: string; col: string }>(sql`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, a.attname::text as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and c.confrelid::regclass::text in (${textList(direct)}) and c.conrelid::regclass::text not in (${textList(direct)})
    order by 1, 2, 3`)).map((r) => ({ table: r.child, parent: r.parent, column: r.col }));
  const secretColumns = (await db.execute<{ t: string; c: string }>(sql`
    select table_name::text as t, column_name::text as c from information_schema.columns
    where table_schema = 'public' and table_name in (${textList(direct)})`))
    .filter((r) => LOOKS_SECRET.test(r.c))
    .map((r) => ({ table: r.t, column: r.c }));
  return { direct, children, secretColumns };
}

/** Every table and secret column decided on: empty when the code's lists cover the database. */
export function unclassified(cat: Catalog): string[] {
  const out: string[] = [];
  for (const c of cat.children) if (!(c.table in CHILD_TABLES)) out.push(`child table ${c.table} (of ${c.parent}) is neither exported nor excluded`);
  for (const s of cat.secretColumns) {
    if (s.table in EXPORT_EXCLUDED || EXPORT_REDACTED[s.table]?.includes(s.column)) continue;
    out.push(`${s.table}.${s.column} looks secret and is not redacted`);
  }
  return out;
}

export type ExportSink = { rows(table: string, rows: unknown[]): Promise<void>; file?(key: string, bytes: Uint8Array): Promise<void> };
export type ExportReport = { tables: Record<string, number>; files: number; filesFailed: string[] };

/**
 * The agency's rows, one call of `sink.rows` per table, and its document files when `sink.file` is given.
 * shortcut: each table is read whole, fine at V1 sizes; page it when one agency passes ~100k rows in a table.
 */
export async function exportAgency(db: Db, agencyId: string, sink: ExportSink, download = downloadDocumentObject): Promise<ExportReport> {
  const cat = await agencyCatalog(db);
  const gaps = unclassified(cat);
  if (gaps.length) throw new Error(`Export refused until these are classified (agency-closure.ts): ${gaps.join('; ')}`);
  const report: ExportReport = { tables: {}, files: 0, filesFailed: [] };
  for (const t of cat.direct.filter((t) => !(t in EXPORT_EXCLUDED))) {
    const drop = EXPORT_REDACTED[t] ?? [];
    const rows = await db.execute<{ r: unknown }>(sql`select to_jsonb(x) - ${sql.raw(`'{${drop.map(safe).join(',')}}'`)}::text[] as r from ${ident(t)} x where x.agency_id = ${agencyId}`);
    report.tables[t] = rows.length;
    await sink.rows(t, rows.map((r) => r.r));
  }
  for (const c of cat.children) {
    const via = CHILD_TABLES[c.table];
    if (!via || via.parent !== c.parent || via.column !== c.column) continue;
    const rows = await db.execute<{ r: unknown }>(sql`
      select to_jsonb(x) as r from ${ident(c.table)} x join ${ident(c.parent)} p on p.id = x.${ident(c.column)} where p.agency_id = ${agencyId}`);
    report.tables[c.table] = rows.length;
    await sink.rows(c.table, rows.map((r) => r.r));
  }
  if (sink.file) {
    const keys = await db.select({ key: document.storageKey }).from(document).where(and(eq(document.agencyId, agencyId), sql`${document.deletedAt} is null`));
    for (const { key } of keys) {
      try {
        await sink.file(key, await download(key));
        report.files += 1;
      } catch {
        report.filesFailed.push(key);
      }
    }
  }
  return report;
}

/** Close: suspended at once (no sign-in, no sends), and the date recorded. Reversible until deletion. */
export async function closeAgency(db: Db, agencyId: string, by: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [done] = await tx.update(agency).set({ status: 'suspended', updatedAt: sql`now()` }).where(eq(agency.id, agencyId)).returning({ id: agency.id });
    if (!done) throw new Error('No such agency');
    await recordAudit(tx, { agencyId, actorUserId: null, action: 'agency_closed', detail: { by } });
  });
}

export type DeleteReport = { listingsArchived: number; filesDeleted: number; filesFailed: string[] };

/** Delete a closed agency: refused unless suspended, closed at least `minDays` ago, and named by its slug. */
export async function deleteAgency(
  db: Db,
  agencyId: string,
  opts: { confirmSlug: string; now?: Date; minDays?: number; deleteFile?: (key: string) => Promise<boolean> },
): Promise<DeleteReport> {
  const now = opts.now ?? new Date();
  const minDays = opts.minDays ?? CLOSURE_MIN_DAYS;
  const [a] = await db.select({ slug: agency.slug, status: agency.status }).from(agency).where(eq(agency.id, agencyId)).limit(1);
  if (!a) throw new Error('No such agency');
  if (a.slug === ARCHIVE_AGENCY_SLUG) throw new Error('The archive agency is never deleted');
  if (a.slug !== opts.confirmSlug) throw new Error('The confirmation does not name this agency');
  if (a.status !== 'suspended') throw new Error('Close the agency first (it is not suspended)');
  const [closed] = await db
    .select({ at: sql<string | null>`max(${auditLog.createdAt})` })
    .from(auditLog)
    .where(and(eq(auditLog.agencyId, agencyId), eq(auditLog.action, 'agency_closed')));
  const closedAt = closed?.at ? new Date(closed.at) : null;
  if (!closedAt || now.getTime() - closedAt.getTime() < minDays * 86_400_000) throw new Error(`Deletion is allowed ${minDays} days after closing (closed: ${closedAt?.toISOString() ?? 'never'})`);

  const keys = (await db.select({ key: document.storageKey }).from(document).where(and(eq(document.agencyId, agencyId), sql`${document.deletedAt} is null`))).map((r) => r.key);
  const listingsArchived = await db.transaction(async (tx) => {
    await tx.insert(agency).values({ name: 'Archived listings', slug: ARCHIVE_AGENCY_SLUG, status: 'suspended' }).onConflictDoNothing({ target: agency.slug });
    const [archive] = await tx.select({ id: agency.id }).from(agency).where(eq(agency.slug, ARCHIVE_AGENCY_SLUG)).limit(1);
    const mine = tx.select({ id: listing.id }).from(listing).where(eq(listing.agencyId, agencyId));
    await tx.delete(listingAgent).where(inArray(listingAgent.listingId, mine));
    await tx.update(listing).set({ status: 'withdrawn' }).where(and(eq(listing.agencyId, agencyId), inArray(listing.status, ['draft', 'pending', 'live', 'under_offer'])));
    const moved = await tx.update(listing).set({ agencyId: archive!.id, officeId: null, teamId: null }).where(eq(listing.agencyId, agencyId)).returning({ id: listing.id });
    await tx.delete(agency).where(eq(agency.id, agencyId));
    return moved.length;
  });
  // Files after the commit: a failed delete is reported for a re-run, never a reason to keep the rows.
  const report: DeleteReport = { listingsArchived, filesDeleted: 0, filesFailed: [] };
  for (const key of keys) {
    try {
      if (await (opts.deleteFile ?? deleteDocumentObject)(key)) report.filesDeleted += 1;
      else report.filesFailed.push(key);
    } catch {
      report.filesFailed.push(key);
    }
  }
  return report;
}
