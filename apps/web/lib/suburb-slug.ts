/** The suburb page's path for a suburb (ADR 0080, C5): /suburb/vic/pakenham, /suburb/nsw/bondi-beach. */
export function suburbPath(state: string, suburb: string): string {
  return `/suburb/${state.trim().toLowerCase()}/${encodeURIComponent(suburb.trim().toLowerCase().replace(/\s+/g, '-'))}`;
}
