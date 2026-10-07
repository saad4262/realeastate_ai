/**
 * The embedding port (ADR 0031). Core never calls a provider: the real client
 * lives in packages/ai (which meters every call in ai_run), and tests hand in
 * a fake. Null everywhere means "embeddings are off" — full-text still works.
 */

export const EMBEDDING_DIMENSIONS = 1024;

export type EmbedInputType = 'document' | 'query';

/** Who the call is for, so packages/ai can write the ai_run row. */
export type EmbedMeter = {
  /** `search_embedding` (indexing, per agency) or `assistant` (a person's question). */
  feature: string;
  agencyId: string;
  userId?: string;
};

export type Embedder = {
  model: string;
  /** One vector per text, in order, each EMBEDDING_DIMENSIONS long. Throws on any provider failure. */
  embed(texts: readonly string[], inputType: EmbedInputType, meter: EmbedMeter): Promise<number[][]>;
};
