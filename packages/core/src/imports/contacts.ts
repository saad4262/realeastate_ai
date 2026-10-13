import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { contact, listingImport, listingImportRow, membership, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { ContactError } from '../contacts/list-contacts';
import { createContact } from '../contacts/write-contacts';
import { createNote } from '../contacts/notes';
import { auPhoneKey } from '../contacts/phone';
import { normalizeContactRow, type CellError, type ContactImportMapping, type NormalizedContact } from './contact-columns';
import { agencyTimeZone } from '../widgets/registry';

/**
 * Contacts import (ADR 0029 amendment, "Contacts import"): the listing import's job with its own
 * columns (contact-columns.ts), dry run and import step. Every check is the contact form's own
 * (`createContact` parses each row again); marketing consent is never imported.
 */

type ImportRow = typeof listingImport.$inferSelect;
const CHUNK = 100;

/**
 * Dry run, one chunk: normalise, then duplicates for the whole chunk in three statements — an email
 * a contact of the agency already has (skipped, without naming them), the same email earlier in the
 * file (skipped), the same phone as a contact (a warning only).
 */
export async function validateContactChunk(db: Db, imp: ImportRow): Promise<{ status: 'validating' | 'validated'; processed: number }> {
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
  const checked = rows.map((r) => ({ ...r, ...normalizeContactRow((r.raw as string[]) ?? [], imp.mapping as ContactImportMapping, tz) }));
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
      const warnings = exists
        ? [{ column: 'Email', message: 'This email is already a contact in your agency — skipped' }]
        : inFile
          ? [{ column: 'Email', message: `Same email as row ${inFile} — skipped` }]
          : phoneKey && phones.has(phoneKey)
            ? [{ column: 'Phone', message: 'Same phone as a contact already in your agency — they may be the same person (merge from the contact’s page)' }]
            : [];
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
