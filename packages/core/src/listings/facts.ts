import { sql, type SQL } from 'drizzle-orm';
import { listing, property } from '@repo/db';

/**
 * ADR 0075: a listing's facts are what ITS ad states; the shared address (`property`) supplies only what
 * the ad leaves blank. Every read of bedrooms, bathrooms, type… for a listing goes through here, so two
 * agencies listing one home each show their own ad, and no read can forget the fallback.
 */

/** For queries over the `listing` and `property` tables by their own names (drizzle's builder). */
export const adFacts = {
  propertyType: sql<string | null>`coalesce(${listing.propertyType}, ${property.propertyType})`,
  bedrooms: sql<number | null>`coalesce(${listing.bedrooms}, ${property.bedrooms})`,
  bathrooms: sql<string | null>`coalesce(${listing.bathrooms}, ${property.bathrooms})`,
  carSpaces: sql<number | null>`coalesce(${listing.carSpaces}, ${property.carSpaces})`,
  landAreaSqm: sql<string | null>`coalesce(${listing.landAreaSqm}, ${property.landAreaSqm})`,
  buildingAreaSqm: sql<string | null>`coalesce(${listing.buildingAreaSqm}, ${property.buildingAreaSqm})`,
  yearBuilt: sql<number | null>`coalesce(${listing.yearBuilt}, ${property.yearBuilt})`,
} as const;

export const FACT_COLUMNS = ['property_type', 'bedrooms', 'bathrooms', 'car_spaces', 'land_area_sqm', 'building_area_sqm', 'year_built'] as const;
export type FactColumn = (typeof FACT_COLUMNS)[number];

/**
 * For raw SQL: `coalesce(<l>.<col>, <p>.<col>)`, the listing's alias first. Aliases are fixed strings
 * from the calling module, never input.
 */
export function factSql(col: FactColumn, l: string, p: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(l) || !/^[a-z_][a-z0-9_]*$/.test(p)) throw new Error(`bad alias ${l}/${p}`);
  return sql.raw(`coalesce(${l}.${col}, ${p}.${col})`);
}
