import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { listing, listingImport, listingImportRow, membership, property, user, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { createListing } from '../listings/create-listing';
import { updateListing } from '../listings/update-listing';
import { setListingStatus } from '../listings/publish-listing';
import { setImportedListingFields } from '../listings/import-fields';
import { ListingError } from '../listings/listing-schema';
import { addressKey } from '../listings/address-key';
import { geocodeAddress } from '../geo/places';
import { activeMemberActor } from '../team/member-actor';
import { agencyTimeZone } from '../widgets/registry';
import { CsvError, csvCell, parseCsv, tableToCsv, type ImportTable } from './csv';
import { autoMap, FIELD_LABELS, importMappingSchema, normalizeRow, REQUIRED_FIELDS, type ImportMapping, type NormalizedRow } from './columns';
import { importPhoto, PhotoError, type PhotoDeps } from './photos';

/**
 * CSV listing import (ADR 0029): upload → map columns → dry run (every row
 * checked, geocoded, matched; nothing written to listings) → import → photos.
 * Worked in CHUNKS of ~100 rows under a short lease on the import, by the open
 * page and by the cron tick, so a closed tab loses nothing and two workers
 * never run the same chunk. Geocoding (network) happens in the dry run, before
 * any transaction; the import passes the stored coordinates, so `createListing`
 * never calls the network inside one. Each row is its own savepoint: one bad
 * row is marked failed with its reason, the rest of the chunk goes in.
 */

export class ImportError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

const NOT_FOUND = () => new ImportError('not_found', 'That import was not found');
export const CHUNK_ROWS = 100;
export const CHUNK_PHOTOS = 20;
const LEASE_MS = 2 * 60 * 1000;
export const IMPORT_FILE_DAYS = 30;

export type ImportMode = 'live' | 'draft' | 'pending';
export type ImportStatus = 'mapped' | 'validating' | 'validated' | 'importing' | 'done' | 'failed' | 'cancelled';

export type ImportDeps = {
  /** Address → pin. Network; never inside a transaction. Test seam. */
  geocode?: typeof geocodeAddress;
  photos?: PhotoDeps;
};

function resource(i: { id: string; agencyId: string; createdBy: string | null }) {
  return { type: 'listing_import', id: i.id, agencyId: i.agencyId, ...(i.createdBy ? { ownerId: i.createdBy } : {}) };
}

/** Owner/admin may import live or as draft; anyone else's import goes through approval (ADR 0024 §1). */
function modeFor(actor: Actor, requested: ImportMode | undefined): ImportMode {
  const mayPublish = can(actor, 'listing:publish', { type: 'listing', agencyId: actor.agencyId as string });
  if (!mayPublish) return 'pending';
  return requested === 'draft' ? 'draft' : 'live';
}

export type ImportSource = 'csv' | 'xlsx' | 'sheet';
/** A Google Sheet's place, so Re-import reads the same file and tab (ADR 0029 amendment). */
export type SheetRef = { spreadsheetId: string; tab: string; title: string };
export type CreatedImport = { id: string; rows: number; sameFileAs: { id: string; createdAt: Date } | null };

/** Upload: parse, store the file and every row, guess the mapping. Nothing is checked yet. */
export async function createImport(
  db: Db,
  actor: Actor,
  input: { fileName: string; text: string; mode?: ImportMode },
): Promise<CreatedImport> {
  assertMayImport(actor);
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(input.text);
  } catch (err) {
    if (err instanceof CsvError) throw new ImportError('invalid', err.message);
    throw err;
  }
  return storeImport(db, actor, { fileName: input.fileName, text: input.text, table: parsed, mode: input.mode, source: 'csv', sourceRef: null });
}

function assertMayImport(actor: Actor): asserts actor is Actor & { agencyId: string } {
  if (!actor.agencyId || !can(actor, 'listing_import:create', { type: 'listing_import', agencyId: actor.agencyId })) {
    throw new ImportError('forbidden', 'You cannot import listings');
  }
}

/**
 * A table that came from an Excel file or a Google Sheet (ADR 0029 amendment), already read —
 * the network is behind us. From here it is exactly a CSV upload: the table is kept as CSV text.
 */
export async function createImportFromTable(
  db: Db,
  actor: Actor,
  input: { fileName: string; table: ImportTable; mode?: ImportMode; source: Exclude<ImportSource, 'csv'>; sourceRef?: SheetRef | null },
): Promise<CreatedImport> {
  assertMayImport(actor);
  return storeImport(db, actor, { fileName: input.fileName, text: tableToCsv(input.table), table: input.table, mode: input.mode, source: input.source, sourceRef: input.sourceRef ?? null });
}

async function storeImport(
  db: Db,
  actor: Actor & { agencyId: string },
  input: { fileName: string; text: string; table: ImportTable; mode: ImportMode | undefined; source: ImportSource; sourceRef: SheetRef | null },
): Promise<CreatedImport> {
  const parsed = input.table;
  const agencyId = actor.agencyId;
  const fileHash = createHash('sha256').update(input.text).digest('hex');
  const [same] = await db
    .select({ id: listingImport.id, createdAt: listingImport.createdAt })
    .from(listingImport)
    .where(and(eq(listingImport.agencyId, agencyId), eq(listingImport.fileHash, fileHash)))
    .orderBy(desc(listingImport.createdAt))
    .limit(1);
  const id = await db.transaction(async (tx) => {
    const [imp] = await tx
      .insert(listingImport)
      .values({
        agencyId,
        createdBy: actor.userId,
        fileName: input.fileName.slice(0, 200) || 'import.csv',
        fileHash,
        fileText: input.text,
        source: input.source,
        sourceRef: input.sourceRef,
        headers: parsed.headers,
        mapping: autoMap(parsed.headers),
        status: 'mapped',
        mode: modeFor(actor, input.mode),
        totalRows: parsed.rows.length,
      })
      .returning({ id: listingImport.id });
    for (let i = 0; i < parsed.rows.length; i += 500) {
      await tx.insert(listingImportRow).values(
        parsed.rows.slice(i, i + 500).map((cells, j) => ({ importId: imp!.id, rowNumber: i + j + 2, raw: cells })),
      );
    }
    return imp!.id;
  });
  return { id, rows: parsed.rows.length, sameFileAs: same ? { id: same.id, createdAt: new Date(same.createdAt) } : null };
}

async function loadImport(db: DbOrTx, actor: Actor, id: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw NOT_FOUND();
  const [row] = await db
    .select()
    .from(listingImport)
    .where(and(eq(listingImport.id, id), eq(listingImport.agencyId, actor.agencyId)))
    .limit(1);
  if (!row || !can(actor, 'listing_import:read', resource(row))) throw NOT_FOUND();
  return row;
}

function requireRun(actor: Actor, imp: { id: string; agencyId: string; createdBy: string | null }) {
  if (!can(actor, 'listing_import:run', resource(imp))) throw new ImportError('forbidden', 'Only the person who uploaded this file can run it');
}

/** Change the column mapping. Any earlier dry run is thrown away — it must run again. */
export async function setImportMapping(db: Db, actor: Actor, id: string, mapping: unknown): Promise<void> {
  const imp = await loadImport(db, actor, id);
  requireRun(actor, imp);
  if (imp.status !== 'mapped' && imp.status !== 'validated') throw new ImportError('conflict', 'This import has already started');
  const parsed = importMappingSchema.safeParse(mapping);
  if (!parsed.success) throw new ImportError('invalid', 'That column mapping is not valid');
  const width = (imp.headers as unknown[]).length;
  if (Object.values(parsed.data).some((v) => v !== null && v !== undefined && v >= width)) throw new ImportError('invalid', 'That column is not in the file');
  await db.transaction(async (tx) => {
    await tx.update(listingImport).set({ mapping: parsed.data, status: 'mapped', updatedAt: sql`now()` }).where(eq(listingImport.id, imp.id));
    await tx
      .update(listingImportRow)
      .set({ status: 'pending', normalized: null, errors: [], warnings: [], duplicateOfListingId: null, updatedAt: sql`now()` })
      .where(eq(listingImportRow.importId, imp.id));
  });
}

/** Begin the dry run. Required columns must be mapped first. */
export async function startDryRun(db: Db, actor: Actor, id: string): Promise<void> {
  const imp = await loadImport(db, actor, id);
  requireRun(actor, imp);
  if (imp.status !== 'mapped') throw new ImportError('conflict', 'Map the columns first');
  const mapping = imp.mapping as ImportMapping;
  const missing = REQUIRED_FIELDS.filter((f) => mapping[f] === null || mapping[f] === undefined);
  if (missing.length) throw new ImportError('invalid', `Choose a column for: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}`);
  await db.update(listingImport).set({ status: 'validating', updatedAt: sql`now()` }).where(and(eq(listingImport.id, imp.id), eq(listingImport.status, 'mapped')));
}

/**
 * Import the validated rows. Mode was fixed at upload from the uploader's
 * permission (an agent's is always `pending`). "Update from file" — rows that
 * match an active listing update it instead of being skipped — is
 * owner/admin only (decided Q3).
 */
export async function startImport(db: Db, actor: Actor, id: string, opts: { updateDuplicates?: boolean } = {}): Promise<void> {
  const imp = await loadImport(db, actor, id);
  requireRun(actor, imp);
  if (imp.status !== 'validated') throw new ImportError('conflict', 'Run the check first');
  const update = Boolean(opts.updateDuplicates);
  if (update && !can(actor, 'listing:publish', { type: 'listing', agencyId: imp.agencyId })) {
    throw new ImportError('forbidden', 'Only an owner or admin can update existing listings from a file');
  }
  // The mode is re-derived from the person NOW: someone demoted since uploading imports as pending.
  const mode = imp.mode === 'pending' ? 'pending' : modeFor(actor, imp.mode as ImportMode);
  await db
    .update(listingImport)
    .set({ status: 'importing', mode, updateDuplicates: update, startedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(listingImport.id, imp.id), eq(listingImport.status, 'validated')));
}

export async function cancelImport(db: Db, actor: Actor, id: string): Promise<void> {
  const imp = await loadImport(db, actor, id);
  if (!can(actor, 'listing_import:cancel', resource(imp))) throw new ImportError('forbidden', 'You cannot cancel this import');
  await db
    .update(listingImport)
    .set({ status: 'cancelled', finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(listingImport.id, imp.id), inArray(listingImport.status, ['mapped', 'validating', 'validated', 'importing'])));
}

/** Take the job for one chunk. Null when another worker holds it, or there is nothing to do. */
async function claim(db: Db, id: string, now: Date) {
  const stale = new Date(now.getTime() - LEASE_MS);
  const [row] = await db
    .update(listingImport)
    .set({ claimedAt: now })
    .where(
      and(
        eq(listingImport.id, id),
        inArray(listingImport.status, ['validating', 'importing']),
        or(isNull(listingImport.claimedAt), lt(listingImport.claimedAt, stale)),
      ),
    )
    .returning();
  return row ?? null;
}

async function release(db: Db, id: string) {
  await db.update(listingImport).set({ claimedAt: null, updatedAt: sql`now()` }).where(eq(listingImport.id, id));
}

export type ChunkResult = { status: ImportStatus; processed: number; busy?: boolean };

/**
 * One chunk of whatever the import is doing now, AS ITS UPLOADER. The page
 * calls this in a loop while open; the cron tick calls it when nobody is.
 */
export async function runImportChunk(db: Db, actor: Actor, id: string, deps: ImportDeps = {}, now = new Date()): Promise<ChunkResult> {
  const imp = await loadImport(db, actor, id);
  requireRun(actor, imp);
  const claimed = await claim(db, imp.id, now);
  if (!claimed) return { status: imp.status as ImportStatus, processed: 0, busy: imp.status === 'validating' || imp.status === 'importing' };
  try {
    if (claimed.status === 'validating') return await validateChunk(db, actor, claimed, deps);
    return await importChunk(db, actor, claimed, deps);
  } finally {
    await release(db, imp.id);
  }
}

type ImportRow = typeof listingImport.$inferSelect;

/** Dry run: map, check with the form's rules, geocode, and find duplicates — for up to CHUNK_ROWS rows. */
async function validateChunk(db: Db, actor: Actor, imp: ImportRow, deps: ImportDeps): Promise<ChunkResult> {
  const rows = await db
    .select({ id: listingImportRow.id, rowNumber: listingImportRow.rowNumber, raw: listingImportRow.raw })
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), eq(listingImportRow.status, 'pending')))
    .orderBy(asc(listingImportRow.rowNumber))
    .limit(CHUNK_ROWS);
  if (!rows.length) {
    await db.update(listingImport).set({ status: 'validated', updatedAt: sql`now()` }).where(eq(listingImport.id, imp.id));
    return { status: 'validated', processed: 0 };
  }
  const tz = await agencyTimeZone(db, imp.agencyId);
  const geocode = deps.geocode ?? geocodeAddress;
  type Checked = { id: string; rowNumber: number; row: NormalizedRow | null; errors: { column: string; message: string }[]; key: string | null; pin: { latitude: number; longitude: number; placeId: string | null; formatted: string } | null };
  const checked: Checked[] = [];
  for (const r of rows) {
    const { row, errors } = normalizeRow((r.raw as string[]) ?? [], imp.mapping as ImportMapping, tz);
    if (!row) {
      checked.push({ id: r.id, rowNumber: r.rowNumber, row: null, errors, key: null, pin: null });
      continue;
    }
    // Network — never inside a transaction. place_cache answers repeats.
    const hit = await geocode(db, {
      unit: row.property.unit ?? null,
      streetNumber: row.property.streetNumber ?? null,
      street: row.property.street ?? null,
      suburb: row.property.suburb,
      state: (row.property.state ?? 'NSW') as string,
      postcode: row.property.postcode,
    } as never).catch(() => null);
    if (!hit || hit.kind !== 'address') {
      checked.push({ id: r.id, rowNumber: r.rowNumber, row: null, errors: [{ column: 'Address', message: 'Google could not find this street address — check it' }], key: null, pin: null });
      continue;
    }
    checked.push({ id: r.id, rowNumber: r.rowNumber, row, errors: [], key: addressKey(row.property as never), pin: hit });
  }

  // Duplicates, in three statements for the whole chunk (never one per row).
  const valid = checked.filter((c) => c.row);
  const places = [...new Set(valid.map((c) => `${c.row!.property.suburb.trim().toLowerCase()}|${c.row!.property.postcode}|${c.row!.property.state}`))];
  const candidates = places.length
    ? await db
        .select({ id: property.id, unit: property.unit, streetNumber: property.streetNumber, street: property.street, suburb: property.suburb, state: property.state, postcode: property.postcode })
        .from(property)
        .where(inArray(sql`lower(trim(${property.suburb})) || '|' || ${property.postcode} || '|' || ${property.state}`, places))
    : [];
  const propertyByKey = new Map(candidates.map((p) => [addressKey(p as never), p.id]));
  const propertyIds = [...new Set(valid.map((c) => propertyByKey.get(c.key!)).filter((x): x is string => Boolean(x)))];
  const externalIds = [...new Set(valid.map((c) => c.row!.externalId).filter((x): x is string => Boolean(x)))];
  const active = propertyIds.length || externalIds.length
    ? await db
        .select({ id: listing.id, propertyId: listing.propertyId, channel: listing.channel, status: listing.status, externalId: listing.externalId })
        .from(listing)
        .where(
          and(
            eq(listing.agencyId, imp.agencyId),
            or(
              propertyIds.length ? and(inArray(listing.propertyId, propertyIds), inArray(listing.status, ['draft', 'pending', 'live', 'under_offer'])) : sql`false`,
              externalIds.length ? inArray(listing.externalId, externalIds) : sql`false`,
            ),
          ),
        )
    : [];
  // Earlier rows of the same file, already checked, with the same address and channel.
  const earlier = valid.length
    ? await db
        .select({ rowNumber: listingImportRow.rowNumber, normalized: listingImportRow.normalized })
        .from(listingImportRow)
        .where(
          and(
            eq(listingImportRow.importId, imp.id),
            inArray(listingImportRow.status, ['valid', 'duplicate']),
            inArray(sql`${listingImportRow.normalized}->>'addressKey'`, [...new Set(valid.map((c) => c.key!))]),
          ),
        )
    : [];
  const seen = new Map<string, number>();
  for (const e of earlier) {
    const n = e.normalized as { addressKey?: string; listing?: { channel?: string } } | null;
    if (n?.addressKey) seen.set(`${n.addressKey}|${n.listing?.channel}`, e.rowNumber);
  }

  await db.transaction(async (tx) => {
    for (const c of checked) {
      if (!c.row) {
        await tx.update(listingImportRow).set({ status: 'error', errors: c.errors, updatedAt: sql`now()` }).where(eq(listingImportRow.id, c.id));
        continue;
      }
      const normalized = {
        ...c.row,
        addressKey: c.key,
        property: { ...c.row.property, latitude: c.pin!.latitude, longitude: c.pin!.longitude, placeId: c.pin!.placeId ?? undefined, formattedAddress: c.pin!.formatted, pinSource: 'google' as const },
      };
      const sameExternal = c.row.externalId ? active.find((a) => a.externalId === c.row!.externalId) : undefined;
      const propertyId = propertyByKey.get(c.key!);
      const sameActive = propertyId ? active.find((a) => a.propertyId === propertyId && ['draft', 'pending', 'live', 'under_offer'].includes(a.status)) : undefined;
      const inFile = seen.get(`${c.key}|${c.row.listing.channel}`);
      const dup = sameExternal ?? sameActive;
      const warnings = dup
        ? [{ column: 'Address', message: sameExternal ? `Matches your listing id ${c.row.externalId} already on the platform` : 'Matches one of your active listings at this address' }]
        : inFile
          ? [{ column: 'Address', message: `Same address and channel as row ${inFile}` }]
          : [];
      await tx
        .update(listingImportRow)
        .set({ status: dup || inFile ? 'duplicate' : 'valid', normalized, errors: [], warnings, duplicateOfListingId: dup?.id ?? null, updatedAt: sql`now()` })
        .where(eq(listingImportRow.id, c.id));
      if (!inFile && !dup) seen.set(`${c.key}|${c.row.listing.channel}`, c.rowNumber);
    }
  });
  return { status: 'validating', processed: rows.length };
}

/** Import up to CHUNK_ROWS rows, then photos, then done. */
async function importChunk(db: Db, actor: Actor, imp: ImportRow, deps: ImportDeps): Promise<ChunkResult> {
  const statuses = imp.updateDuplicates ? ['valid', 'duplicate'] : ['valid'];
  const rows = await db
    .select()
    .from(listingImportRow)
    .where(
      and(
        eq(listingImportRow.importId, imp.id),
        inArray(listingImportRow.status, statuses),
        // A duplicate is only ever an UPDATE of the listing it matched — never a second listing.
        or(eq(listingImportRow.status, 'valid'), isNotNull(listingImportRow.duplicateOfListingId)),
      ),
    )
    .orderBy(asc(listingImportRow.rowNumber))
    .limit(CHUNK_ROWS);

  if (rows.length) {
    // Agents by email: one statement for the chunk; only active members of this agency.
    const emails = [...new Set(rows.flatMap((r) => ((r.normalized as NormalizedRow | null)?.agentEmails ?? [])))];
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
        const n = r.normalized as NormalizedRow;
        const warnings = [...((r.warnings as { column: string; message: string }[]) ?? [])];
        const agents: string[] = [];
        for (const e of n.agentEmails) {
          const id = byEmail.get(e);
          if (id) agents.push(id);
          else warnings.push({ column: 'Agent emails', message: `Agent not found: ${e} — listed under you instead` });
        }
        // The uploader is on every listing they import that has no agent from the file, and on
        // every one an agent imports (so they may submit it for approval).
        if (!agents.length || (imp.mode === 'pending' && !agents.includes(actor.userId))) agents.push(actor.userId);
        try {
          const outcome = await tx.transaction(async (sp) => {
            const spDb = sp as unknown as Db;
            if (r.status === 'duplicate' && r.duplicateOfListingId) {
              // Admin-only "Update from file" (checked at start): the matched listing's fields.
              await updateListing(spDb, actor, r.duplicateOfListingId, { property: n.property, listing: n.listing });
              await setImportedListingFields(sp, imp.agencyId, r.duplicateOfListingId, { externalId: n.externalId, listedOn: null });
              return { status: 'updated' as const, listingId: r.duplicateOfListingId };
            }
            const created = await createListing(spDb, actor, { property: n.property, listing: n.listing, agentUserIds: [...new Set(agents)] });
            await setImportedListingFields(sp, imp.agencyId, created.listingId, { externalId: n.externalId, listedOn: n.listedOn });
            const asAgent: Actor = { ...actor, listingAgentOf: [...(actor.listingAgentOf ?? []), created.listingId] };
            if (imp.mode === 'pending') {
              await setListingStatus(sp, asAgent, created.listingId, 'pending');
            } else if (imp.mode === 'live') {
              if (n.status === 'live' || n.status === 'under_offer') await setListingStatus(sp, asAgent, created.listingId, 'live');
              if (n.status === 'under_offer') await setListingStatus(sp, asAgent, created.listingId, 'under_offer');
              if (n.status === 'sold') await setListingStatus(sp, asAgent, created.listingId, 'sold', n.sold);
              if (n.status === 'withdrawn') await setListingStatus(sp, asAgent, created.listingId, 'withdrawn');
            }
            return { status: 'imported' as const, listingId: created.listingId };
          });
          await tx
            .update(listingImportRow)
            .set({
              status: outcome.status,
              listingId: outcome.listingId,
              warnings,
              photos: n.photoUrls.map((url) => ({ url, status: 'pending' })),
              updatedAt: sql`now()`,
            })
            .where(eq(listingImportRow.id, r.id));
        } catch (err) {
          const message = err instanceof ListingError ? err.message : 'Could not create this listing';
          if (!(err instanceof ListingError)) console.error('[import] row failed', r.rowNumber, err instanceof Error ? err.message : err);
          await tx.update(listingImportRow).set({ status: 'failed', errors: [{ column: 'Row', message }], warnings, updatedAt: sql`now()` }).where(eq(listingImportRow.id, r.id));
        }
      }
    });
    return { status: 'importing', processed: rows.length };
  }

  // Photos, after every row is in: up to CHUNK_PHOTOS links per chunk, each its own network call.
  const withPhotos = await db
    .select({ id: listingImportRow.id, listingId: listingImportRow.listingId, photos: listingImportRow.photos })
    .from(listingImportRow)
    .where(and(eq(listingImportRow.importId, imp.id), inArray(listingImportRow.status, ['imported', 'updated']), sql`${listingImportRow.photos} @> '[{"status":"pending"}]'::jsonb`))
    .orderBy(asc(listingImportRow.rowNumber))
    .limit(CHUNK_PHOTOS);
  if (withPhotos.length) {
    let budget = CHUNK_PHOTOS;
    for (const r of withPhotos) {
      const photos = [...(r.photos as { url: string; status: string; error?: string }[])];
      for (const p of photos) {
        if (p.status !== 'pending' || budget <= 0) continue;
        budget -= 1;
        try {
          await importPhoto(db, r.listingId!, p.url, deps.photos);
          p.status = 'done';
        } catch (err) {
          p.status = 'failed';
          p.error = err instanceof PhotoError || (err instanceof Error && err.name === 'MediaError') ? err.message : 'Could not fetch this photo';
        }
      }
      await db.update(listingImportRow).set({ photos, updatedAt: sql`now()` }).where(eq(listingImportRow.id, r.id));
    }
    return { status: 'importing', processed: CHUNK_PHOTOS - budget };
  }

  await db.update(listingImport).set({ status: 'done', finishedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(listingImport.id, imp.id));
  return { status: 'done', processed: 0 };
}

export type ImportCounts = Record<'pending' | 'valid' | 'error' | 'duplicate' | 'imported' | 'updated' | 'failed' | 'skipped', number> & {
  photosPending: number;
  photosDone: number;
  photosFailed: number;
};

export type ImportView = {
  id: string;
  fileName: string;
  /** Where the rows came from; a sheet's file and tab, for Re-import (ADR 0029 amendment). */
  source: ImportSource;
  sheet: SheetRef | null;
  status: ImportStatus;
  mode: ImportMode;
  updateDuplicates: boolean;
  headers: string[];
  mapping: ImportMapping;
  totalRows: number;
  counts: ImportCounts;
  createdAt: Date;
  finishedAt: Date | null;
  /** The first rows of the file, for the mapping screen. Empty once the file is cleared. */
  sample: string[][];
  /** Decided by can(): the screen draws its buttons from these. */
  mayRun: boolean;
  mayCancel: boolean;
  mayUpdateDuplicates: boolean;
};

/** One import with its counts, for the screen. Two statements. */
export async function getImport(db: Db, actor: Actor, id: string): Promise<ImportView> {
  const imp = await loadImport(db, actor, id);
  const [c] = await db
    .select({
      pending: sql<string>`count(*) filter (where status = 'pending')`,
      valid: sql<string>`count(*) filter (where status = 'valid')`,
      error: sql<string>`count(*) filter (where status = 'error')`,
      duplicate: sql<string>`count(*) filter (where status = 'duplicate')`,
      imported: sql<string>`count(*) filter (where status = 'imported')`,
      updated: sql<string>`count(*) filter (where status = 'updated')`,
      failed: sql<string>`count(*) filter (where status = 'failed')`,
      skipped: sql<string>`count(*) filter (where status = 'skipped')`,
      photosPending: sql<string>`coalesce(sum((select count(*) from jsonb_array_elements(${listingImportRow.photos}) p where p->>'status' = 'pending')), 0)`,
      photosDone: sql<string>`coalesce(sum((select count(*) from jsonb_array_elements(${listingImportRow.photos}) p where p->>'status' = 'done')), 0)`,
      photosFailed: sql<string>`coalesce(sum((select count(*) from jsonb_array_elements(${listingImportRow.photos}) p where p->>'status' = 'failed')), 0)`,
      sample: sql<unknown>`(select jsonb_agg(x.raw order by x.row_number) from (select raw, row_number from listing_import_row where import_id = ${imp.id} and raw is not null order by row_number limit 20) x)`,
    })
    .from(listingImportRow)
    .where(eq(listingImportRow.importId, imp.id));
  const n = (v: unknown) => Number(v ?? 0);
  return {
    id: imp.id,
    fileName: imp.fileName,
    source: imp.source as ImportSource,
    sheet: imp.source === 'sheet' ? (imp.sourceRef as SheetRef | null) : null,
    status: imp.status as ImportStatus,
    mode: imp.mode as ImportMode,
    updateDuplicates: imp.updateDuplicates,
    headers: imp.headers as string[],
    mapping: imp.mapping as ImportMapping,
    totalRows: imp.totalRows,
    counts: {
      pending: n(c?.pending), valid: n(c?.valid), error: n(c?.error), duplicate: n(c?.duplicate), imported: n(c?.imported),
      updated: n(c?.updated), failed: n(c?.failed), skipped: n(c?.skipped),
      photosPending: n(c?.photosPending), photosDone: n(c?.photosDone), photosFailed: n(c?.photosFailed),
    },
    createdAt: new Date(imp.createdAt),
    finishedAt: imp.finishedAt ? new Date(imp.finishedAt) : null,
    sample: (Array.isArray(c?.sample) ? c!.sample : []) as string[][],
    mayRun: can(actor, 'listing_import:run', resource(imp)),
    mayCancel: can(actor, 'listing_import:cancel', resource(imp)),
    mayUpdateDuplicates: can(actor, 'listing:publish', { type: 'listing', agencyId: imp.agencyId }),
  };
}

export type ImportReportRow = {
  rowNumber: number;
  status: string;
  errors: { column: string; message: string }[];
  warnings: { column: string; message: string }[];
  listingId: string | null;
  photos: { url: string; status: string; error?: string }[];
  address: string | null;
};

/** The row-by-row report (a page of it), problems first. One statement. */
export async function importReport(db: Db, actor: Actor, id: string, opts: { onlyProblems?: boolean; offset?: number; limit?: number } = {}): Promise<ImportReportRow[]> {
  const imp = await loadImport(db, actor, id);
  const rows = await db
    .select()
    .from(listingImportRow)
    .where(
      and(
        eq(listingImportRow.importId, imp.id),
        ...(opts.onlyProblems ? [or(inArray(listingImportRow.status, ['error', 'duplicate', 'failed']), sql`jsonb_array_length(${listingImportRow.warnings}) > 0`)!] : []),
      ),
    )
    .orderBy(asc(listingImportRow.rowNumber))
    .limit(Math.min(opts.limit ?? 200, 5000))
    .offset(opts.offset ?? 0);
  return rows.map((r) => {
    const n = r.normalized as (NormalizedRow & { property: { formattedAddress?: string } }) | null;
    return {
      rowNumber: r.rowNumber,
      status: r.status,
      errors: (r.errors as ImportReportRow['errors']) ?? [],
      warnings: (r.warnings as ImportReportRow['warnings']) ?? [],
      listingId: r.listingId ?? r.duplicateOfListingId,
      photos: (r.photos as ImportReportRow['photos']) ?? [],
      address: n?.property?.formattedAddress ?? null,
    };
  });
}

/** The report as a CSV to download: row, status, problems, warnings. */
export async function importReportCsv(db: Db, actor: Actor, id: string): Promise<string> {
  const rows = await importReport(db, actor, id, { limit: 5000 });
  const q = csvCell;
  const lines = ['row,status,problems,warnings,photos_failed'];
  for (const r of rows) {
    lines.push(
      [
        String(r.rowNumber),
        r.status,
        q(r.errors.map((e) => `${e.column}: ${e.message}`).join('; ')),
        q(r.warnings.map((e) => `${e.column}: ${e.message}`).join('; ')),
        q(r.photos.filter((p) => p.status === 'failed').map((p) => `${p.url} (${p.error ?? 'failed'})`).join('; ')),
      ].join(','),
    );
  }
  return lines.join('\n');
}

export type ImportSummary = { id: string; fileName: string; status: ImportStatus; totalRows: number; createdAt: Date; mine: boolean };

/** This person's imports — every import of the agency for an admin. One statement. */
export async function listImports(db: Db, actor: Actor): Promise<ImportSummary[]> {
  if (!actor.agencyId) return [];
  const rows = await db
    .select({ id: listingImport.id, agencyId: listingImport.agencyId, createdBy: listingImport.createdBy, fileName: listingImport.fileName, status: listingImport.status, totalRows: listingImport.totalRows, createdAt: listingImport.createdAt })
    .from(listingImport)
    .where(eq(listingImport.agencyId, actor.agencyId))
    .orderBy(desc(listingImport.createdAt))
    .limit(50);
  return rows
    .filter((r) => can(actor, 'listing_import:read', resource(r)))
    .map((r) => ({ id: r.id, fileName: r.fileName, status: r.status as ImportStatus, totalRows: r.totalRows, createdAt: new Date(r.createdAt), mine: r.createdBy === actor.userId }));
}

/**
 * The cron tick: one chunk for each running import nobody is driving, AS ITS
 * UPLOADER as they are now. Someone no longer an active member: the import
 * stops ("failed") — it never acts for a person who has left.
 */
export async function runImportTick(db: Db, deps: ImportDeps = {}, now = new Date(), limit = 5): Promise<{ ran: number; failed: number }> {
  const stale = new Date(now.getTime() - LEASE_MS);
  const due = await db
    .select({ id: listingImport.id, agencyId: listingImport.agencyId, createdBy: listingImport.createdBy })
    .from(listingImport)
    .where(and(inArray(listingImport.status, ['validating', 'importing']), or(isNull(listingImport.claimedAt), lt(listingImport.claimedAt, stale))))
    .orderBy(asc(listingImport.updatedAt))
    .limit(limit);
  let ran = 0;
  let failed = 0;
  for (const d of due) {
    const actor = d.createdBy ? await activeMemberActor(db, d.createdBy, d.agencyId) : null;
    if (!actor) {
      await db.update(listingImport).set({ status: 'failed', error: 'The person who started this import is no longer a member of the agency', finishedAt: sql`now()` }).where(eq(listingImport.id, d.id));
      failed += 1;
      continue;
    }
    try {
      await runImportChunk(db, actor, d.id, deps, now);
      ran += 1;
    } catch (err) {
      console.error('[import] tick chunk failed', err instanceof Error ? err.message : err);
    }
  }
  return { ran, failed };
}

/** The uploaded file and each row's cells are kept 30 days after the import finishes, then cleared. */
export async function purgeImportFiles(db: Db, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - IMPORT_FILE_DAYS * 86_400_000);
  const gone = await db
    .update(listingImport)
    .set({ fileText: null, purgedAt: sql`now()` })
    .where(and(isNull(listingImport.purgedAt), isNotNull(listingImport.finishedAt), lt(listingImport.finishedAt, before)))
    .returning({ id: listingImport.id });
  if (gone.length) {
    await db.update(listingImportRow).set({ raw: null }).where(inArray(listingImportRow.importId, gone.map((g) => g.id)));
  }
  return gone.length;
}
