/**
 * Documents (ADR 0053) for screens and the assistant. The tick — and with it the PDF and Word
 * readers — is `@repo/core/documents/tick`, so a page that lists documents never loads them.
 */
export * from './document-schema';
export {
  DocumentError,
  deleteDocument,
  documentDownloadUrl,
  listDocuments,
  mayUploadDocument,
  prepareDocumentUpload,
  readDocumentPages,
  recordDocument,
  resolveUploadTarget,
  retryDocument,
  MAX_READ_PAGES,
  type DocumentPages,
  type DocumentView,
} from './documents';
export { documentScopeFilters } from './visibility';
export { chunkPages, splitPages, MAX_CHUNKS_PER_DOCUMENT, type PageChunk } from './chunk-pages';
export type { DocumentReader, ExtractVia, TextLayer } from './extract';
export { fuseDocumentHits, searchDocuments, MAX_DOCUMENT_RESULTS, type DocumentHit, type DocumentSearchDeps, type DocumentSearchInput } from './search';
export { documentStorageConfigured, DocumentStorageError } from './storage';
