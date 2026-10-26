import { documentStorageConfigured, listDocuments, mayUploadDocument, RECORD_KINDS } from '@repo/core/documents';
import { getConsoleDb } from '@/lib/db';
import { loadListingActor } from '@/lib/load-actor';
import { DocumentsPanel } from './documents-panel';

/**
 * A listing's documents (ADR 0053) — the property's contract, building report, strata papers —
 * on its edit page, below the photos. Rendered only after the page has decided the listing is
 * this person's to open. With listing links, because adding one is `listing:edit`'s rule: the
 * agents named on it, and admins.
 */
export async function ListingDocuments({ listingId, userId }: { listingId: string; userId: string }) {
  const db = getConsoleDb();
  const actor = await loadListingActor(userId);
  if (!actor) return null;
  const target = { on: 'listing' as const, listingId };
  const [documents, mayUpload] = await Promise.all([listDocuments(db, actor, target), mayUploadDocument(db, actor, target)]);
  return (
    <DocumentsPanel
      heading="Property documents"
      target={target}
      documents={documents}
      mayUpload={mayUpload}
      kinds={RECORD_KINDS}
      defaultKind="contract"
      allowPrivate
      storageReady={documentStorageConfigured()}
      emptyTitle="No documents on this property yet"
      emptyHint="The contract of sale, building and pest reports, strata papers — kept with the property, and the assistant can answer from them."
      cannotUploadNote="Only the agents on this listing, and admins, add documents to it."
    />
  );
}
