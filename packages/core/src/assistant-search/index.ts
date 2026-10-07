export * from './embedder';
export { chunkText } from './chunk';
export { pruneSearchEmbeddings, runEmbeddingTick, SEARCH_EMBEDDING_FEATURE, type EmbeddingTickReport } from './indexing';
export { fuse, MAX_SEARCH_RESULTS, searchNotesAndEmails, type SearchDeps, type SearchHit, type SearchInput, type SearchKind } from './search';
