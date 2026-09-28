/**
 * The zones a schedule may be set in — and nothing else in this file.
 *
 * It is a plain array with no imports, deliberately. The list used to live
 * in ./schedule-schema.ts beside its `z.enum`, and a client component that
 * wanted only these ten strings pulled zod and the whole saved-query schema
 * graph into the browser with them: `/chat` went from 121 kB to 138 kB First
 * Load, measured, for a `<select>`.
 *
 * Same lesson as SORT_OPTIONS moving out of search-listings.ts, one layer
 * up: a vocabulary should cost what a vocabulary costs.
 *
 * An IANA zone name, never a UTC offset. "8 PM in Melbourne" is +11 for part
 * of the year and +10 for the rest, so a stored offset is wrong for about
 * five months a year — an alert that silently slides an hour every October
 * is the kind of bug nobody reports and everybody notices.
 *
 * Australia has more zones than states: Broken Hill keeps South Australian
 * time inside New South Wales, and Eucla is on a 45-minute offset. They are
 * here because leaving them out means quietly emailing those people at the
 * wrong hour rather than telling them the zone is unsupported.
 */
export const AU_TIMEZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Perth',
  'Australia/Hobart',
  'Australia/Darwin',
  'Australia/Broken_Hill',
  'Australia/Lord_Howe',
  'Australia/Eucla',
] as const;

export type AuTimezone = (typeof AU_TIMEZONES)[number];

/** "Australia/Broken_Hill" → "Broken Hill". Display only. */
export function timezoneLabel(zone: string): string {
  return zone.split('/')[1]?.replace(/_/g, ' ') ?? zone;
}
