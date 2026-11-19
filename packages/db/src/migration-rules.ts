/**
 * PLATFORM-PLAN 1.13: the rules every migration follows (DEPLOY.md → "Migrations"), as code the tests apply to
 * every file in drizzle/, so a migration that breaks one fails `pnpm test` instead of locking production.
 */

/** Migrations before this one predate the rules; they ran already and are never edited. */
export const RULES_FROM = 104;

const statements = (sqlText: string) =>
  sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);

/** What is wrong with one migration file (empty = it follows the rules). */
export function migrationProblems(sqlText: string): string[] {
  const out: string[] = [];
  const all = statements(sqlText);
  if (!/^SET LOCAL lock_timeout = '1s';?$/i.test(all[0] ?? '')) out.push(`the first statement must be SET LOCAL lock_timeout = '1s' (a lock waits at most 1 s)`);
  for (const s of all) {
    if (/\bCONCURRENTLY\b/i.test(s)) out.push(`CONCURRENTLY cannot run inside the migration's transaction; use db:concurrent-indexes: ${s.slice(0, 80)}`);
    else if (/^CREATE (UNIQUE )?INDEX\b/i.test(s) && !/^CREATE (UNIQUE )?INDEX IF NOT EXISTS "/i.test(s)) out.push(`an index must be CREATE INDEX IF NOT EXISTS "<name>", so a concurrent build first makes it a no-op: ${s.slice(0, 80)}`);
  }
  return out;
}

/** A migration's indexes, rewritten to build CONCURRENTLY outside a transaction (run before the migration). */
export function concurrentIndexes(sqlText: string): { name: string; sql: string }[] {
  return statements(sqlText)
    .filter((s) => /^CREATE (UNIQUE )?INDEX\b/i.test(s))
    .map((s) => {
      const m = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS "([^"]+)"/i.exec(s);
      if (!m) throw new Error(`Not CREATE INDEX IF NOT EXISTS "<name>": ${s.slice(0, 80)}`);
      return { name: m[2]!, sql: s.replace(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/i, `CREATE ${m[1] ?? ''}INDEX CONCURRENTLY IF NOT EXISTS`).replace(/;\s*$/, '') };
    });
}
