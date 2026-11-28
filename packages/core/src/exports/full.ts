import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { activity, auditLog, contact, document, exportJob, lead, listing, mailMessage, mailThread, media, membership, notification, user, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor } from '../permissions';
import { recordAudit } from '../audit';
import { enqueueJob, type JobHandler, type JobRow } from '../jobs';
import { memberContext } from '../platform/member-actor';
import { visibleContactIdsSql } from '../contacts/visibility';
import { privateActivityVisibleSql } from '../contacts/notes';
import { numberScopeSql } from '../contacts/communications';
import { threadScopeFilters } from '../mail/threads';
import { documentScopeFilters } from '../documents/visibility';
import { deleteDocumentObject, downloadDocumentObject, putExportObject, signDocumentDownload } from '../documents/storage';
import { listingScopeFilters } from '../listings/scope';
import { mediaUrl } from '../media/media-url';
import { agencyTimeZone } from '../widgets/registry';
import { buildDataExportReadyEmail } from '../email/team-notices';
import type { ReminderDeps } from '../appointments/reminders';
import { BOM, datasetPages, ExportError, EXPORT_PAGE, iso, line, type Page, type QuickDataset } from './quick';

/**
 * Full export (ADR 0104 phase 3): everything a member may see, as CSVs in `data.zip` plus the real photos and
 * documents in ~40 MB parts. Built by the job queue's bulk lane one step per job, each step enqueuing the next;
 * the member is re-checked at every step. Parts live under `exports/` in the private documents bucket for 24 hours.
 */

export const EXPORT_KEEP_HOURS = 24;
export const EXPORTS_PER_DAY = 5;
/** A zip part stops growing here: under Storage's default 50 MB upload and comfortable in a function's memory. */
export const PART_BYTES = 40 * 1024 * 1024;
/** A files step stops starting downloads here, so it ends well inside the tick and the job's lease. */
const STEP_BUDGET_MS = 25_000;
const FILES_PAGE = 200;
export const EXPORT_JOB_KIND = 'data.export';

/** Storage and the clock, injectable for tests; the defaults are the real ones. */
export type ExportDeps = {
  put: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array>;
  /** A listing photo from the public media bucket. */
  photo: (key: string) => Promise<Uint8Array>;
  remove: (key: string) => Promise<boolean>;
  now: () => Date;
  notice?: ReminderDeps['notice'];
};

async function fetchPhoto(key: string): Promise<Uint8Array> {
  const url = mediaUrl(key);
  if (!url) throw new Error('Media storage is not configured');
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Photo not returned (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export const realExportDeps = (notice?: ReminderDeps['notice']): ExportDeps => ({
  put: putExportObject,
  get: downloadDocumentObject,
  photo: fetchPhoto,
  remove: deleteDocumentObject,
  now: () => new Date(),
  ...(notice ? { notice } : {}),
});

// ── The CSV steps ────────────────────────────────────────────────────────────

type CsvStep = {
  file: string;
  /** Owners and admins only (the whole team is not an agent's slice). */
  agencyOnly?: boolean;
  pages: (db: Db, actor: Actor, tz: string) => { headers: readonly string[]; page: (after: string | null) => Promise<Page> };
};

const quick = (dataset: QuickDataset, query: Record<string, unknown> = {}): CsvStep['pages'] => (db, actor, tz) => datasetPages(db, actor, dataset, query, tz);
const author = alias(user, 'export_actor');

export const CSV_STEPS: CsvStep[] = [
  { file: 'customers.csv', pages: quick('contacts', { archived: 'all' }) },
  { file: 'listings.csv', pages: quick('listings') },
  { file: 'leads.csv', pages: quick('leads') },
  { file: 'appointments.csv', pages: quick('appointments') },
  { file: 'deals.csv', pages: quick('deals') },
  { file: 'notes.csv', pages: quick('notes') },
  {
    file: 'activity.csv',
    pages: (db, actor) => ({
      headers: ['contact_name', 'kind', 'by_email', 'detail', 'occurred_at', 'id', 'contact_id'],
      page: async (after) => {
        const where: SQL[] = [eq(activity.agencyId, actor.agencyId as string), sql`${activity.contactId} in (${visibleContactIdsSql(actor)})`, privateActivityVisibleSql(actor)];
        if (after) where.push(gt(activity.id, after));
        const rows = await db
          .select({ id: activity.id, kind: activity.kind, payload: activity.payload, occurredAt: activity.occurredAt, contactId: activity.contactId, contactName: contact.name, by: author.email })
          .from(activity)
          .innerJoin(contact, eq(contact.id, activity.contactId))
          .leftJoin(author, eq(author.id, activity.actorId))
          .where(and(...where))
          .orderBy(asc(activity.id))
          .limit(EXPORT_PAGE);
        return rows.map((r) => ({ id: r.id, cells: line([r.contactName, r.kind, r.by, JSON.stringify(r.payload ?? {}), iso(r.occurredAt), r.id, r.contactId]) }));
      },
    }),
  },
  {
    file: 'sms.csv',
    // The texts screen's rule (ADR 0070): an agent's own number, an owner's every number.
    pages: (db, actor) => ({
      headers: ['direction', 'counterpart', 'our_number', 'number_of', 'contact_name', 'body', 'status', 'error', 'kind', 'sent_by', 'created_at', 'id', 'contact_id'],
      page: async (after) =>
        (await db.execute<Record<string, string | null>>(sql`
          select m.id, m.direction::text, m.counterpart, pn.e164, u.email as number_of, c.name as contact_name, m.body, m.status, m.error, m.kind,
            (select s.email from "user" s where s.id = m.sent_by) as sent_by, ${isoSql(sql`m.created_at`)} as created_at, m.contact_id
          from sms_message m
          join phone_number pn on pn.id = m.phone_number_id
          join "user" u on u.id = pn.user_id
          left join contact c on c.id = m.contact_id
          where m.agency_id = ${actor.agencyId} and ${numberScopeSql(actor, actor.agencyId as string)} ${after ? sql`and m.id > ${after}` : sql``}
          order by m.id limit ${EXPORT_PAGE}`)).map((r) => ({
          id: r.id!,
          cells: line([r.direction, r.counterpart, r.e164, r.number_of, r.contact_name, r.body, r.status, r.error, r.kind, r.sent_by, r.created_at, r.id, r.contact_id]),
        })),
    }),
  },
  {
    file: 'calls.csv',
    // Calls on the agency's numbers, the same rule; a call logged by hand is in activity.csv (`call_logged`).
    pages: (db, actor) => ({
      headers: ['kind', 'status', 'outcome', 'from', 'our_number', 'number_of', 'contact_name', 'handled_at', 'ai_call_back', 'ai_transcript', 'ai_recording_url', 'created_at', 'id', 'contact_id'],
      page: async (after) =>
        (await db.execute<Record<string, string | null>>(sql`
          select pc.id, pc.kind, pc.status, pc.outcome, pc.from_e164, pn.e164, u.email as number_of, c.name as contact_name,
            ${isoSql(sql`pc.handled_at`)} as handled_at, pc.ai_status, pc.ai_transcript, pc.ai_recording_url, ${isoSql(sql`pc.created_at`)} as created_at, pc.contact_id
          from phone_call pc
          join phone_number pn on pn.id = pc.phone_number_id
          join "user" u on u.id = pn.user_id
          left join contact c on c.id = pc.contact_id
          where pc.agency_id = ${actor.agencyId} and ${numberScopeSql(actor, actor.agencyId as string)} ${after ? sql`and pc.id > ${after}` : sql``}
          order by pc.id limit ${EXPORT_PAGE}`)).map((r) => ({
          id: r.id!,
          cells: line([r.kind, r.status, r.outcome, r.from_e164, r.e164, r.number_of, r.contact_name, r.handled_at, r.ai_status, r.ai_transcript, r.ai_recording_url, r.created_at, r.id, r.contact_id]),
        })),
    }),
  },
  {
    file: 'emails.csv',
    // The inbox's rule (`threadScopeFilters`): offers only for whoever may read them.
    pages: (db, actor) => ({
      headers: ['subject', 'direction', 'status', 'from_email', 'from_name', 'to_emails', 'text', 'contact_email', 'sent_by', 'created_at', 'id', 'thread_id', 'lead_id'],
      page: async (after) => {
        const where: SQL[] = threadScopeFilters(db, actor);
        if (after) where.push(gt(mailMessage.id, after));
        const rows = await db
          .select({
            id: mailMessage.id, subject: mailMessage.subject, direction: mailMessage.direction, status: mailMessage.status, fromEmail: mailMessage.fromEmail,
            fromName: mailMessage.fromName, toEmails: mailMessage.toEmails, text: mailMessage.text, contactEmail: mailThread.contactEmail,
            sentBy: author.email, createdAt: mailMessage.createdAt, threadId: mailMessage.threadId, leadId: mailThread.leadId,
          })
          .from(mailMessage)
          .innerJoin(mailThread, eq(mailThread.id, mailMessage.threadId))
          .leftJoin(lead, eq(lead.id, mailThread.leadId))
          .leftJoin(author, eq(author.id, mailMessage.sentBy))
          .where(and(...where))
          .orderBy(asc(mailMessage.id))
          .limit(EXPORT_PAGE);
        return rows.map((r) => ({
          id: r.id,
          cells: line([r.subject, r.direction, r.status, r.fromEmail, r.fromName, (r.toEmails ?? []).join(';'), r.text, r.contactEmail, r.sentBy, iso(r.createdAt), r.id, r.threadId, r.leadId]),
        }));
      },
    }),
  },
  {
    file: 'documents.csv',
    pages: (db, actor) => ({
      headers: ['title', 'kind', 'scope', 'file', 'mime_type', 'size_bytes', 'private', 'contact_id', 'listing_id', 'created_at', 'id'],
      page: async (after) => {
        const rows = await documentPage(db, actor, after, EXPORT_PAGE);
        return rows.map((r) => ({
          id: r.id,
          cells: line([r.title, r.kind, r.scope, documentPath(r), r.mimeType, r.sizeBytes, r.isPrivate ? 'yes' : '', r.contactId, r.listingId, iso(r.createdAt), r.id]),
        }));
      },
    }),
  },
  {
    file: 'photos.csv',
    pages: (db, actor) => ({
      headers: ['listing_id', 'kind', 'file', 'caption', 'main', 'order', 'id'],
      page: async (after) => (await photoPage(db, actor, after, EXPORT_PAGE)).map((r) => ({ id: r.id, cells: line([r.listingId, r.kind, photoPath(r), r.caption, r.isMain ? 'yes' : '', r.sortOrder, r.id]) })),
    }),
  },
  {
    file: 'team.csv',
    agencyOnly: true,
    pages: (db, actor) => ({
      headers: ['name', 'email', 'role', 'status', 'joined_at', 'removed_at', 'user_id'],
      page: async (after) => {
        const where: SQL[] = [eq(membership.agencyId, actor.agencyId as string)];
        if (after) where.push(gt(membership.id, after));
        const rows = await db
          .select({ id: membership.id, userId: membership.userId, role: membership.role, status: membership.status, joinedAt: membership.joinedAt, removedAt: membership.removedAt, name: user.name, email: user.email })
          .from(membership)
          .innerJoin(user, eq(user.id, membership.userId))
          .where(and(...where))
          .orderBy(asc(membership.id))
          .limit(EXPORT_PAGE);
        return rows.map((r) => ({ id: r.id, cells: line([r.name, r.email, r.role, r.status, iso(r.joinedAt), iso(r.removedAt), r.userId]) }));
      },
    }),
  },
];

/** A timestamp as UTC ISO text, in SQL, so a raw select never depends on how the driver parses dates. */
const isoSql = (col: SQL) => sql`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ── The files ────────────────────────────────────────────────────────────────

type PhotoRow = { id: string; listingId: string; kind: string; storageKey: string; caption: string | null; isMain: boolean; sortOrder: number };
type DocumentRow = { id: string; title: string; kind: string; scope: string; storageKey: string; mimeType: string; sizeBytes: number; isPrivate: boolean; contactId: string | null; listingId: string | null; createdAt: Date };

const ext = (key: string, fallback: string) => /\.([a-z0-9]{1,5})$/i.exec(key)?.[1]?.toLowerCase() ?? fallback;
/** A title as a file name: letters, digits, spaces and dashes; no dot or slash, so never a path. */
const safe = (s: string) => s.replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'document';
export const photoPath = (r: Pick<PhotoRow, 'id' | 'listingId' | 'storageKey'>) => `photos/${r.listingId}/${r.id}.${ext(r.storageKey, 'jpg')}`;
export const documentPath = (r: Pick<DocumentRow, 'id' | 'title' | 'storageKey'>) => `documents/${r.id} ${safe(r.title.replace(/\.[a-z0-9]{1,5}$/i, ''))}.${ext(r.storageKey, 'bin')}`;

/** Photos and floorplans of the listings in the member's scope; videos and tours are links, in listings.csv. */
async function photoPage(db: Db, actor: Actor, after: string | null, limit: number): Promise<PhotoRow[]> {
  const where: SQL[] = [...listingScopeFilters(actor), inArray(media.kind, ['photo', 'floorplan'])];
  if (after) where.push(gt(media.id, after));
  return db
    .select({ id: media.id, listingId: media.listingId, kind: media.kind, storageKey: media.storageKey, caption: media.caption, isMain: media.isMain, sortOrder: media.sortOrder })
    .from(media)
    .innerJoin(listing, eq(listing.id, media.listingId))
    .where(and(...where))
    .orderBy(asc(media.id))
    .limit(limit);
}

/** The documents the member may open (`documentScopeFilters`, the one rule every list and download uses). */
async function documentPage(db: Db, actor: Actor, after: string | null, limit: number): Promise<DocumentRow[]> {
  const where: SQL[] = documentScopeFilters(actor);
  if (after) where.push(gt(document.id, after));
  return db
    .select({
      id: document.id, title: document.title, kind: document.kind, scope: document.scope, storageKey: document.storageKey, mimeType: document.mimeType,
      sizeBytes: document.sizeBytes, isPrivate: document.isPrivate, contactId: document.contactId, listingId: document.listingId, createdAt: document.createdAt,
    })
    .from(document)
    .where(and(...where))
    .orderBy(asc(document.id))
    .limit(limit);
}

// ── Steps ────────────────────────────────────────────────────────────────────

const PACK_STEP = CSV_STEPS.length;
const PHOTOS_STEP = PACK_STEP + 1;
const DOCUMENTS_STEP = PACK_STEP + 2;
const FINISH_STEP = PACK_STEP + 3;
export const EXPORT_STEPS = FINISH_STEP + 1;

type ExportRow = typeof exportJob.$inferSelect;
const prefix = (r: Pick<ExportRow, 'agencyId' | 'id'>) => `exports/${r.agencyId}/${r.id}`;

const README = (who: string, when: string, all: boolean, counts: Record<string, number>) =>
  [
    'Your data export',
    '',
    `Prepared for ${who} on ${when}. It holds what ${all ? 'the whole agency holds' : 'you could see in the console'}: the same rows as your own screens.`,
    '',
    'Files (rows):',
    ...Object.entries(counts).map(([f, n]) => `  ${f}: ${n}`),
    '',
    'customers.csv and listings.csv use the import\'s own columns, so either file can be imported again.',
    'photos.csv and documents.csv name each file\'s place in the photos-N.zip and documents-N.zip parts.',
    'Times ending in Z are UTC. Listing dates are on the property\'s own clock; customer dates on the agency\'s.',
    'The files were read one after another, so a record changed while this was prepared may differ between them.',
    '',
    'Not included: passwords and connection keys, AI working data, platform logs, and what belongs to buyers on the',
    'public site (their shortlists and saved searches). Who viewed a listing is not included yet.',
    '',
  ].join('\r\n');

/** One step of one export. Returns the next step and cursor, or null when the export is finished. */
async function runStep(db: Db, row: ExportRow, actor: Actor, deps: ExportDeps): Promise<{ step: number; cursor: string | null } | null> {
  const tz = await agencyTimeZone(db, row.agencyId);
  const all = can(actor, 'contact:read_all', { type: 'contact', agencyId: row.agencyId });
  const objects = [...row.objects];
  const parts = [...row.parts];
  const counts = { ...row.counts };
  const save = (patch: Partial<ExportRow>) =>
    db.update(exportJob).set({ objects, parts, counts, ...patch, updatedAt: deps.now() }).where(and(eq(exportJob.id, row.id), eq(exportJob.step, row.step)));

  if (row.step < PACK_STEP) {
    const s = CSV_STEPS[row.step]!;
    if (!s.agencyOnly || all) {
      const { headers, page } = s.pages(db, actor, tz);
      const chunks = [BOM + line(headers)];
      let after: string | null = null;
      let n = 0;
      for (;;) {
        const got: Page = await page(after);
        chunks.push(...got.map((r) => r.cells));
        n += got.length;
        if (got.length < EXPORT_PAGE) break;
        after = got[got.length - 1]!.id;
      }
      const key = `${prefix(row)}/csv/${s.file}`;
      await deps.put(key, strToU8(chunks.join('')), 'text/csv; charset=utf-8');
      if (!objects.includes(key)) objects.push(key);
      counts[s.file] = n;
    }
    await save({ step: row.step + 1, status: 'building' });
    return { step: row.step + 1, cursor: null };
  }

  if (row.step === PACK_STEP) {
    const csvKeys = objects.filter((k) => k.includes('/csv/'));
    const files: Zippable = {};
    for (const k of csvKeys) files[k.slice(k.lastIndexOf('/') + 1)] = [await deps.get(k), { level: 6 }];
    const [who] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, row.userId)).limit(1);
    files['README.txt'] = strToU8(README(who?.name || who?.email || 'you', iso(deps.now()).slice(0, 10), all, counts));
    const zip = zipSync(files);
    // shortcut: one data.zip; an agency whose CSVs pass ~40 MB compressed needs it split like the file parts.
    const key = `${prefix(row)}/data.zip`;
    await deps.put(key, zip, 'application/zip');
    for (const k of csvKeys) await deps.remove(k);
    const kept = objects.filter((k) => !csvKeys.includes(k));
    objects.length = 0;
    objects.push(...kept, key);
    if (!parts.some((p) => p.key === key)) parts.push({ key, name: 'data.zip', bytes: zip.length });
    await save({ step: PHOTOS_STEP });
    return { step: PHOTOS_STEP, cursor: null };
  }

  if (row.step === PHOTOS_STEP || row.step === DOCUMENTS_STEP) {
    const photos = row.step === PHOTOS_STEP;
    const started = deps.now().getTime();
    const files: Zippable = {};
    let bytes = 0;
    let last = row.cursor;
    let exhausted = false;
    outer: for (;;) {
      const batch: (PhotoRow | DocumentRow)[] = photos ? await photoPage(db, actor, last, FILES_PAGE) : await documentPage(db, actor, last, FILES_PAGE);
      for (const r of batch) {
        if (bytes > 0 && (bytes >= PART_BYTES || deps.now().getTime() - started > STEP_BUDGET_MS)) break outer;
        try {
          const data = photos ? await deps.photo(r.storageKey) : await deps.get(r.storageKey);
          files[photos ? photoPath(r as PhotoRow) : documentPath(r as DocumentRow)] = [data, { level: 0 }];
          bytes += data.length;
        } catch {
          // A file storage no longer has is counted, not fatal: the rest of the export is still theirs.
          counts[photos ? 'photos_missing' : 'documents_missing'] = (counts[photos ? 'photos_missing' : 'documents_missing'] ?? 0) + 1;
        }
        last = r.id;
      }
      if (batch.length < FILES_PAGE) {
        exhausted = true;
        break;
      }
    }
    if (Object.keys(files).length) {
      const name = `${photos ? 'photos' : 'documents'}-${parts.filter((p) => p.name.startsWith(photos ? 'photos-' : 'documents-')).length + 1}.zip`;
      const key = `${prefix(row)}/${name}`;
      const zip = zipSync(files);
      await deps.put(key, zip, 'application/zip');
      if (!objects.includes(key)) objects.push(key);
      if (!parts.some((p) => p.key === key)) parts.push({ key, name, bytes: zip.length });
      counts[photos ? 'photos' : 'documents'] = (counts[photos ? 'photos' : 'documents'] ?? 0) + Object.keys(files).length;
    }
    const next = exhausted ? { step: row.step + 1, cursor: null } : { step: row.step, cursor: last };
    // The same step again with a new cursor: guarded on the cursor too, so a re-run never adds a part twice.
    await db
      .update(exportJob)
      .set({ objects, parts, counts, step: next.step, cursor: next.cursor, updatedAt: deps.now() })
      .where(and(eq(exportJob.id, row.id), eq(exportJob.step, row.step), row.cursor ? eq(exportJob.cursor, row.cursor) : isNull(exportJob.cursor)));
    return next;
  }

  // Finish: ready for 24 hours; the request's audit row gets its count; a bell and an email to the member.
  const now = deps.now();
  await save({ step: FINISH_STEP + 1, status: 'ready', finishedAt: now, expiresAt: new Date(now.getTime() + EXPORT_KEEP_HOURS * 3_600_000) });
  const rows = Object.entries(counts).filter(([k]) => k.endsWith('.csv')).reduce((a, [, n]) => a + n, 0);
  await db
    .update(auditLog)
    .set({ detail: sql`${auditLog.detail} || ${JSON.stringify({ rows, complete: true })}::jsonb` })
    .where(and(eq(auditLog.refId, row.id), eq(auditLog.action, 'data_exported')));
  const href = isAgencyAdminRole(actor.membershipRole) ? '/settings/data' : '/my-data';
  const [told] = await db
    .insert(notification)
    .values({ userId: row.userId, agencyId: row.agencyId, kind: 'data_export_ready', title: 'Your data export is ready', body: `Download it within ${EXPORT_KEEP_HOURS} hours.`, href, dedupeKey: `data_export:${row.id}` })
    .onConflictDoNothing()
    .returning({ id: notification.id });
  const n = deps.notice;
  if (told && n) {
    const [to] = await db.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, row.userId)).limit(1);
    if (to) {
      const base = href === '/my-data' ? n.urls.agentUrl : n.urls.agencyUrl;
      // Network after every write; a failed email leaves the bell, and the page, to tell them.
      await n.mailer.transport
        .send(buildDataExportReadyEmail({ to: { email: to.email, ...(to.name ? { name: to.name } : {}) }, from: n.mailer.sender.from, postalAddress: n.mailer.sender.postalAddress, pageUrl: `${base}${href}`, hours: EXPORT_KEEP_HOURS }))
        .catch((e: unknown) => console.error('[export] ready email failed', e instanceof Error ? e.message : e));
    }
  }
  return null;
}

async function failExport(db: Db, row: ExportRow, message: string, deps: ExportDeps): Promise<void> {
  for (const k of row.objects) await deps.remove(k);
  await db.update(exportJob).set({ status: 'failed', error: message.slice(0, 300), objects: [], parts: [], finishedAt: deps.now(), updatedAt: deps.now() }).where(eq(exportJob.id, row.id));
}

/**
 * The bulk lane's `data.export` handler: one step, then the next step's job. The member is loaded again every
 * step, so a member removed or suspended mid-export stops getting rows. On the job's last failed attempt the
 * export is marked failed and its files deleted.
 */
export function exportJobHandler(deps: ExportDeps): JobHandler {
  return async (db: Db, j: JobRow) => {
    const exportId = (j.payload as { exportId?: string }).exportId;
    if (!exportId) return;
    const [row] = await db.select().from(exportJob).where(eq(exportJob.id, exportId)).limit(1);
    if (!row || (row.status !== 'queued' && row.status !== 'building')) return;
    const { actor } = await memberContext(db, row.userId);
    if (actor.agencyId !== row.agencyId || !can(actor, 'data:export', { type: 'agency', agencyId: row.agencyId })) {
      await failExport(db, row, 'You are no longer a member of this agency', deps);
      return;
    }
    try {
      const next = await runStep(db, row, actor, deps);
      if (next) await enqueueJob(db, { kind: EXPORT_JOB_KIND, lane: 'bulk', agencyId: row.agencyId, payload: { exportId }, dedupeKey: `${exportId}:${next.step}:${next.cursor ?? ''}`, maxAttempts: 3 });
    } catch (err) {
      if (j.attempts >= j.maxAttempts) await failExport(db, row, err instanceof Error ? err.message : 'The export failed', deps);
      throw err;
    }
  };
}

// ── What the console calls ───────────────────────────────────────────────────

export type ExportView = Pick<ExportRow, 'id' | 'status' | 'error' | 'createdAt' | 'finishedAt' | 'expiresAt' | 'counts'> & {
  parts: { name: string; bytes: number }[];
  /** 0–100, from the step reached. */
  progress: number;
};

const toView = (r: ExportRow): ExportView => ({
  id: r.id, status: r.status, error: r.error, createdAt: r.createdAt, finishedAt: r.finishedAt, expiresAt: r.expiresAt, counts: r.counts,
  parts: r.parts.map((p) => ({ name: p.name, bytes: p.bytes })),
  progress: r.status === 'ready' ? 100 : Math.min(99, Math.round((r.step / EXPORT_STEPS) * 100)),
});

/**
 * Ask for a full export: one at a time per member, at most 5 a day. The row, its audit entry and the first job in
 * one transaction, so an export is never asked for without being on record, or recorded without being built.
 */
export async function requestFullExport(db: Db, actor: Actor, now = new Date()): Promise<ExportView> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'data:export', { type: 'agency', agencyId })) throw new ExportError('You do not have permission to download this');
  return db.transaction(async (tx) => {
    // One request at a time per member: a second click while the first is being written waits for it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`export:${actor.userId}`}))`);
    const recent = await tx
      .select()
      .from(exportJob)
      .where(and(eq(exportJob.agencyId, agencyId), eq(exportJob.userId, actor.userId), gte(exportJob.createdAt, new Date(now.getTime() - 86_400_000))))
      .orderBy(desc(exportJob.createdAt));
    const running = recent.find((r) => r.status === 'queued' || r.status === 'building');
    if (running) return toView(running);
    if (recent.length >= EXPORTS_PER_DAY) throw new ExportError(`You can prepare ${EXPORTS_PER_DAY} exports a day. Try again tomorrow.`);
    const [row] = await tx.insert(exportJob).values({ agencyId, userId: actor.userId }).returning();
    const all = can(actor, 'contact:read_all', { type: 'contact', agencyId });
    await recordAudit(tx, { agencyId, actorUserId: actor.userId, action: 'data_exported', refId: row!.id, detail: { dataset: 'all', scope: all ? 'agency' : 'own', filters: [], rows: null } });
    await enqueueJob(tx, { kind: EXPORT_JOB_KIND, lane: 'bulk', agencyId, payload: { exportId: row!.id }, dedupeKey: `${row!.id}:0:`, maxAttempts: 3 });
    return toView(row!);
  });
}

/** The member's own exports, newest first. Never anyone else's: an owner's whole-agency file is theirs alone. */
export async function listMyExports(db: DbOrTx, actor: Actor): Promise<ExportView[]> {
  if (!actor.agencyId) return [];
  const rows = await db
    .select()
    .from(exportJob)
    .where(and(eq(exportJob.agencyId, actor.agencyId), eq(exportJob.userId, actor.userId)))
    .orderBy(desc(exportJob.createdAt))
    .limit(10);
  return rows.map(toView);
}

/** A 60-second link to one part, for the member who asked, while it is kept. Network after the read. */
export async function signExportPart(db: DbOrTx, actor: Actor, exportId: string, name: string, now = new Date()): Promise<string> {
  const gone = new ExportError('That download was not found');
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(exportId) || !can(actor, 'data:export', { type: 'agency', agencyId: actor.agencyId })) throw gone;
  const [row] = await db
    .select()
    .from(exportJob)
    .where(and(eq(exportJob.id, exportId), eq(exportJob.agencyId, actor.agencyId), eq(exportJob.userId, actor.userId)))
    .limit(1);
  const part = row?.parts.find((p) => p.name === name);
  if (!row || row.status !== 'ready' || !row.expiresAt || row.expiresAt <= now || !part) throw gone;
  return signDocumentDownload(part.key, part.name, 60);
}

/** The hourly sweep: exports past their 24 hours lose their files. A file that will not delete is tried next hour. */
export async function expireExports(db: Db, deps: Pick<ExportDeps, 'remove' | 'now'>, limit = 20): Promise<{ expired: number }> {
  const due = await db
    .select()
    .from(exportJob)
    .where(and(eq(exportJob.status, 'ready'), isNotNull(exportJob.expiresAt), lt(exportJob.expiresAt, deps.now())))
    .limit(limit);
  let expired = 0;
  for (const r of due) {
    const left: string[] = [];
    for (const k of r.objects) if (!(await deps.remove(k))) left.push(k);
    await db
      .update(exportJob)
      .set(left.length ? { objects: left, updatedAt: deps.now() } : { status: 'expired', objects: [], parts: [], updatedAt: deps.now() })
      .where(eq(exportJob.id, r.id));
    if (!left.length) expired += 1;
  }
  return { expired };
}
