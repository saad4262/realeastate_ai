/**
 * Shared by the forms and by the actions that validate them.
 *
 * In its own file because `actions.ts` carries `'use server'`, and a server
 * action module may only export async functions — exporting a plain number
 * from it builds fine and then fails at "Collecting page data" with
 * `Failed to collect configuration for /reset`, which names neither the
 * file nor the reason.
 */

/** Short enough not to be theatre, long enough to matter. */
export const MIN_PASSWORD = 8;
