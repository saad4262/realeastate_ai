import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';

/** How long one figure's statement may run (ADR 0027, ADR 0036 I5). */
export const READ_TIMEOUT = '3s';

const DONE = Symbol('read done');

/**
 * Run figure reads with a statement timeout and the transaction read-only
 * (ADR 0036 P6): a transaction of their own — a savepoint when `db` is
 * already one — whose first statement sets both with `set_config(…, true)`,
 * i.e. SET LOCAL. It is then ROLLED BACK, never committed: a read has nothing
 * to keep, and the rollback is what undoes both settings, so a caller's own
 * transaction (a smoke fixture, an assistant turn) carries on unchanged and
 * the transaction-mode pooler never hands them to another request.
 *
 * One more statement per call. A statement that runs over is cancelled by
 * Postgres (`57014`) and `isReadTimeout` says so.
 */
export async function withReadTimeout<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  let out: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${READ_TIMEOUT}, true), set_config('transaction_read_only', 'on', true)`);
      out = { value: await fn(tx) };
      throw DONE;
    });
  } catch (err) {
    if (err !== DONE) throw err;
  }
  return out!.value;
}

/** Postgres cancelled the statement for running past `statement_timeout`. */
export function isReadTimeout(err: unknown): boolean {
  const code = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined);
  return code(err) === '57014' || code((err as { cause?: unknown } | null)?.cause) === '57014';
}
