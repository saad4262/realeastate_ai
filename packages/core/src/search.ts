/**
 * Search port — Postgres first; Typesense/OpenSearch can implement later
 * without rewriting callers.
 */
export type SearchQuery = {
  suburb?: string;
  priceFrom?: number;
  priceTo?: number;
  bedrooms?: number;
  channel?: 'sale' | 'rent';
  text?: string;
  near?: { lat: number; lng: number; radiusKm: number };
};

export type SearchHit = {
  listingId: string;
  propertyId: string;
  score: number;
};

export interface SearchPort {
  search(query: SearchQuery): Promise<SearchHit[]>;
}
