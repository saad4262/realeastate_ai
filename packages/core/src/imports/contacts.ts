import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { contact, listingImport, listingImportRow, membership, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { ContactError } from '../contacts/list-contacts';
import { createContact } from '../contacts/write-contacts';
import { createNote } from '../contacts/notes';
import { auPhoneKey } from '../contacts/phone';
import { normalizeContactRow, type CellError, type ContactImportMapping, type NormalizedContact } from './contact-columns';
import { applyFix, IMPORT_CLEAN_FEATURE, IMPORT_MAP_FEATURE, rowToClean, type RowCleaner, type RowFix, type RowToClean } from './contact-ai';
import { agencyTimeZone } from '../widgets/registry';

/**
 * Contacts import (ADR 0029 amendment, "Contacts import"): the listing import's job with its own
 * columns (contact-columns.ts), dry run and import step. Every check is the contact form's own
 * (`createContact` parses each row again); marketing consent is never imported.
 */

type ImportRow = typeof listingImport.$inferSelect;
const CHUNK = 100;

function capFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Is this agency under its daily cap for import AI (ADR 0056), and the platform under AI_DAILY_BUDGET_USD?
 * The same advisory ceiling as the document reader's: read from `ai_run`, no second ledger.
 */
export async function importAiAllowed(db: Db, agencyId: string, env: NodeJS.ProcessEnv, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const [row] = await db.execute<{ agency: string; total: string }>(sql`
    select
      coalesce((select sum(r.cost_usd) from ai_run r where r.agency_id = ${agencyId} and r.feature in (${IMPORT_MAP_FEATURE}, ${IMPORT_CLEAN_FEATURE}) and r.created_at >= ${since}), 0) as agency,
      coalesce((select sum(r.cost_usd) from ai_run r where r.created_at >= ${since}), 0) as total`);
  const perAgency = capFrom(env.IMPORT_AI_DAILY_BUDGET_USD_PER_AGENCY, 1);
  const global = capFrom(env.AI_DAILY_BUDGET_USD, 5);
  return Number(row?.total ?? 0) < global && Number(row?.agency ?? 0) < perAgency;
}

type Checked = { id: string; rowNumber: number; raw: unknown; row: NormalizedContact | null; errors: CellError[]; aiChanges?: CellError[] };

/**
 * ADR 0056 step 2: the chunk's failing rows, their mapped fields only, to the cleaner — one call,
 * with no transaction open. A proposed fix is kept only when its values pass the guards AND the row
 * then passes the normal check; otherwise the row keeps its own errors. Any failure here costs the
 * fixes, never the dry run.
 */
async function cleanFailingRows(db: Db, imp: ImportRow, checked: Checked[], cleaner: RowCleaner, tz: string, env: NodeJS.ProcessEnv, now: Date): Promise<void> {
  const mapping = imp.mapping as ContactImportMapping;
  const asks = checked
    .filter((c) => !c.row)
    .map((c) => ({ c, ask: rowToClean(c.rowNumber, (c.raw as string[]) ?? [], mapping, c.errors) }))
    .filter((x): x is { c: Checked; ask: RowToClean } => x.ask !== null);
  if (!asks.length) return;
  if (!(await importAiAllowed(db, imp.agencyId, env, now))) {
    for (const { c } of asks) c.errors = [...c.errors, { column: 'Row', message: 'Not sent for an AI fix — today’s AI budget for imports is spent' }];
    return;
  }
  let fixes: RowFix[];
  try {
    fixes = await cleaner.clean({ rows: asks.map((x) => x.ask), importId: imp.id, agencyId: imp.agencyId, userId: imp.createdBy });
  } catch (err) {
    console.error('[import] AI fixes failed — rows keep their errors', err instanceof Error ? err.message : err);
    return;
  }
  const byRow = new Map(asks.map((x) => [x.c.rowNumber, x.c]));
  for (const fix of fixes) {
    const c = byRow.get(fix.rowNumber);
    if (!c) continue; // a row number it was not asked about
    const out = applyFix((c.raw as string[]) ?? [], mapping, fix, tz);
    if (!out.row) continue;
    c.row = out.row;
    c.errors = [];
    c.aiChanges = out.changes;
  }
}

/**
 * Dry run, one chunk: normalise, then duplicates for the whole chunk in three statements — an email
 * a contact of the agency already has (skipped, without naming them), the same email earlier in the
 * file (skipped), the same phone as a contact (a warning only).
 */
export async function validateContactChunk(
  db: Db,
  imp: ImportRow,
  deps: { cleaner?: RowCleaner; env?: NodeJS.ProcessEnv } = {},
  now = new Date(),
): Promise<{ status: 'validating' | 'validated'; processed: number }> {
  const rows = await db
    .select({ id: listingImportRow.id, rowNumber: listingImportRow.rowNumber, raw: listingImportRow.raw })
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), eq(listingImportRow.status, 'pending')))
    .orderBy(asc(listingImportRow.rowNumber))
    .limit(CHUNK);
  if (!rows.length) {
    await db.update(listingImport).set({ status: 'validated', updatedAt: sql`now()` }).where(eq(listingImport.id, imp.id));
    return { status: 'validated', processed: 0 };
  }
  const tz = await agencyTimeZone(db, imp.agencyId);
  const checked: Checked[] = rows.map((r) => ({ ...r, ...normalizeContactRow((r.raw as string[]) ?? [], imp.mapping as ContactImportMapping, tz) }));
  if (imp.aiClean && deps.cleaner) await cleanFailingRows(db, imp, checked, deps.cleaner, tz, deps.env ?? process.env, now);
  const emails = [...new Set(checked.map((c) => c.row?.email).filter((e): e is string => Boolean(e)))];
  const phoneKeys = [...new Set(checked.map((c) => auPhoneKey(c.row?.phone)).filter((k): k is string => Boolean(k)))];
  const held = emails.length
    ? new Set(
        (await db
          .select({ email: sql<string>`lower(${contact.email})` })
          .from(contact)
          .where(and(eq(contact.agencyId, imp.agencyId), isNull(contact.mergedIntoId), inArray(sql`lower(${contact.email})`, emails)))).map((r) => r.email),
      )
    : new Set<string>();
  const phones = phoneKeys.length
    ? new Set(
        (await db
          .select({ k: contact.phoneKey })
          .from(contact)
          .where(and(eq(contact.agencyId, imp.agencyId), isNull(contact.mergedIntoId), inArray(contact.phoneKey, phoneKeys)))).map((r) => r.k),
      )
    : new Set<string | null>();
  const earlier = emails.length
    ? await db
        .select({ rowNumber: listingImportRow.rowNumber, email: sql<string>`${listingImportRow.normalized}->>'email'` })
        .from(listingImportRow)
        .where(and(eq(listingImportRow.importId, imp.id), inArray(listingImportRow.status, ['valid', 'duplicate']), inArray(sql`${listingImportRow.normalized}->>'email'`, emails)))
    : [];
  const seen = new Map(earlier.map((e) => [e.email, e.rowNumber]));

  await db.transaction(async (tx) => {
    for (const c of checked) {
      if (!c.row) {
        await tx.update(listingImportRow).set({ status: 'error', errors: c.errors, updatedAt: sql`now()` }).where(eq(listingImportRow.id, c.id));
        continue;
      }
      const email = c.row.email;
      const inFile = email ? seen.get(email) : undefined;
      const exists = email ? held.has(email) : false;
      const phoneKey = auPhoneKey(c.row.phone);
      const found = exists
        ? [{ column: 'Email', message: 'This email is already a contact in your agency — skipped' }]
        : inFile
          ? [{ column: 'Email', message: `Same email as row ${inFile} — skipped` }]
          : phoneKey && phones.has(phoneKey)
            ? [{ column: 'Phone', message: 'Same phone as a contact already in your agency — they may be the same person (merge from the contact’s page)' }]
            : [];
      // What the AI changed comes first, so the person checking the row sees it before anything else.
      const warnings = [...(c.aiChanges ?? []), ...found];
      await tx
        .update(listingImportRow)
        .set({ status: exists || inFile ? 'duplicate' : 'valid', normalized: c.row, errors: [], warnings, updatedAt: sql`now()` })
        .where(eq(listingImportRow.id, c.id));
      if (email && !exists && !inFile) seen.set(email, c.rowNumber);
    }
  });
  return { status: 'validating', processed: rows.length };
}

/**
 * Import, one chunk, AS THE UPLOADER: each row its own savepoint through `createContact` (which
 * asks `contact:create` again and refuses an email someone added meanwhile), its note, and — for
 * someone who may assign — the agent in the file. Duplicates are never imported.
 */
export async function importContactChunk(db: Db, actor: Actor, imp: ImportRow): Promise<{ status: 'importing' | 'done'; processed: number }> {
  const rows = await db
    .select()
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), eq(listingImportRow.status, 'valid')))
    .orderBy(asc(listingImportRow.rowNumber))
    .limit(CHUNK);
  if (!rows.length) {
    await db.update(listingImport).set({ status: 'done', finishedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(listingImport.id, imp.id));
    return { status: 'done', processed: 0 };
  }
  const mayAssign = can(actor, 'contact:assign', { type: 'contact', agencyId: imp.agencyId });
  const emails = mayAssign ? [...new Set(rows.map((r) => (r.normalized as NormalizedContact | null)?.assignedEmail).filter((e): e is string => Boolean(e)))] : [];
  const members = emails.length
    ? await db
        .select({ id: user.id, email: sql<string>`lower(${user.email})` })
        .from(user)
        .innerJoin(membership, and(eq(membership.userId, user.id), eq(membership.agencyId, imp.agencyId), eq(membership.status, 'active')))
        .where(inArray(sql`lower(${user.email})`, emails))
    : [];
  const byEmail = new Map(members.map((m) => [m.email, m.id]));

  await db.transaction(async (tx) => {
    for (const r of rows) {
      const n = r.normalized as NormalizedContact;
      const warnings = [...((r.warnings as CellError[]) ?? [])];
      let assignedTo: string | undefined;
      if (n.assignedEmail) {
        if (!mayAssign) warnings.push({ column: 'Assigned agent’s email', message: 'Only an owner or admin assigns contacts from a file — this one is yours' });
        else if (byEmail.get(n.assignedEmail)) assignedTo = byEmail.get(n.assignedEmail);
        else warnings.push({ column: 'Assigned agent’s email', message: `Agent not found: ${n.assignedEmail} — unassigned` });
      }
      try {
        const id = await tx.transaction(async (sp) => {
          const spDb = sp as unknown as Db;
          const made = await createContact(
            spDb,
            actor,
            {
              name: n.name,
              ...(n.email ? { email: n.email } : {}),
              ...(n.phone ? { phone: n.phone } : {}),
              roles: n.roles,
              ...(n.nextAction ? { nextAction: n.nextAction } : {}),
              ...(n.nextActionAt ? { nextActionAt: n.nextActionAt } : {}),
              ...(assignedTo ? { assignedTo } : {}),
            },
            { source: 'import' },
          );
          if (n.note) await createNote(spDb, actor, made.id, n.note);
          return made.id;
        });
        await tx.update(listingImportRow).set({ status: 'imported', contactId: id, warnings, updatedAt: sql`now()` }).where(eq(listingImportRow.id, r.id));
      } catch (err) {
        const message = err instanceof ContactError ? err.message : 'Could not add this contact';
        if (!(err instanceof ContactError)) console.error('[import] contact row failed', r.rowNumber, err instanceof Error ? err.message : err);
        await tx.update(listingImportRow).set({ status: 'failed', errors: [{ column: 'Row', message }], warnings, updatedAt: sql`now()` }).where(eq(listingImportRow.id, r.id));
      }
    }
  });
  return { status: 'importing', processed: rows.length };
}
